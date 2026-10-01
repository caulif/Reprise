import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { attachComparisonImages } from '../../src/application/comparison-image-delivery.js';
import { sha256 } from '../../src/core/identity.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';
import { instrumentTools } from '../../src/infrastructure/agent/tools.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('failed image attachment audit prevents tool delivery and completion callbacks', async () => {
  let completed = false;
  const tools = instrumentTools([{ name: 'preview', description: 'Preview', parameters: Type.Object({}),
    execute: async () => ({ content: 'media-01', contentBlocks: [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }] }),
    onCompleted: async () => { completed = true; } }], 'session', 'comparison', { requestIndex: 0 }, {
    append: async () => {}, commitModelInput: async () => { throw new Error('attachment write failed'); },
  }, true);
  await assert.rejects(tools[0]!.execute({}, new AbortController().signal), /tool execution failed/);
  assert.equal(completed, false);
});

test('attached registered images respect authorization, hash, bounds and cancellation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-native-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'media'));
  await writeFile(join(root, 'media', 'one.png'), PNG);
  const base = { result: { content: '{"status":"ok"}' }, requested: true, authorized: true, attemptRoot: root,
    signal: new AbortController().signal, images: [{ path: 'media/one.png', contentHash: sha256(PNG), shortRef: 'media-01' }] };
  const result = await attachComparisonImages(base);
  assert.equal(result.contentBlocks?.filter((block) => block.type === 'image').length, 1);
  assert.equal((JSON.parse(result.content) as { imageDelivery: string }).imageDelivery, 'attached');
  const denied = await attachComparisonImages({ ...base, authorized: false, images: [{ ...base.images[0]!, path: 'missing.png' }] });
  assert.equal((JSON.parse(denied.content) as { imageDelivery: string }).imageDelivery, 'not_authorized');
  assert.equal(denied.contentBlocks, undefined);
  assert.equal(await attachComparisonImages({ ...base, requested: false }), base.result);
  await assert.rejects(attachComparisonImages({ ...base, images: [{ ...base.images[0]!, contentHash: 'a'.repeat(64) }] }), /hash or PNG/);
  assert.equal((JSON.parse((await attachComparisonImages({ ...base, images: Array(5).fill(base.images[0]) })).content) as { imageDelivery: string }).imageDelivery, 'budget_exceeded');
  assert.equal((JSON.parse((await attachComparisonImages({ ...base, images: [] })).content) as { imageDelivery: string }).imageDelivery, 'unavailable');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(attachComparisonImages({ ...base, signal: abort.signal }), { name: 'AbortError' });
  const outside = await mkdtemp(join(tmpdir(), 'reprise-native-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'one.png'), PNG);
  await symlink(outside, join(root, 'escape'), 'junction');
  await assert.rejects(attachComparisonImages({ ...base, images: [{ ...base.images[0]!, path: 'escape/one.png' }] }), /escapes attempt/);
  const invalid = Buffer.from(PNG); invalid.writeUInt32BE(10_000, 16); invalid.writeUInt32BE(10_000, 20);
  await writeFile(join(root, 'media', 'one.png'), invalid);
  await assert.rejects(attachComparisonImages({ ...base, images: [{ ...base.images[0]!, contentHash: sha256(invalid) }] }), /PNG validation/);
});

test('tool images and actual request manifests survive process restart through immutable input attachments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-image-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'exp-image');
  await store.acquireWriter();
  const image = { type: 'image' as const, mimeType: 'image/png', data: PNG.toString('base64') };
  const host = new AgentHost({ inputCapabilities: ['text', 'image'], createSession: (input) => ({
    inputCapabilities: ['text', 'image'],
    append: async ({ signal }) => {
      await input.onModelRequest!({ model: 'vision', digest: sha256('first'), messageCount: 1, images: [] });
      const result = await input.tools[0]!.execute({}, signal);
      assert.equal(result.contentBlocks?.find((block) => block.type === 'image')?.data, image.data);
      await input.onContextCompact!({ summary: 'Inspect media-01', tokensBefore: 100, retainedCount: 1,
        retainedTail: [{ role: 'toolResult', toolName: 'preview', content: [{ type: 'text', text: 'media-01' }, image] }] });
      await input.onModelRequest!({ model: 'vision', digest: sha256('actual'), messageCount: 3, images: [image] });
      return '{"ok":true}';
    }, cancel() {},
  }) });
  const result = await host.request({ role: 'comparison', systemPrompt: 'Compare', allowModelText: true,
    schema: Type.Object({ ok: Type.Boolean() }), timeoutMs: 0, maxRepairAttempts: 0, promptContent: 'Inspect',
    tools: [{ name: 'preview', description: 'Inspect registered media', parameters: Type.Object({}), execute: async () => ({ content: 'media-01', contentBlocks: [{ type: 'text', text: 'media-01' }, image] }) }],
    audit: experimentAgentAuditSink(store, 'run-image') });
  assert.equal(result.status, 'completed');
  const events = store.events();
  assert.ok(!JSON.stringify(events).includes(image.data));
  await store.close();
  const reopened = await ExperimentStore.open(root, 'exp-image');
  const rebuilt = await reconstructModelRequests(reopened.events(), experimentModelInputResolver(reopened, 'run-image'));
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests.length, 2);
  assert.deepEqual(rebuilt.requests[0]?.nativeImages, []);
  assert.doesNotMatch(JSON.stringify(rebuilt.requests[0]?.messages), /"type":"image"/);
  assert.equal(rebuilt.requests.at(-1)?.nativeImages?.[0]?.contentHash, sha256(PNG));
  assert.ok(rebuilt.requests.at(-1)?.nativeImages?.[0]?.artifactId);
  assert.equal(rebuilt.requests.at(-1)?.contentComplete, true);
  assert.equal(rebuilt.requests.at(-1)?.compacted, true);
  assert.match(JSON.stringify(rebuilt.requests.at(-1)?.messages), /"type":"image"/);
  const missing = Object.assign(async () => '', { image: async (): Promise<Uint8Array> => { throw new Error('missing'); } });
  assert.equal((await reconstructModelRequests(reopened.events(), missing)).diagnostic?.code, 'missing_attachment');
  const corrupted = Object.assign(async () => '', { image: async () => Buffer.from('wrong') });
  assert.equal((await reconstructModelRequests(reopened.events(), corrupted)).diagnostic?.code, 'attachment_checksum');
  await reopened.close();
});
