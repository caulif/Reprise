import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { contentText, createProvider, isContextOverflow, type Api, type Model, type Models, type MutableModels } from '@earendil-works/pi-ai';
import type { AgentToolDefinition, PiTextCaller, PiTextSession } from './pi-agent-host.js';
import {
  compactPiMessages,
  contextWindowOf,
  convertToLlm,
  needsPiCompaction,
} from './pi-compaction.js';
import { environmentNameForKeyRef, type HarnessModelConfig } from './harness-model-config.js';

export type PiModels = Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
type MutablePiModels = PiModels & Pick<MutableModels, 'setProvider'>;

export type PiProviderOption = { readonly id: string; readonly name: string };
export type PiModelOption = { readonly id: string; readonly name: string };

const WRITE_TOOLS = new Set(['edit', 'write', 'powershell']);
const STREAM_RETRIES = 3;
const STREAM_RETRY_DELAY_MS = 8_000;

/** Builds Pi's native custom-provider path. The key comes from the local config file, or env:NAME. */
export function modelsForConfig(config: HarnessModelConfig, models: MutablePiModels = builtinModels()): MutablePiModels {
  if (config.schemaVersion !== 2 || config.provider.kind !== 'openai-compatible') return models;
  const fileKey = config.apiKey;
  const keyRef = config.keyRef;
  const baseUrl = config.baseUrl;
  if (!baseUrl || (!fileKey && !keyRef)) throw new Error('OpenAI-compatible configuration requires baseUrl and apiKey.');
  const overlay = windowOverlay(config);
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
      id: config.modelId, name: config.modelId, api: 'openai-completions', provider: config.provider.id, baseUrl,
      reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: overlay.contextWindow ?? 128_000, maxTokens: overlay.maxTokens ?? 16_384,
    }],
    api: openAICompletionsApi(),
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

  async validate(): Promise<{ source?: string }> {
    const model = this.#model();
    const auth = await this.#models.getAuth(model);
    if (!auth) throw new Error(`Pi has no usable credential for provider ${this.#config.providerId}. Add apiKey to harness-model.json, or set the referenced environment variable.`);
    const response = await this.#models.completeSimple(model, {
      systemPrompt: 'Reprise connection check. Reply with exactly OK.',
      messages: [{ role: 'user', content: 'Reply with exactly OK.', timestamp: Date.now() }],
    }, { reasoning: this.#config.effort, signal: AbortSignal.timeout(15_000) });
    if (response.stopReason === 'error' || response.stopReason === 'aborted' || !contentText(response.content).trim()) {
      throw new Error(response.errorMessage ?? `Pi model connection check stopped: ${response.stopReason}.`);
    }
    return auth.source === undefined ? {} : { source: auth.source };
  }

  createSession(input: {
    sessionId: string;
    systemPrompt: string;
    tools: readonly AgentToolDefinition[];
    onContextCompact?: (payload: { summary: string; tokensBefore: number; retainedCount: number }) => Promise<void>;
  }): PiTextSession {
    const model = this.#model();
    const models = this.#models;
    const effort = this.#config.effort;
    const agent = new Agent({
      sessionId: input.sessionId,
      streamFn: (streamModel, context, options) => this.#models.streamSimple(streamModel, context, {
        ...options,
        maxRetries: STREAM_RETRIES,
        maxRetryDelayMs: STREAM_RETRY_DELAY_MS,
      }),
      convertToLlm,
      toolExecution: 'parallel',
      maxRetryDelayMs: STREAM_RETRY_DELAY_MS,
      shouldStopAfterTurn: async ({ context }, signal) => {
        await compactInto(context.messages, agent, model, models, effort, signal, input.onContextCompact);
        return false;
      },
      initialState: {
        systemPrompt: input.systemPrompt,
        model,
        thinkingLevel: this.#config.effort,
        tools: input.tools.map(toPiTool),
      },
    });
    return {
      async append({ content, signal }): Promise<string> {
        if (signal.aborted) throw abortError();
        const abort = () => agent.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
          await agent.prompt(content);
          await recoverOverflow(agent, model, models, effort, signal, input.onContextCompact);
          const message = lastAssistant(agent.state.messages);
          if (!message || message.role !== 'assistant') throw new Error('Pi Agent session ended without an assistant message.');
          if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Pi Agent session stopped: ${message.stopReason}.`);
          return contentText(message.content);
        } finally {
          signal.removeEventListener('abort', abort);
          await agent.waitForIdle();
        }
      },
      cancel(): void { agent.abort(); },
    };
  }

  #model() {
    const model = this.#models.getModel(this.#config.providerId, this.#config.modelId);
    if (!model) throw new Error(`Pi provider ${this.#config.providerId} does not expose model ${this.#config.modelId}.`);
    if (!model.input.includes('text')) throw new Error(`Pi model ${this.#config.modelId} does not accept text input.`);
    const overlay = windowOverlay(this.#config);
    if (this.#config.baseUrl === undefined && overlay.contextWindow === undefined && overlay.maxTokens === undefined) return model;
    return {
      ...model,
      ...(this.#config.baseUrl ? { baseUrl: this.#config.baseUrl } : {}),
      ...overlay,
    };
  }
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
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number }) => Promise<void>) | undefined,
): Promise<boolean> {
  if (!needsPiCompaction(live, contextWindowOf(model))) return false;
  const compacted = await compactPiMessages({ messages: live, models, model, thinkingLevel, ...(signal ? { signal } : {}) });
  if (!compacted) return false;
  live.splice(0, live.length, ...compacted.messages);
  agent.state.messages = compacted.messages;
  await onContextCompact?.(compacted.audit);
  return true;
}

async function recoverOverflow(
  agent: Agent,
  model: Model<Api>,
  models: PiModels,
  thinkingLevel: HarnessModelConfig['effort'],
  signal: AbortSignal,
  onContextCompact: ((payload: { summary: string; tokensBefore: number; retainedCount: number }) => Promise<void>) | undefined,
): Promise<void> {
  const message = lastAssistant(agent.state.messages);
  if (!message || message.role !== 'assistant') return;
  if (!isContextOverflow(message, contextWindowOf(model))) return;
  const compacted = await compactPiMessages({ messages: agent.state.messages, models, model, thinkingLevel, signal });
  if (!compacted) return;
  agent.state.messages = compacted.messages;
  await onContextCompact?.(compacted.audit);
  const last = compacted.messages.at(-1);
  if (last && (last.role === 'user' || last.role === 'toolResult')) await agent.continue();
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
      return { content: [{ type: 'text', text: result.content }], details: result.details ?? {} };
    },
  };
}

function jsonSchemaParameters(parameters: AgentToolDefinition['parameters']): AgentTool['parameters'] {
  return JSON.parse(JSON.stringify(parameters)) as AgentTool['parameters'];
}

function abortError(): Error { const error = new Error('Pi model request was aborted.'); error.name = 'AbortError'; return error; }
