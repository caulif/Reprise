import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyAgentFailure } from './agent-failure.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { contentText, createProvider, isContextOverflow, type Api, type Model, type Models, type MutableModels } from '@earendil-works/pi-ai';
import { visibleAssistantText } from './assistant-visible.js';
import type { AgentToolDefinition, PiTextCaller, PiTextSession } from './pi-agent-host.js';
import {
  compactPiMessages,
  contextWindowOf,
  convertToLlm,
  estimatedMessageTokens,
  needsPiCompaction,
  prunePiMessagesForBudget,
} from './pi-compaction.js';
import { environmentNameForKeyRef, type HarnessModelConfig } from './harness-model-config.js';
import { sha256 } from '../core/identity.js';

export type PiModels = Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
type MutablePiModels = PiModels & Pick<MutableModels, 'setProvider'>;

export type PiProviderOption = { readonly id: string; readonly name: string };
export type PiModelOption = { readonly id: string; readonly name: string };

const WRITE_TOOLS = new Set(['edit', 'write', 'shell_exec']);
const STREAM_RETRIES = 3;
const STREAM_RETRY_DELAY_MS = 8_000;
/** Outer budget for the billed probe, including Pi retries. Must exceed one slow gateway round-trip. */
export const PI_PROBE_TIMEOUT_MS = 180_000;

/** Builds Pi's native custom-provider path. The key comes from the local config file, or env:NAME. */
export function modelsForConfig(config: HarnessModelConfig, models: MutablePiModels = builtinModels()): MutablePiModels {
  if (config.schemaVersion !== 2 || config.provider.kind !== 'openai-compatible') return models;
  const fileKey = config.apiKey;
  const keyRef = config.keyRef;
  const baseUrl = config.baseUrl;
  if (!baseUrl || (!fileKey && !keyRef)) return models;
  const overlay = windowOverlay(config);
  const api = config.api === 'openai-responses' ? 'openai-responses' : 'openai-completions';
  models.setProvider(createProvider({
    id: config.provider.id,
    name: config.provider.id,
    baseUrl,
    auth: {
      apiKey: {
        name: 'Reprise API key',
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          if (fileKey) return { auth: { apiKey: fileKey }, source: 'harness-model.json' };
          if (!keyRef) return undefined;
          const environmentName = environmentNameForKeyRef(keyRef);
          const apiKey = await ctx.env(environmentName);
          signal.throwIfAborted();
          return apiKey ? { auth: { apiKey }, source: environmentName } : undefined;
        },
      },
    },
    models: [{
      id: config.modelId, name: config.modelId, api, provider: config.provider.id, baseUrl,
      reasoning: config.reasoning === true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: overlay.contextWindow ?? 128_000, maxTokens: overlay.maxTokens ?? 16_384,
      ...(config.compat ? { compat: config.compat } : {}),
    }],
    api: api === 'openai-responses' ? openAIResponsesApi() : openAICompletionsApi(),
  }));
  return models;
}

/**
 * Pi adapter for internal Agent sessions. `completeSimple` is intentionally
 * retained only for the connection probe and Pi compaction summaries; product agents run through Agent.
 */
export class PiModelCaller implements PiTextCaller {
  readonly #models: PiModels;
  readonly #config: HarnessModelConfig;

  constructor(config: HarnessModelConfig, models?: PiModels) {
    this.#config = config;
    this.#models = models ?? modelsForConfig(config);
  }

  providers(): readonly PiProviderOption[] {
    return this.#models.getProviders().map((provider) => ({ id: provider.id, name: provider.name })).sort((left, right) => left.name.localeCompare(right.name));
  }

  models(providerId = this.#config.providerId): readonly PiModelOption[] {
    return this.#models.getModels(providerId).filter((model) => model.input.includes('text')).map((model) => ({ id: model.id, name: model.name })).sort((left, right) => left.name.localeCompare(right.name));
  }

