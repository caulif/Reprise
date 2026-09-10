import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import { configPath, defaultHarnessModelConfig, environmentNameForKeyRef, readHarnessModelConfig, resolveKeyRef, saveHarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import { modelsForConfig, PiModelCaller, PI_PROBE_TIMEOUT_MS } from '../../src/infrastructure/agent/model-caller.js';

test('Harness model config persists only the selected non-secret Pi model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-harness-model-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = defaultHarnessModelConfig();
  await saveHarnessModelConfig(root, config);
  assert.deepEqual(await readHarnessModelConfig(root), { schemaVersion: 2, provider: { kind: 'pi-catalog', id: config.providerId }, providerId: config.providerId, modelId: config.modelId, effort: config.effort });
  assert.doesNotMatch(await readFile(configPath(root), 'utf8'), /api[_-]?key|access|refresh/i);
  await writeFile(configPath(root), '{"schemaVersion":1,"providerId":"bad value","modelId":"x","effort":"medium"}\n');
  await assert.rejects(readHarnessModelConfig(root), /invalid/);
  await writeFile(configPath(root), '{"schemaVersion":1,"providerId":"openai","modelId":"model-a","effort":"medium","baseUrl":"https://example.test/v1/"}\n');
  const migrated = await readHarnessModelConfig(root);
  assert.equal(migrated && migrated.schemaVersion === 2 ? migrated.provider.kind : undefined, 'pi-catalog');
  assert.equal(migrated?.baseUrl, undefined);
  for (const baseUrl of ['http://example.test', 'https://key@example.test', 'https://example.test/?api_key=x', 'not-a-url']) {
    await writeFile(configPath(root), JSON.stringify({ schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'private-api' }, modelId: 'model-a', effort: 'medium', baseUrl, apiKey: 'file-secret-value' }));
    await assert.rejects(readHarnessModelConfig(root), /baseUrl/);
  }
});

test('Harness model config migrates v1 and saves v2 without a secret', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-harness-model-v2-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(configPath(root), JSON.stringify({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'high' }));
  const migrated = await readHarnessModelConfig(root);
  assert.deepEqual(migrated, { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'provider-a' }, providerId: 'provider-a', modelId: 'model-a', effort: 'high' });
  const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'private-api' }, providerId: 'private-api', modelId: 'model-a', effort: 'high' as const, baseUrl: 'https://example.test/v1', keyRef: 'env:REPRISE_TEST_KEY' };
  await saveHarnessModelConfig(root, config);
  const persisted = await readFile(configPath(root), 'utf8');
  assert.match(persisted, /schemaVersion": 2/);
  assert.match(persisted, /env:REPRISE_TEST_KEY/);
  assert.doesNotMatch(persisted, /actual-secret-value|providerId/);
  assert.equal(environmentNameForKeyRef('${REPRISE_TEST_KEY}'), 'REPRISE_TEST_KEY');
  assert.equal(resolveKeyRef('env:REPRISE_TEST_KEY', { REPRISE_TEST_KEY: 'actual-secret-value' }), 'actual-secret-value');
  for (const invalid of ['REPRISE_TEST_KEY', 'env:bad-name', '${MISSING', 'env:']) assert.throws(() => environmentNameForKeyRef(invalid), /keyRef/);
  await writeFile(configPath(root), JSON.stringify({ ...config, keyRef: 'actual-secret-value' }));
  const fromKeyRef = await readHarnessModelConfig(root);
  assert.equal(fromKeyRef && 'apiKey' in fromKeyRef ? fromKeyRef.apiKey : undefined, 'actual-secret-value');
  assert.equal(fromKeyRef && 'keyRef' in fromKeyRef ? fromKeyRef.keyRef : undefined, undefined);
  await writeFile(configPath(root), JSON.stringify({ ...config, keyRef: undefined, apiKey: 'file-secret-value' }));
  const fromApiKey = await readHarnessModelConfig(root);
  assert.equal(fromApiKey && 'apiKey' in fromApiKey ? fromApiKey.apiKey : undefined, 'file-secret-value');
  await writeFile(configPath(root), JSON.stringify({ ...config, baseUrl: 'https://key@example.test/v1' }));
  await assert.rejects(readHarnessModelConfig(root), /baseUrl/);
});

test('Harness model config persists a local apiKey', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-harness-api-key-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'private-api' }, providerId: 'private-api', modelId: 'model-a', effort: 'medium' as const, baseUrl: 'https://example.test/v1', apiKey: 'file-secret-value' };
  await saveHarnessModelConfig(root, config);
  const persisted = JSON.parse(await readFile(configPath(root), 'utf8')) as { apiKey?: string; keyRef?: string; providerId?: string };
  assert.equal(persisted.apiKey, 'file-secret-value');
  assert.equal(persisted.keyRef, undefined);
  assert.equal(persisted.providerId, undefined);
  const loaded = await readHarnessModelConfig(root);
  assert.equal(loaded && 'apiKey' in loaded ? loaded.apiKey : undefined, 'file-secret-value');
});

