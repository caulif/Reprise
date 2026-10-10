import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/core/identity.js';
import type { ComparisonMediaRecord } from '../../src/core/comparison-schema.js';
import { createComparisonViewImageTool } from '../../src/application/comparison-view-image.js';
import { workspaceTools } from '../../src/infrastructure/recovery-workspace-tools.js';
import { instrumentTools } from '../../src/infrastructure/agent/tools.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const signal = new AbortController().signal;

test('registered large PNGs and legacy image reads deliver whole images without changing text pagination', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-view-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Padding reproduces the old byte-limit rejection without introducing a renderer dependency.
  const bytes = Buffer.concat([png, Buffer.alloc(142_440 - png.length)]);
  await writeFile(join(root, 'large.png'), bytes);
  const media: ComparisonMediaRecord = { ref: 'media:baseline:large', shortRef: 'media-1', side: 'baseline',
    inspectPath: 'large.png', reportHref: 'large.png', mediaType: 'image/png', available: true, contentHash: sha256(bytes) };
  const view = createComparisonViewImageTool({ attemptRoot: root, allowImages: true, media: () => [media] });
  for (const ref of ['media-1', media.ref]) {
    const result = await view.execute({ ref }, signal);
    assert.equal((JSON.parse(result.content) as Record<string, unknown>).imageDelivery, 'attached');
    assert.equal(result.contentBlocks?.find(block => block.type === 'image')?.data, bytes.toString('base64'));
  }
  for (const params of [{ path: 'large.png' }, { ref: 'large.png' }]) {
    assert.equal((await view.execute(params, signal)).contentBlocks, undefined);
  }
  assert.match((await createComparisonViewImageTool({ attemptRoot: root, allowImages: false, media: () => [media] }).execute({ ref: 'media-1' }, signal)).content, /not_authorized/);
  media.mediaType = 'image/jpeg';
  assert.match((await view.execute({ ref: 'media-1' }, signal)).content, /unsupported_image_format/);
  media.mediaType = 'image/png';
  const read = workspaceTools(root, { allowBinary: true }).find(tool => tool.name === 'read')!;
  for (const params of [{ offset: 1 }, { maxBytes: 65_536 }, { mimeType: 'text/plain' }]) {
    assert.equal((await read.execute({ path: 'large.png', format: 'image', mimeType: 'image/png', ...params }, signal)).contentBlocks, undefined);
  }
  assert.equal((await read.execute({ path: 'large.png', format: 'image', mimeType: 'image/png' }, signal)).contentBlocks?.[1]?.type, 'image');
  assert.equal(((await read.execute({ path: 'large.png' }, signal)).details as Record<string, unknown>).nextCursor, 65_536);
  assert.equal((await read.execute({ path: 'large.png', offset: 65_536, maxBytes: 10 }, signal)).content.length, 10);
  const textOnly = instrumentTools([view], 'session', 'comparison', { requestIndex: 0 });
  const stripped = await textOnly[0]!.execute({ ref: 'media-1' }, signal);
  assert.match(stripped.content, /unsupported_model/);
  assert.equal(stripped.contentBlocks?.some(block => block.type === 'image') ?? false, false);
  const events: string[] = [];
  const audited = instrumentTools([read], 'session', 'comparison', { requestIndex: 0 }, { append: async event => { events.push(event.type); } }, true);
  await audited[0]!.execute({ path: 'large.png', format: 'image', mimeType: 'image/png', offset: 1 }, signal);
  await audited[0]!.execute({ path: 'large.png' }, signal);
  assert.equal(events.filter(type => type === 'agent.tool_completed').length, 2);
  assert.equal(events.includes('agent.tool_failed'), false);
  await writeFile(join(root, 'large.png'), 'corrupted');
  assert.match((await read.execute({ path: 'large.png', format: 'image', mimeType: 'image/png' }, signal)).content, /invalid_image/);
  await assert.rejects(view.execute({ ref: 'media-1' }, signal), /hash or PNG/);
  await writeFile(join(root, 'large.png'), Buffer.alloc(3 * 1024 * 1024 + 1));
  assert.match((await view.execute({ ref: 'media-1' }, signal)).content, /budget_exceeded/);
  assert.match((await read.execute({ path: 'large.png', format: 'image', mimeType: 'image/png' }, signal)).content, /image_read_requires_whole_file/);
  const cancelled = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(view.execute({ ref: 'media-1' }, cancelled), /cancelled/);
});
