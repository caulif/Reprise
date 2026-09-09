import { createPiAgent, toPiTool } from "./tool-adapter.js";
import { toPiUserPrompt } from "./message-mapper.js";
import { isAssistantMessageEnd } from "./event-mapper.js";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { setTimeout as delay } from "node:timers/promises";
import { classifyAgentFailure } from "../../failure.js";
import { contentText, isContextOverflow, type Api, type Model } from "@earendil-works/pi-ai";
import { visibleAssistantText } from "../../assistant-visible.js";
import type { AgentToolDefinition, ProviderAdapter, ProviderSession } from "../../types.js";
import {
  compactPiMessages,
  contextWindowOf,
  convertToLlm,
  estimatedMessageTokens,
  needsPiCompaction,
  prunePiMessagesForBudget,
} from "../../compaction.js";
import type { Models } from "@earendil-works/pi-ai";
import { sha256 } from "../../../../core/identity.js";
import type { HarnessModelConfig } from "../../../harness-model-config.js";

export type PiModels = Pick<Models, "getProviders" | "getModels" | "getModel" | "getAuth" | "completeSimple" | "streamSimple">;

export class PiProviderAdapter implements ProviderAdapter {
  readonly #models: PiModels;
  readonly #config: HarnessModelConfig;
  readonly #model: Model<Api>;

  constructor(input: {
    models: PiModels;
    config: HarnessModelConfig;
    model: Model<Api>;
  }) {
    this.#models = input.models;
    this.#config = input.config;
    this.#model = input.model;
  }

  createSession(input: Parameters<ProviderAdapter["createSession"]>[0]): ProviderSession {
    const model = this.#model;
    const models = this.#models;
    const effort = this.#config.effort;
    let active = true;
    const fixedTokens = Math.ceil(Buffer.byteLength(input.systemPrompt + JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))) / 3);
    const availableWindow = contextWindowOf(model) - fixedTokens - Math.max(1_024, model.maxTokens);
    const agent = createPiAgent({
      sessionId: input.sessionId,
      streamFn: async (streamModel, context, options) => {
        const notify = input.onModelRequest;
        if (notify) {
          const serialized = JSON.stringify({ model: streamModel, context });
          const modelId = "id" in streamModel ? String(streamModel.id) : String(streamModel);
          const messageCount = "messages" in context && Array.isArray(context.messages) ? context.messages.length : 0;
          await notify({ model: modelId, digest: sha256(serialized), messageCount });
        }
        return this.#models.streamSimple(streamModel, context, {
          ...options,
          maxRetries: 0,
          maxRetryDelayMs: 8_000,
        });
      },
      convertToLlm,
      beforeToolCall: async ({ toolCall }) => {
        if (!active) return { block: true, reason: "Agent session is no longer active.", terminate: true };
        await input.onBeforeToolCall?.({ tool: toolCall.name });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        if (!Array.isArray(result.content)) throw new Error("Pi tool result content must be an array.");
        await input.onAfterToolCall?.({
          tool: toolCall.name,
          isError,
          contentTypes: result.content.map((block) => block.type),
          byteLength: Buffer.byteLength(JSON.stringify(result.content)),
          contentDigest: sha256(JSON.stringify(result.content)),
        });
        return undefined;
      },
      maxRetryDelayMs: 8_000,
      transformContext: async (messages, signal) => {
        await compactInto(messages, agent, model, models, effort, signal, input.compactionInstructions, input.onContextCompact, availableWindow);
        return messages;
      },
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: this.#config.effort,
        tools: input.tools.map((tool: AgentToolDefinition) => toPiTool(tool)),
      },
    });
    let visibleTurn = 0;
    agent.subscribe(async (event) => {
      const payload = "message" in event && event.message
        ? { type: event.type, message: event.message }
        : { type: event.type };
      if (!isAssistantMessageEnd(payload)) return;
      const message = payload.message as { role?: string; content?: readonly { type?: string; text?: string }[] };
      const text = visibleAssistantText(message.content);
      if (!text) return;
      visibleTurn += 1;
      await input.onAssistantVisible?.({ text, turn: visibleTurn });
    });
    return {
      inputCapabilities: [...model.input],
      async append({ content, images, signal }): Promise<string> {
        if (signal.aborted) throw abortError();
        const abort = () => agent.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const prompt = toPiUserPrompt(content, images);
          await agent.prompt(prompt.content, prompt.images);
          await recoverAgentResponse(agent, model, models, effort, signal, input.compactionInstructions, input.onContextCompact, input.onRetry);
          const message = lastAssistant(agent.state.messages);
          if (!message || message.role !== "assistant") throw new Error("Pi Agent session ended without an assistant message.");
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            throw new Error(message.errorMessage ?? `Pi Agent session stopped: ${message.stopReason}.`);
          }
          return contentText(message.content);
        } finally {
          signal.removeEventListener("abort", abort);
          await agent.waitForIdle();
        }
      },
      cancel(): void {
        active = false;
        agent.abort();
      },
      waitForIdle: () => agent.waitForIdle(),
    };
  }
}