test('modelsForConfig registers an OpenAI-compatible model whose key only resolves at request time', async () => {
  const providers: unknown[] = [];
  const models = { setProvider(provider: unknown) { providers.push(provider); } } as never;
  const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'private-api' }, providerId: 'private-api', modelId: 'model-a', effort: 'medium' as const, baseUrl: 'https://example.test/v1', keyRef: 'env:REPRISE_TEST_KEY' };
  modelsForConfig(config, models);
  assert.equal(providers.length, 1);
  const provider = providers[0] as { getModels(): Array<{ id: string; baseUrl: string; contextWindow: number; maxTokens: number; reasoning: boolean; api: string }>; auth: { apiKey?: { resolve(input: { ctx: { env(name: string): Promise<string | undefined> }; signal: AbortSignal }): Promise<{ auth: { apiKey: string }; source?: string } | undefined> } } };
  assert.deepEqual(provider.getModels().map((model) => ({ id: model.id, baseUrl: model.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, api: model.api })), [{ id: 'model-a', baseUrl: 'https://example.test/v1', contextWindow: 128_000, maxTokens: 16_384, reasoning: false, api: 'openai-completions' }]);
  const auth = await provider.auth.apiKey?.resolve({ ctx: { env: async (name) => name === 'REPRISE_TEST_KEY' ? 'actual-secret-value' : undefined }, signal: new AbortController().signal });
  assert.equal(auth?.source, 'REPRISE_TEST_KEY');
  assert.equal(auth?.auth.apiKey, 'actual-secret-value');
  assert.doesNotMatch(JSON.stringify(provider), /actual-secret-value/);
});

test('modelsForConfig resolves an API key stored in the local config file', async () => {
  const providers: unknown[] = [];
  const models = { setProvider(provider: unknown) { providers.push(provider); } } as never;
  const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'private-api' }, providerId: 'private-api', modelId: 'model-a', effort: 'medium' as const, baseUrl: 'https://example.test/v1', apiKey: 'file-secret-value' };
  modelsForConfig(config, models);
  const provider = providers[0] as { auth: { apiKey?: { resolve(input: { ctx: { env(name: string): Promise<string | undefined> }; signal: AbortSignal }): Promise<{ auth: { apiKey: string }; source?: string } | undefined> } } };
  const auth = await provider.auth.apiKey?.resolve({ ctx: { env: async () => { throw new Error('must not read the process environment'); } }, signal: new AbortController().signal });
  assert.equal(auth?.source, 'harness-model.json');
  assert.equal(auth?.auth.apiKey, 'file-secret-value');
});

