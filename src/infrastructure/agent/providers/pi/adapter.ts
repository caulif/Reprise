import { createPiAgent, toPiTool } from "./tool-adapter.js";
import { toPiUserPrompt } from "./message-mapper.js";
import { isAssistantMessageEnd } from "./event-mapper.js";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { setTimeout as delay } from "node:timers/promises";
import { classifyAgentFailure } from "../../failure.js";
import { contentText, isContextOverflow, type Api, type Model } from "@earendil-works/pi-ai";
import { visibleAssistantText } from "../../assistant-visible.js";
import type { ProviderAdapter, ProviderSession } from "../../types.js";
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
import { piRequestUsage } from './request-usage.js';
import { invocationToolExposure } from './tool-exposure.js';
import { invocationYieldDeadline, observePiFailure } from './yield-deadline.js';
import { piToolRejections } from './tool-rejections.js';

export type PiModels = Pick<Models, "getProviders" | "getModels" | "getModel" | "getAuth" | "completeSimple" | "streamSimple">;

type TurnYieldState = { policy: Parameters<ProviderSession['append']>[0]['yieldAfterTurn']; reason: string | undefined; failure: Error | undefined };
function turnYieldPolicy(usage: { flush(): Promise<void> }, state: TurnYieldState): NonNullable<ConstructorParameters<typeof Agent>[0]['shouldStopAfterTurn']> {
  return async ({ message }) => {
    // Pi requires this hook not to throw. Surface audit/policy failures after its normal agent_end.
    try {
      await usage.flush();
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return false;
      if (message.stopReason === 'length' && state.policy) { state.reason = 'output_limit'; return true; }
      state.reason = await state.policy?.();
      return state.reason !== undefined;
    } catch (error) {
      state.failure = error instanceof Error ? error : new Error('Provider turn yield policy failed.');
      return true;
    }
  };
}

function yieldReasonAfterPrompt(agent: Agent, state: TurnYieldState, signal: AbortSignal): string | undefined {
  if (state.failure) throw state.failure;
  if (signal.aborted) throw abortError();
  const ended = lastAssistant(agent.state.messages);
  return ended?.stopReason === 'error' || ended?.stopReason === 'aborted' ? undefined : state.reason;
}

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
    let deadline: ReturnType<typeof invocationYieldDeadline> | undefined;
    const recordFailure = (error: unknown) => deadline?.recordFailure(error);
    const usage = piRequestUsage(this.#models, input, recordFailure, error => deadline?.recordProviderFailure(error));
    const models = usage.models;
    const inputEffort = this.#config.effort;
    let effort = inputEffort;
    let active = true;
    let toolsEnabled = true;
    const registeredTools = input.tools.map(tool => toPiTool(tool, recordFailure, error => deadline?.recordToolFailure(error)));
    const rejections = piToolRejections(input, recordFailure);
    const turnYield: TurnYieldState = { policy: undefined, reason: undefined, failure: undefined };
    const agent = createPiAgent({
      sessionId: input.sessionId,
      streamFn: usage.stream,
      convertToLlm,
      beforeToolCall: async ({ toolCall }) => {
        rejections.before(toolCall.id);
        if (!active) return { block: true, reason: "Agent session is no longer active.", terminate: true };
        if (!toolsEnabled) return { block: true, reason: "Tools are disabled for this invocation.", terminate: true };
        if (!exposure.permits(toolCall.name)) return { block: true, reason: 'Tool is unavailable in this invocation.', terminate: true };
        await usage.flush();
        await observePiFailure(() => input.onBeforeToolCall?.({ tool: toolCall.name }), recordFailure);
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        if (!Array.isArray(result.content)) throw new Error("Pi tool result content must be an array.");
        await observePiFailure(() => input.onAfterToolCall?.({
          tool: toolCall.name,
          isError,
          contentTypes: result.content.map((block) => block.type),
          byteLength: Buffer.byteLength(JSON.stringify(result.content)),
          contentDigest: sha256(JSON.stringify(result.content)),
        }), recordFailure);
        return undefined;
      },
      maxRetryDelayMs: 8_000,
      shouldStopAfterTurn: turnYieldPolicy(usage, turnYield),
      transformContext: async (messages, signal) => {
        const combined = deadline ? AbortSignal.any([...(signal ? [signal] : []), deadline.signal]) : signal;
        combined?.throwIfAborted();
        const fixedTokens = Math.ceil(Buffer.byteLength(input.systemPrompt + JSON.stringify(agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown })))) / 3);
        const availableWindow = contextWindowOf(model) - fixedTokens - Math.max(1_024, model.maxTokens);
        await compactInto(messages, agent, model, models, effort, combined, input.compactionInstructions, input.onContextCompact, availableWindow).catch(error => { recordFailure(error); throw error; });
        combined?.throwIfAborted();
        return messages;
      },
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: this.#config.effort,
        tools: registeredTools,
      },
    });
    const exposure = invocationToolExposure(agent, registeredTools);
    rejections.subscribe(agent);
    subscribeVisibleAssistant(agent, input.onAssistantVisible, recordFailure);
    let appendFailure: unknown;
    return {
      inputCapabilities: [...model.input],
      async append(request) {
        const { signal, allowedToolNames, yieldDeadline } = request;
        if (signal.aborted) throw abortError();
        exposure.enter(allowedToolNames);
        effort = request.reasoningEffortCeiling === 'low' && inputEffort !== 'minimal' ? 'low' : inputEffort;
        agent.state.thinkingLevel = effort;
        deadline = invocationYieldDeadline(agent, signal, yieldDeadline);
        appendFailure = undefined;
        try {
          try {
            return await appendPiPrompt({ agent, model, models, effort, request, deadline, turnYield, usage, input });
          } finally {
            try { try { await agent.waitForIdle(); } finally { await usage.flush(); } }
            finally { deadline.dispose(); deadline = undefined; turnYield.policy = undefined; exposure.restore(); effort = inputEffort; agent.state.thinkingLevel = inputEffort; }
          }
        } catch (error) {
          appendFailure = error;
          throw error;
        }
      },
      cancel(): void {
        active = false;
        agent.abort();
      },
      waitForIdle: async () => { try { await agent.waitForIdle(); } finally { await usage.flush({ failure: appendFailure }); } },
      setToolsEnabled(enabled: boolean): void { toolsEnabled = enabled; },
    };
  }
}

