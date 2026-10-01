import { setTimeout as delay } from 'node:timers/promises';
import { classifyAgentFailure } from './failure.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { contentText, createProvider, type ImageContent, type Models, type MutableModels } from '@earendil-works/pi-ai';
import type { AgentToolDefinition, ProviderAdapter, ProviderSession } from './host.js';
import { environmentNameForKeyRef, type HarnessModelConfig } from '../harness-model-config.js';
import { PiProviderAdapter } from './providers/pi/adapter.js';
import { sha256 } from '../../core/identity.js';
import type { ModelConfigSnapshot } from './types.js';
import { imageProbeChallenge } from './image-probe.js';
import type { HarnessImageProbe } from '../../core/schemas/image-probe.js';

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
      reasoning: config.reasoning === true, input: config.inputCapabilities ?? ['text'],
      contextWindow: overlay.contextWindow ?? 128_000, maxTokens: overlay.maxTokens ?? 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
export class PiModelCaller implements ProviderAdapter {
  readonly #models: PiModels;
  readonly #config: HarnessModelConfig;

  constructor(config: HarnessModelConfig, models?: PiModels) {
    this.#config = config;
    this.#models = models ?? modelsForConfig(config);
  }

  get inputCapabilities(): readonly string[] {
    return this.#model().input;
  }

  get modelSnapshot(): ModelConfigSnapshot {
    const model = this.#model();
    const capabilitySource: ModelConfigSnapshot['capabilitySource'] = isCatalog(this.#config) || this.#config.schemaVersion === 1 ? 'catalog'
      : this.#config.inputCapabilities ? 'config' : 'default_text';
    const snapshot = { providerId: model.provider, modelId: model.id, api: model.api,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputCapabilities: [...model.input], capabilitySource };
    const endpoint = model.baseUrl ? new URL(model.baseUrl) : undefined;
    return { ...snapshot, configFingerprint: sha256(JSON.stringify({ ...snapshot, endpoint: endpoint ? `${endpoint.protocol}//${endpoint.host}${endpoint.pathname}` : '', reasoning: model.reasoning, effort: this.#config.effort, compat: this.#config.schemaVersion === 2 ? this.#config.compat : undefined })) };
  }

  async probeImageInput(signal?: AbortSignal): Promise<HarnessImageProbe> {
    const snapshot = this.modelSnapshot;
    const base = { schemaVersion: 1 as const, configFingerprint: snapshot.configFingerprint!, providerId: snapshot.providerId, modelId: snapshot.modelId, observedAt: new Date().toISOString() };
    if (!snapshot.inputCapabilities?.includes('image')) return { ...base, status: 'unsupported' };
    const model = this.#model();
    const probeSignal = AbortSignal.any([AbortSignal.timeout(PI_PROBE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    try {
      probeSignal.throwIfAborted();
      if (!await this.#models.getAuth(model)) return { ...base, status: 'provider_failure', failureKind: 'authentication' };
      const challenge = imageProbeChallenge();
      const response = await this.#models.completeSimple(model, {
        systemPrompt: 'Identify the four vertical colored stripes in the supplied image. Reply only with the four English color names from left to right, separated by commas.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the image and give the stripe colors in order.' }, challenge.image], timestamp: Date.now() }],
      }, { signal: probeSignal, maxRetries: 0 });
      probeSignal.throwIfAborted();
      if (response.stopReason === 'error' || response.stopReason === 'aborted') throw new Error(response.errorMessage ?? 'Image probe failed.');
      const answer = contentText(response.content).trim().toLowerCase().replace(/\s+/g, '');
      return { ...base, status: answer === challenge.expected ? 'passed' : 'answer_mismatch' };
    } catch (error) {
      signal?.throwIfAborted();
      return { ...base, status: 'provider_failure', failureKind: classifyAgentFailure(error) };
    }
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
    onModelRequest?: (payload: { model: string; digest: string; messageCount: number; images?: readonly ImageContent[] }) => Promise<void>;
  }): ProviderSession {
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