test('PiModelCaller validates configured catalog/auth and sends a text-only Pi request', async () => {
  const calls: unknown[] = [];
  const catalogModel = { id: 'model-a', name: 'Model A', input: ['text'] };
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [catalogModel],
    getModel: (providerId: string, modelId: string) => providerId === 'provider-a' && modelId === 'model-a' ? catalogModel : undefined,
    getAuth: async () => ({ auth: { apiKey: 'not-exposed' }, source: 'test credential' }),
    streamSimple: async () => { throw new Error('session stream should not run in validation test'); },
    completeSimple: async (model: unknown, context: unknown, options: unknown) => {
      calls.push({ model, context, options });
      return { stopReason: 'stop', content: [{ type: 'text', text: '{"type":"done"}' }] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium', baseUrl: 'https://example.test/v1' }, models);

  assert.deepEqual(caller.providers(), [{ id: 'provider-a', name: 'Provider A' }]);
  assert.deepEqual(caller.models(), [{ id: 'model-a', name: 'Model A' }]);
  const abort = new AbortController();
  assert.deepEqual(await caller.validate(abort.signal), { source: 'test credential' });
  assert.equal(calls.length, 1);
  const validationRequest = calls[0] as { model: { baseUrl: string }; context: { systemPrompt: string; messages: Array<{ role: string; content: string }> }; options: { maxRetries: number; signal: AbortSignal } };
  assert.equal(validationRequest.model.baseUrl, 'https://example.test/v1');
  assert.match(validationRequest.context.systemPrompt, /connection check/i);
  assert.equal(validationRequest.context.messages[0]?.content, 'Reply with exactly OK.');
  assert.equal(validationRequest.options.maxRetries, 3);
  assert.equal(PI_PROBE_TIMEOUT_MS, 180_000);
  abort.abort();
  assert.equal(validationRequest.options.signal.aborted, true);
  await assert.rejects(caller.validate(abort.signal), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('PiModelCaller rejects unconfigured providers before a model request', async () => {
  const models = {
    getProviders: () => [], getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }), getAuth: async () => undefined,
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => { throw new Error('must not call'); },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  await assert.rejects(new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models).validate(), /no usable credential/);
});



test('PiModelCaller rejects a failed minimal connection check', async () => {
  let calls = 0;
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'test credential' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => {
      calls += 1;
      return { stopReason: 'error', errorMessage: 'connection refused', content: [] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models);
  await assert.rejects(caller.validate(), /connection refused/);
  assert.equal(calls, 1);
});

test('PiModelCaller exhausts three transient probe stopReasons then fails', async () => {
  let calls = 0;
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'test credential' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => {
      calls += 1;
      return { stopReason: 'error', errorMessage: 'Upstream request failed', content: [] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models);
  await assert.rejects(caller.validate(), /Upstream request failed/);
  assert.equal(calls, 3);
});

test('PiModelCaller retries a transient probe stopReason then succeeds', async () => {
  let calls = 0;
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'test credential' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => {
      calls += 1;
      if (calls < 3) return { stopReason: 'error', errorMessage: 'Upstream request failed', content: [] };
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models);
  assert.deepEqual(await caller.validate(), { source: 'test credential' });
  assert.equal(calls, 3);
});

test('PiModelCaller does not retry an authentication probe stopReason', async () => {
  let calls = 0;
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'test credential' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => {
      calls += 1;
      return { stopReason: 'error', errorMessage: 'invalid api key', content: [] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models);
  await assert.rejects(caller.validate(), /invalid api key/);
  assert.equal(calls, 1);
});

test('modelsForConfig does not wrap a Pi catalog provider', () => {
  let registered = 0;
  const models = { setProvider() { registered += 1; } } as never;
  modelsForConfig(defaultHarnessModelConfig(), models);
  assert.equal(registered, 0);
});

test('modelsForConfig leaves an incomplete OpenAI-compatible draft unregistered', () => {
  let registered = 0;
  const models = { setProvider() { registered += 1; } } as never;
  modelsForConfig({ schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'openai-compatible' }, providerId: 'openai-compatible', modelId: 'model-a', effort: 'medium' }, models);
  assert.equal(registered, 0);
});

test('explicit reasoning true is the only way a relay advertises thinking', () => {
  const providers: unknown[] = [];
  const models = { setProvider(provider: unknown) { providers.push(provider); } } as never;
  modelsForConfig({
    schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'private-api' }, providerId: 'private-api',
    modelId: 'model-a', effort: 'medium', baseUrl: 'https://example.test/v1', apiKey: 'file-secret-value',
    reasoning: true, api: 'openai-responses',
  }, models);
  const registered = (providers[0] as { getModels(): Array<{ reasoning: boolean; api: string }> }).getModels()[0];
  assert.equal(registered?.reasoning, true);
  assert.equal(registered?.api, 'openai-responses');
});

test('catalog credential failures point at pi /login', async () => {
  const models = {
    getProviders: () => [], getModels: () => [{ id: 'gpt-5.6-terra', name: 'Terra', input: ['text'] }],
    getModel: () => ({ id: 'gpt-5.6-terra', name: 'Terra', input: ['text'] }), getAuth: async () => undefined,
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => { throw new Error('must not call'); },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  await assert.rejects(new PiModelCaller(defaultHarnessModelConfig(), models).validate(), /pi \/login/i);
});

test('relay probes retry without forcing thinking', async () => {
  const calls: unknown[] = [];
  const catalogModel = { id: 'model-a', name: 'Model A', input: ['text'] };
  const models = {
    getProviders: () => [{ id: 'private-api', name: 'Private' }],
    getModels: () => [catalogModel],
    getModel: () => catalogModel,
    getAuth: async () => ({ auth: { apiKey: 'not-exposed' }, source: 'harness-model.json' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async (_model: unknown, _context: unknown, options: unknown) => {
      calls.push(options);
      return { stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] };
    },
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  await new PiModelCaller({
    schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'private-api' }, providerId: 'private-api',
    modelId: 'model-a', effort: 'medium', baseUrl: 'https://example.test/v1', apiKey: 'file-secret-value',
  }, models).validate();
  const options = calls[0] as { maxRetries: number; reasoning?: string };
  assert.equal(options.maxRetries, 3);
  assert.equal(options.reasoning, undefined);
});
