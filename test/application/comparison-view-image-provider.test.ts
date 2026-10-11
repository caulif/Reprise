import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { createComparisonViewImageTool } from '../../src/application/comparison-view-image.js';
import { sha256 } from '../../src/core/identity.js';

test('Pi continues after invalid image reference and persists the subsequent actual image request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-image-provider-'));
  const store = await ExperimentStore.open(root, 'experiment');
  await store.acquireWriter();
  let closeSession = async (): Promise<void> => {};
  t.after(async () => { await closeSession(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await writeFile(join(root, 'one.png'), png);
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
    reasoning: false, input: ['text', 'image'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let generations = 0;
  const models = { getModel: () => model, streamSimple: () => {
    generations++;
    assert.ok(generations <= 3);
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 1,
      content: generations < 3 ? [{ type: 'toolCall', id: `call-${generations}`, name: 'view_image', arguments: { ref: generations === 1 ? 'missing' : 'media-1' } }]
        : [{ type: 'text', text: 'Done' }], stopReason: generations < 3 ? 'toolUse' : 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low', inputCapabilities: ['text', 'image'] }, models);
  const session = await new AgentHost(caller).createSession({ role: 'comparison', systemPrompt: 'Observe registered image.',
    tools: [createComparisonViewImageTool({ attemptRoot: root, allowImages: true, media: () => [{ ref: 'media:baseline:one', shortRef: 'media-1',
      side: 'baseline', inspectPath: 'one.png', reportHref: 'one.png', mediaType: 'image/png', available: true, contentHash: sha256(png) }] })],
    audit: experimentAgentAuditSink(store, 'run-1'),
  });
  closeSession = () => session.close();
  const result = await session.work({ promptContent: 'View image.', timeoutMs: 5_000 });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(generations, 3);
  const rebuilt = await reconstructModelRequests(store.events(), experimentModelInputResolver(store, 'run-1'));
  assert.equal(rebuilt.requests.at(-1)?.nativeImages?.[0]?.contentHash, sha256(png));
  assert.equal(rebuilt.requests.at(-1)?.contentComplete, true);
  assert.equal(store.events().some(event => event.type === 'agent.tool_failed'), false);
});
