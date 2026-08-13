import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { contentText, createProvider, type Models, type MutableModels, type ThinkingLevel } from '@earendil-works/pi-ai';
import type { AgentToolDefinition, PiTextCaller, PiTextSession } from './pi-agent-host.js';
import { environmentNameForKeyRef, type HarnessModelConfig } from './harness-model-config.js';

export type PiModels = Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
type MutablePiModels = PiModels & Pick<MutableModels, 'setProvider'>;

export type PiProviderOption = { readonly id: string; readonly name: string };
export type PiModelOption = { readonly id: string; readonly name: string };

/** Builds Pi's native custom-provider path without persisting or logging an API key. */
export function modelsForConfig(config: HarnessModelConfig, models: MutablePiModels = builtinModels()): MutablePiModels {
  if (config.schemaVersion !== 2 || config.provider.kind !== 'openai-compatible') return models;
  const keyRef = config.keyRef;
  const baseUrl = config.baseUrl;
  if (!keyRef || !baseUrl) throw new Error('OpenAI-compatible configuration requires baseUrl and keyRef.');
  const environmentName = environmentNameForKeyRef(keyRef);
  models.setProvider(createProvider({
    id: config.provider.id,
    name: config.provider.id,
    baseUrl,
    auth: {
      apiKey: {
        name: 'Reprise API key',
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const apiKey = await ctx.env(environmentName);
          signal.throwIfAborted();
          return apiKey ? { auth: { apiKey }, source: environmentName } : undefined;
        },
      },
    },
    models: [{
      id: config.modelId, name: config.modelId, api: 'openai-completions', provider: config.provider.id, baseUrl,
      reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000, maxTokens: 16_384,
    }],
    api: openAICompletionsApi(),
  }));
  return models;
}

/**
 * Pi adapter for internal Agent sessions. `completeSimple` is intentionally
 * retained only for the connection probe; product agents run through Agent.
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

  async validate(): Promise<{ source?: string }> {
    const model = this.#model();
    const auth = await this.#models.getAuth(model);
    if (!auth) throw new Error(`Pi has no usable credential for provider ${this.#config.providerId}. Configure that provider in Pi or its supported environment first.`);
    const response = await this.#models.completeSimple(model, {
      systemPrompt: 'Reprise connection check. Reply with exactly OK.',
      messages: [{ role: 'user', content: 'Reply with exactly OK.', timestamp: Date.now() }],
    }, { reasoning: this.#config.effort, signal: AbortSignal.timeout(15_000) });
    if (response.stopReason === 'error' || response.stopReason === 'aborted' || !contentText(response.content).trim()) {
      throw new Error(response.errorMessage ?? `Pi model connection check stopped: ${response.stopReason}.`);
    }
    return auth.source === undefined ? {} : { source: auth.source };
  }

  createSession(input: { sessionId: string; systemPrompt: string; tools: readonly AgentToolDefinition[] }): PiTextSession {
    const agent = new Agent({
      sessionId: input.sessionId,
      streamFn: this.#models.streamSimple.bind(this.#models),
      toolExecution: 'sequential',
      initialState: {
        systemPrompt: input.systemPrompt,
        model: this.#model(),
        thinkingLevel: this.#config.effort as ThinkingLevel,
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
          const message = [...agent.state.messages].reverse().find((entry) => entry.role === 'assistant');
          if (!message || message.role !== 'assistant') throw new Error('Pi Agent session ended without an assistant message.');
          if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Pi Agent session stopped: ${message.stopReason}.`);
          return contentText(message.content);
        } finally {
          signal.removeEventListener('abort', abort);
        }
      },
      cancel(): void { agent.abort(); },
    };
  }

  #model() {
    const model = this.#models.getModel(this.#config.providerId, this.#config.modelId);
    if (!model) throw new Error(`Pi provider ${this.#config.providerId} does not expose model ${this.#config.modelId}.`);
    if (!model.input.includes('text')) throw new Error(`Pi model ${this.#config.modelId} does not accept text input.`);
    return this.#config.baseUrl === undefined ? model : { ...model, baseUrl: this.#config.baseUrl };
  }
}

function toPiTool(tool: AgentToolDefinition): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters as never,
    executionMode: 'sequential',
    async execute(_toolCallId, params, signal) {
      const result = await tool.execute(params, signal ?? new AbortController().signal);
      return { content: [{ type: 'text', text: result.content }], details: result.details ?? {} };
    },
  };
}

function abortError(): Error { const error = new Error('Pi model request was aborted.'); error.name = 'AbortError'; return error; }
