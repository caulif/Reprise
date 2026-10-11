import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/core/identity.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { createComparisonTransformImageTool } from '../../src/application/comparison-transform-image.js';
import { createComparisonViewImageTool } from '../../src/application/comparison-view-image.js';
import { transformPng } from '../../src/infrastructure/png-transform.js';
import { renderFrozenArtifact } from '../../src/infrastructure/artifact-renderer.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const signal = new AbortController().signal;

test('frozen image transforms retain provenance and enter normal image delivery/replay artifacts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-image-transform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'parent.png'), png);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'transform', links: [], media: [{
    ref: 'media:parent', side: 'candidate', available: true, inspectPath: 'parent.png', reportHref: 'parent.png',
    contentHash: sha256(png), mediaType: 'image/png',
  }] });
  const parent = catalog.snapshot().media[0]!;
  let calls = 0;
  const tool = createComparisonTransformImageTool({ catalog, attemptRoot: root, allowImages: true,
    transform: async (bytes, recipe) => { calls++; assert.deepEqual(bytes, png); assert.equal(recipe.width, 1); return bytes; } });
  for (const params of [{ ref: parent.ref, crop: { x: 1, y: 0, width: 1, height: 1 } }, { ref: parent.ref, width: 4097 },
    { ref: parent.ref, width: 4096, height: 4096 }, { ref: 'arbitrary.png' }]) {
    assert.notEqual((JSON.parse((await tool.execute(params, signal)).content) as { status?: string }).status, 'registered');
  }
  assert.equal(calls, 0);
  const result = JSON.parse((await tool.execute({ ref: parent.ref, width: 1 }, signal)).content) as { status: string; shortRef: string };
  assert.equal(result.status, 'registered'); assert.equal(calls, 1);
  const derived = catalog.snapshot().media.find(item => item.shortRef === result.shortRef)!;
  assert.equal(derived.side, 'candidate'); assert.equal(derived.sourceRef, parent.shortRef);
  assert.equal(derived.derivation?.imageTransform?.parentHash, sha256(png));
  assert.deepEqual(await readFile(join(root, 'parent.png')), png);
  const view = createComparisonViewImageTool({ media: () => catalog.snapshot().media, attemptRoot: root, allowImages: true });
  assert.equal((await view.execute({ ref: derived.shortRef }, signal)).contentBlocks?.find(block => block.type === 'image')?.data, png.toString('base64'));
  assert.match((await createComparisonTransformImageTool({ catalog, attemptRoot: root, allowImages: false }).execute({ ref: parent.ref }, signal)).content, /not_authorized/);
  await assert.rejects(tool.execute({ ref: parent.ref }, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  await writeFile(join(root, 'parent.png'), 'changed');
  await assert.rejects(tool.execute({ ref: parent.ref }, signal), /hash or PNG/);
});

test('PNG decoder rejects invalid bytes before starting a browser', async () => {
  await assert.rejects(transformPng(Buffer.from('invalid'), { crop: { x: 0, y: 0, width: 1, height: 1 }, width: 1, height: 1 }, signal), /Invalid bounded PNG/);
});

test('real browser crop and resize uses frozen pixels without rerendering source state', { skip: process.env.REPRISE_REAL_BROWSER !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-real-image-transform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.html'), '<!doctype html><style>html,body{margin:0}body{background:blue}div{width:160px;height:240px;background:red}</style><div></div>');
  const rendered = await renderFrozenArtifact({ bundleRoot: root, entryRelativePath: 'source.html', viewport: { width: 320, height: 240, scale: 1 }, sampleTimesMs: [0], outputRoot: join(root, 'out'), signal });
  assert.equal(rendered.ok, true, JSON.stringify(rendered)); if (!rendered.ok) return;
  const original = await readFile(rendered.frames[0]!.pngPath);
  const left = await transformPng(original, { crop: { x: 0, y: 0, width: 160, height: 240 }, width: 80, height: 120 }, signal);
  const right = await transformPng(original, { crop: { x: 160, y: 0, width: 160, height: 240 }, width: 80, height: 120 }, signal);
  assert.equal(left.readUInt32BE(16), 80); assert.equal(left.readUInt32BE(20), 120);
  assert.notEqual(sha256(left), sha256(right));
  assert.deepEqual(await readFile(rendered.frames[0]!.pngPath), original);
});