async function compactInto(
  live: AgentMessage[],
  agent: Agent,
  model: Model<Api>,
  models: PiModels,
  thinkingLevel: HarnessModelConfig["effort"],
  signal: AbortSignal | undefined,
  customInstructions: string | undefined,
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>) | undefined,
  availableWindow: number,
): Promise<boolean> {
  if (availableWindow <= 0) throw new Error("Context budget: system prompt, tools and output reserve exceed the model window.");
  const pruned = prunePiMessagesForBudget(live, false);
  if (pruned.changed) {
    agent.state.messages = live;
    await onContextCompact?.({ summary: pruned.summary, tokensBefore: estimatedMessageTokens(live), retainedCount: live.length, reason: "prune", retainedTail: [...live] });
  }
  if (!needsPiCompaction(live, availableWindow)) return pruned.changed;
  const compacted = await compactPiMessages({ messages: live, models, model, thinkingLevel, ...(customInstructions ? { customInstructions } : {}), ...(signal ? { signal } : {}) });
  if (!compacted) {
    const shrink = prunePiMessagesForBudget(live, true);
    agent.state.messages = live;
    await onContextCompact?.({
      summary: shrink.changed ? `Host working-set shrink after empty Pi history. ${shrink.summary}` : "Host working-set shrink after empty Pi history.",
      tokensBefore: estimatedMessageTokens(live),
      retainedCount: live.length,
      reason: "shrink",
      retainedTail: [...live],
    });
    if (needsPiCompaction(live, availableWindow)) throw new Error("Context budget: working set still exceeds the available window.");
    return true;
  }
  if (needsPiCompaction(compacted.messages, availableWindow)) throw new Error("Context budget: retained tail still exceeds the available window.");
  live.splice(0, live.length, ...compacted.messages);
  agent.state.messages = compacted.messages;
  await onContextCompact?.(compacted.audit);
  return true;
}

async function recoverAgentResponse(
  agent: Agent,
  model: Model<Api>,
  models: PiModels,
  thinkingLevel: HarnessModelConfig["effort"],
  signal: AbortSignal,
  customInstructions: string | undefined,
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>) | undefined,
  onRetry: ((payload: { attempt: number; kind: string; delayMs: number }) => Promise<void>) | undefined,
): Promise<void> {
  let overflowRecovered = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    signal.throwIfAborted();
    const message = lastAssistant(agent.state.messages);
    if (!message || message.role !== "assistant" || message.stopReason !== "error") return;
    const overflow = isContextOverflow(message, contextWindowOf(model));
    const kind = classifyAgentFailure(new Error(message.errorMessage ?? "Agent response failed."));
    if (!overflow && kind !== "transient_upstream" && kind !== "transient_network") return;
    if (attempt === 3 || (overflow && overflowRecovered)) return;
    const tail = agent.state.messages.at(-1);
    if (tail !== message) throw new Error("Agent failed outside the latest response; cannot safely continue.");
    agent.state.messages.pop();
    if (overflow) {
      const before = JSON.stringify(agent.state.messages).length;
      const compacted = await compactPiMessages({ messages: agent.state.messages, models, model, thinkingLevel, ...(customInstructions ? { customInstructions } : {}), signal });
      if (!compacted || JSON.stringify(compacted.messages).length >= before) throw new Error("Context budget: overflow recovery could not reduce the input.");
      agent.state.messages = compacted.messages;
      await onContextCompact?.(compacted.audit);
      overflowRecovered = true;
    }
    const delayMs = overflow ? 0 : 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    await onRetry?.({ attempt: attempt + 1, kind: overflow ? "context_overflow" : kind, delayMs });
    await delay(delayMs, undefined, { signal });
    await agent.continue();
  }
}

function lastAssistant(messages: readonly AgentMessage[]) {
  return [...messages].reverse().find((entry) => entry.role === "assistant");
}

function abortError(): Error {
  const error = new Error("Pi model request was aborted.");
  error.name = "AbortError";
  return error;
}

