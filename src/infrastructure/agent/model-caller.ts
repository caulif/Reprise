import { setTimeout as delay } from 'node:timers/promises';
import { classifyAgentFailure } from './failure.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { contentText, createProvider, type Models, type MutableModels } from '@earendil-works/pi-ai';
import type { AgentToolDefinition, PiTextCaller, PiTextSession } from './host.js';
import { environmentNameForKeyRef, type HarnessModelConfig } from '../harness-model-config.js';
import { PiProviderAdapter } from './providers/pi/adapter.js';

export type PiModels = Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
type MutablePiModels = PiModels & Pick<MutableModels, 'setProvider'>;

export type PiProviderOption = { readonly id: string; readonly name: string };
export type PiModelOption = { readonly id: string; readonly name: string };

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
    return new PiProviderAdapter({ models: this.#models, config: this.#config, model: this.#model() }).createSession(input);
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