async function appendPiPrompt(args: {
  agent: Agent; model: Model<Api>; models: PiModels; effort: HarnessModelConfig['effort'];
  request: Parameters<ProviderSession['append']>[0]; deadline: ReturnType<typeof invocationYieldDeadline>;
  turnYield: TurnYieldState; usage: ReturnType<typeof piRequestUsage>; input: Parameters<ProviderAdapter['createSession']>[0];
}): ReturnType<ProviderSession['append']> {
  const { agent, model, models, effort, request, deadline, turnYield, usage, input } = args;
  turnYield.policy = request.yieldAfterTurn;
  turnYield.reason = undefined;
  turnYield.failure = undefined;
  const localYield = () => {
    if (turnYield.failure) throw turnYield.failure;
    const reason = deadline.reason();
    return reason === undefined ? undefined : { status: 'yielded' as const, reason };
  };
  try {
    const initial = localYield();
    if (initial) return initial;
    const prompt = toPiUserPrompt(request.content, model.input.includes('image') ? request.images : undefined);
    await agent.prompt(prompt.content, prompt.images);
    await usage.flush();
    const interrupted = localYield();
    if (interrupted) return interrupted;
    deadline.assertCanRecover();
    const yieldedReason = yieldReasonAfterPrompt(agent, turnYield, deadline.signal);
    if (yieldedReason !== undefined) { deadline.assertCanYield(); return { status: 'yielded', reason: yieldedReason }; }
    await recoverAgentResponse(agent, model, models, effort, deadline.signal, input.compactionInstructions, input.onContextCompact, input.onRetry);
    await usage.flush();
    const recoveredMessage = lastAssistant(agent.state.messages);
    if (recoveredMessage?.stopReason === 'stop' || (recoveredMessage?.stopReason === 'toolUse'
      && turnYield.reason !== undefined && !turnYield.failure && !deadline.signal.aborted)) deadline.providerRecovered();
    const afterRecovery = localYield();
    if (afterRecovery) return afterRecovery;
    deadline.assertCanComplete();
    const recoveredYield = yieldReasonAfterPrompt(agent, turnYield, deadline.signal);
    if (recoveredYield !== undefined) { deadline.assertCanYield(); return { status: 'yielded', reason: recoveredYield }; }
    const message = lastAssistant(agent.state.messages);
    if (!message || message.role !== 'assistant') throw new Error('Pi Agent session ended without an assistant message.');
    if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Pi Agent session stopped: ${message.stopReason}.`);
    return contentText(message.content);
  } catch (error) {
    deadline.recordFailure(error);
    await agent.waitForIdle();
    await usage.flush();
    const interrupted = localYield();
    if (interrupted) return interrupted;
    throw error;
  }
}

function subscribeVisibleAssistant(agent: Agent, onVisible: Parameters<ProviderAdapter['createSession']>[0]['onAssistantVisible'], recordFailure: (error: unknown) => void): void {
  let turn = 0;
  agent.subscribe(async event => {
    const payload = 'message' in event && event.message ? { type: event.type, message: event.message } : { type: event.type };
    if (!isAssistantMessageEnd(payload)) return;
    const message = payload.message as { role?: string; content?: readonly { type?: string; text?: string }[] };
    const text = visibleAssistantText(message.content);
    if (text) await observePiFailure(() => onVisible?.({ text, turn: ++turn }), recordFailure);
  });
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
  const pruned = prunePiMessagesForBudget(live);
  if (pruned.changed) {
    agent.state.messages = live;
    await onContextCompact?.({ summary: pruned.summary, tokensBefore: estimatedMessageTokens(live), retainedCount: live.length, reason: "prune", retainedTail: [...live] });
  }
  if (!needsPiCompaction(live, availableWindow)) return pruned.changed;
  const compacted = await compactPiMessages({ messages: live, models, model, thinkingLevel, ...(customInstructions ? { customInstructions } : {}), ...(signal ? { signal } : {}) });
  if (!compacted) {
    const shrink = prunePiMessagesForBudget(live);
    agent.state.messages = live;
    await onContextCompact?.({
      summary: shrink.changed ? `Host prune after empty Pi compaction. ${shrink.summary}` : "Host prune after empty Pi compaction",
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




