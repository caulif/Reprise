import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Models } from '@earendil-works/pi-ai';
import { configPath, defaultHarnessModelConfig, environmentNameForKeyRef, readHarnessModelConfig, resolveKeyRef, saveHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { modelsForConfig, PiModelCaller } from '../src/infrastructure/pi-model-caller.js';

test('Harness model config persists only the selected non-secret Pi model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-harness-model-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const config = defaultHarnessModelConfig();
  await saveHarnessModelConfig(root, config);
  assert.deepEqual(await readHarnessModelConfig(root), { schemaVersion: 2, provider: { kind: 'pi-catalog', id: config.providerId }, providerId: config.providerId, modelId: config.modelId, effort: config.effort });
  assert.doesNotMatch(await readFile(configPath(root), 'utf8'), /api[_-]?key|access|refresh/i);
  await writeFile(configPath(root), '{"schemaVersion":1,"providerId":"bad value","modelId":"x","effort":"medium"}\n');
  await assert.rejects(readHarnessModelConfig(root), /invalid/);
  await writeFile(configPath(root), '{\"schemaVersion\":1,\"providerId\":\"openai\",\"modelId\":\"model-a\",\"effort\":\"medium\",\"baseUrl\":\"https://example.test/v1/\"}\n');
  assert.equal((await readHarnessModelConfig(root))?.baseUrl, 'https://example.test/v1/');
  for (const baseUrl of ['http://example.test', 'https://key@example.test', 'https://example.test/?api_key=x', 'not-a-url']) {
    await writeFile(configPath(root), JSON.stringify({ schemaVersion: 1, providerId: 'openai', modelId: 'model-a', effort: 'medium', baseUrl }));
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
  await assert.rejects(readHarnessModelConfig(root), /keyRef/);
  await writeFile(configPath(root), JSON.stringify({ ...config, baseUrl: 'https://key@example.test/v1' }));
  await assert.rejects(readHarnessModelConfig(root), /baseUrl/);
});

test('modelsForConfig registers an OpenAI-compatible model whose key only resolves at request time', async () => {
  const providers: unknown[] = [];
  const models = { setProvider(provider: unknown) { providers.push(provider); } } as never;
  const config = { schemaVersion: 2 as const, provider: { kind: 'openai-compatible' as const, id: 'private-api' }, providerId: 'private-api', modelId: 'model-a', effort: 'medium' as const, baseUrl: 'https://example.test/v1', keyRef: 'env:REPRISE_TEST_KEY' };
  modelsForConfig(config, models);
  assert.equal(providers.length, 1);
  const provider = providers[0] as { getModels(): Array<{ id: string; baseUrl: string }>; auth: { apiKey?: { resolve(input: { ctx: { env(name: string): Promise<string | undefined> }; signal: AbortSignal }): Promise<{ auth: { apiKey: string }; source?: string } | undefined> } } };
  assert.deepEqual(provider.getModels().map((model) => ({ id: model.id, baseUrl: model.baseUrl })), [{ id: 'model-a', baseUrl: 'https://example.test/v1' }]);
  const auth = await provider.auth.apiKey?.resolve({ ctx: { env: async (name) => name === 'REPRISE_TEST_KEY' ? 'actual-secret-value' : undefined }, signal: new AbortController().signal });
  assert.equal(auth?.source, 'REPRISE_TEST_KEY');
  assert.equal(auth?.auth.apiKey, 'actual-secret-value');
  assert.doesNotMatch(JSON.stringify(provider), /actual-secret-value/);
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
  assert.deepEqual(await caller.validate(), { source: 'test credential' });
  assert.equal(calls.length, 1);
  const validationRequest = calls[0] as { model: { baseUrl: string }; context: { systemPrompt: string; messages: Array<{ role: string; content: string }> } };
  assert.equal(validationRequest.model.baseUrl, 'https://example.test/v1');
  assert.match(validationRequest.context.systemPrompt, /connection check/i);
  assert.equal(validationRequest.context.messages[0]?.content, 'Reply with exactly OK.');
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
  const models = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'test credential' }),
    streamSimple: async () => { throw new Error('must not call'); },
    completeSimple: async () => ({ stopReason: 'error', errorMessage: 'connection refused', content: [] }),
  } as unknown as Pick<Models, 'getProviders' | 'getModels' | 'getModel' | 'getAuth' | 'completeSimple' | 'streamSimple'>;
  const caller = new PiModelCaller({ schemaVersion: 1, providerId: 'provider-a', modelId: 'model-a', effort: 'medium' }, models);
  await assert.rejects(caller.validate(), /connection refused/);
});