  async hasAuth(): Promise<boolean> {
    try {
      return Boolean(await this.#models.getAuth(this.#model()));
    } catch {
      return false;
    }
  }

  async validate(signal?: AbortSignal): Promise<{ source?: string }> {
    signal?.throwIfAborted();
    const model = this.#model();
    const auth = await this.#models.getAuth(model);
    signal?.throwIfAborted();
    if (!auth) {
      throw new Error(isCatalog(this.#config)
        ? `Pi has no usable credential for provider ${this.#config.providerId}. Run pi /login for this provider, then test the connection.`
        : `Pi has no usable credential for provider ${this.#config.providerId}. Add apiKey to harness-model.json, or set the referenced environment variable.`);
    }
    const relayReasoning = isCatalog(this.#config) || (this.#config.schemaVersion === 2 && this.#config.reasoning === true);
    const probeSignal = AbortSignal.any([AbortSignal.timeout(PI_PROBE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      probeSignal.throwIfAborted();
      let response: Awaited<ReturnType<PiModels['completeSimple']>>;
      try {
        response = await this.#models.completeSimple(model, {
          systemPrompt: 'Reprise connection check. Reply with exactly OK.',
          messages: [{ role: 'user', content: 'Reply with exactly OK.', timestamp: Date.now() }],
        }, {
          maxRetries: STREAM_RETRIES,
          maxRetryDelayMs: STREAM_RETRY_DELAY_MS,
          signal: probeSignal,
          ...(relayReasoning ? { reasoning: this.#config.effort } : {}),
        });
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(hintThinking(this.#config, error instanceof Error ? error.message : String(error)), { cause: error });
      }
      signal?.throwIfAborted();
      if (response.stopReason !== 'error' && response.stopReason !== 'aborted' && contentText(response.content).trim()) {
        return auth.source === undefined ? {} : { source: auth.source };
      }
      lastError = new Error(hintThinking(this.#config, response.errorMessage ?? `Pi model connection check stopped: ${response.stopReason}.`));
      const kind = classifyAgentFailure(lastError);
      const retryable = kind === 'transient_upstream' || kind === 'transient_network' || kind === 'timeout';
      if (attempt === 3 || !retryable) throw lastError;
      await delay(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), undefined, { signal: probeSignal });
    }
    throw lastError ?? new Error('Pi model connection check failed.');
  }

  createSession(input: {
    sessionId: string;
    systemPrompt: string;
    tools: readonly AgentToolDefinition[];
    compactionInstructions?: string;
    onContextCompact?: (payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>;
    onRetry?: (payload: { attempt: number; kind: string; delayMs: number }) => Promise<void>;
    onAssistantVisible?: (payload: { text: string; turn: number }) => Promise<void>;
    onBeforeToolCall?: (payload: { tool: string }) => Promise<void>;
    onAfterToolCall?: (payload: { tool: string; isError: boolean; contentTypes: readonly string[]; byteLength: number; contentDigest: string }) => Promise<void>;
    onModelRequest?: (payload: { model: string; digest: string; messageCount: number }) => Promise<void>;
  }): PiTextSession {
    const model = this.#model();
    const models = this.#models;
    const effort = this.#config.effort;
    let active = true;
    const fixedTokens = Math.ceil(Buffer.byteLength(input.systemPrompt + JSON.stringify(input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))) / 3);
    const availableWindow = contextWindowOf(model) - fixedTokens - Math.max(1_024, model.maxTokens);
    const agent = new Agent({
      sessionId: input.sessionId,
      streamFn: (streamModel, context, options) => {
        const notify = input.onModelRequest;
        if (notify) {
          const serialized = JSON.stringify({ model: streamModel, context });
          const modelId = "id" in streamModel ? String(streamModel.id) : String(streamModel);
          const messageCount = "messages" in context && Array.isArray(context.messages) ? context.messages.length : 0;
          void notify({ model: modelId, digest: sha256(serialized), messageCount });
        }
        return this.#models.streamSimple(streamModel, context, {
          ...options,
          maxRetries: 0,
          maxRetryDelayMs: STREAM_RETRY_DELAY_MS,
        });
      },
      convertToLlm,
      toolExecution: 'parallel',
      beforeToolCall: async ({ toolCall }) => {
        if (!active) return { block: true, reason: 'Agent session is no longer active.', terminate: true };
        await input.onBeforeToolCall?.({ tool: toolCall.name });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        // Keep Pi's finalized result intact. Host policy and audit live in the
        // shared tool wrapper; this hook is the common post-execution boundary.
        if (!Array.isArray(result.content)) throw new Error('Pi tool result content must be an array.');
        await input.onAfterToolCall?.({
          tool: toolCall.name,
          isError,
          contentTypes: result.content.map((block) => block.type),
          byteLength: Buffer.byteLength(JSON.stringify(result.content)),
          contentDigest: sha256(JSON.stringify(result.content)),
        });
        return undefined;
      },
      maxRetryDelayMs: STREAM_RETRY_DELAY_MS,
      transformContext: async (messages, signal) => {
        await compactInto(messages, agent, model, models, effort, signal, input.compactionInstructions, input.onContextCompact, availableWindow);
        return messages;
      },
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: this.#config.effort,
        tools: input.tools.map(toPiTool),
      },
    });
    let visibleTurn = 0;
    agent.subscribe(async (event) => {
      if (event.type !== 'message_end') return;
      const message = event.message as { role?: string; content?: readonly { type?: string; text?: string }[] };
      if (message.role !== 'assistant') return;
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
        signal.addEventListener('abort', abort, { once: true });
        try {
          await agent.prompt(content, images ? [...images] : undefined);
          await recoverAgentResponse(agent, model, models, effort, signal, input.compactionInstructions, input.onContextCompact, input.onRetry);
          const message = lastAssistant(agent.state.messages);
          if (!message || message.role !== 'assistant') throw new Error('Pi Agent session ended without an assistant message.');
          if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Pi Agent session stopped: ${message.stopReason}.`);
          return contentText(message.content);
        } finally {
          signal.removeEventListener('abort', abort);
          await agent.waitForIdle();
        }
      },
      cancel(): void { active = false; agent.abort(); },
    };
  }

  #model() {
    const model = this.#models.getModel(this.#config.providerId, this.#config.modelId);
    if (!model) throw new Error(`Pi provider ${this.#config.providerId} does not expose model ${this.#config.modelId}.`);
    if (!model.input.includes('text')) throw new Error(`Pi model ${this.#config.modelId} does not accept text input.`);
    if (isCatalog(this.#config)) return model;
    const overlay = windowOverlay(this.#config);
    if (this.#config.baseUrl === undefined && overlay.contextWindow === undefined && overlay.maxTokens === undefined) return model;
    return {
      ...model,
      ...(this.#config.baseUrl ? { baseUrl: this.#config.baseUrl } : {}),
      ...overlay,
    };
  }
}

function isCatalog(config: HarnessModelConfig): boolean {
  return config.schemaVersion === 2 && config.provider.kind === 'pi-catalog';
}

function hintThinking(config: HarnessModelConfig, message: string): string {
  if (isCatalog(config) || config.schemaVersion !== 2 || config.reasoning !== true) return message;
  if (!/\b(reasoning|thinking)\b/i.test(message)) return message;
  return `${message} If the gateway rejected thinking, set reasoning to false.`;
}

function windowOverlay(config: HarnessModelConfig): { contextWindow?: number; maxTokens?: number } {
  const contextWindow = 'contextWindow' in config ? config.contextWindow : undefined;
  const maxTokens = 'maxTokens' in config ? config.maxTokens : undefined;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

async function compactInto(
  live: AgentMessage[],
  agent: Agent,
  model: Model<Api>,
  models: PiModels,
  thinkingLevel: HarnessModelConfig['effort'],
  signal: AbortSignal | undefined,
  customInstructions: string | undefined,
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>) | undefined,
  availableWindow: number,
): Promise<boolean> {
  if (availableWindow <= 0) throw new Error('Context budget: system prompt, tools and output reserve exceed the model window.');
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
    if (needsPiCompaction(live, availableWindow)) throw new Error('Context budget: working set still exceeds the available window.');
    return true;
  }
  if (needsPiCompaction(compacted.messages, availableWindow)) throw new Error('Context budget: retained tail still exceeds the available window.');
  live.splice(0, live.length, ...compacted.messages);
  agent.state.messages = compacted.messages;
  await onContextCompact?.(compacted.audit);
  return true;
}

async function recoverAgentResponse(
  agent: Agent,
  model: Model<Api>,
  models: PiModels,
  thinkingLevel: HarnessModelConfig['effort'],
  signal: AbortSignal,
  customInstructions: string | undefined,
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>) | undefined,
  onRetry: ((payload: { attempt: number; kind: string; delayMs: number }) => Promise<void>) | undefined,
): Promise<void> {
  let overflowRecovered = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    signal.throwIfAborted();
    const message = lastAssistant(agent.state.messages);
    if (!message || message.role !== 'assistant' || message.stopReason !== 'error') return;
    const overflow = isContextOverflow(message, contextWindowOf(model));
    const kind = classifyAgentFailure(new Error(message.errorMessage ?? 'Agent response failed.'));
    if (!overflow && kind !== 'transient_upstream' && kind !== 'transient_network') return;
    if (attempt === 3 || (overflow && overflowRecovered)) return;
    const tail = agent.state.messages.at(-1);
    if (tail !== message) throw new Error('Agent failed outside the latest response; cannot safely continue.');
    agent.state.messages.pop();
    if (overflow) {
      const before = JSON.stringify(agent.state.messages).length;
      const compacted = await compactPiMessages({ messages: agent.state.messages, models, model, thinkingLevel, ...(customInstructions ? { customInstructions } : {}), signal });
      if (!compacted || JSON.stringify(compacted.messages).length >= before) throw new Error('Context budget: overflow recovery could not reduce the input.');
      agent.state.messages = compacted.messages;
      await onContextCompact?.(compacted.audit);
      overflowRecovered = true;
    }
    const delayMs = overflow ? 0 : 200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
    await onRetry?.({ attempt: attempt + 1, kind: overflow ? 'context_overflow' : kind, delayMs });
    await delay(delayMs, undefined, { signal });
    await agent.continue();
  }
}

function lastAssistant(messages: readonly AgentMessage[]) {
  return [...messages].reverse().find((entry) => entry.role === 'assistant');
}

function toPiTool(tool: AgentToolDefinition): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: jsonSchemaParameters(tool.parameters),
    ...(WRITE_TOOLS.has(tool.name) ? { executionMode: 'sequential' as const } : {}),
    async execute(_toolCallId, params, signal) {
      const result = await tool.execute(params, signal ?? new AbortController().signal);
      return { content: result.contentBlocks ? [...result.contentBlocks] : [{ type: 'text', text: result.content }], details: result.details ?? {} };
    },
  };
}


function jsonSchemaParameters(parameters: AgentToolDefinition['parameters']): AgentTool['parameters'] {
  return JSON.parse(JSON.stringify(parameters)) as AgentTool['parameters'];
}

function abortError(): Error { const error = new Error('Pi model request was aborted.'); error.name = 'AbortError'; return error; }


