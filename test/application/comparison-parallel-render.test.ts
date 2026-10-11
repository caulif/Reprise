import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncCapacity } from '../../src/infrastructure/async-capacity.js';
import { createRenderArtifactTool } from '../../src/application/comparison-render-tools.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderFrozenArtifact } from '../../src/infrastructure/artifact-renderer.js';
import { createEphemeralRenderCatalog } from './comparison-render-catalog-ephemeral.js';
import { sha256 } from '../../src/core/identity.js';

test('render jobs overlap two independent directories and queued cancellation cannot launch a third', async () => {
  let release!: () => void, both!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { both = resolve; });
  const roots: string[] = [];
  let active = 0, peak = 0;
  const tool = createRenderArtifactTool({ attemptRoot: 'attempt', catalog: {
    revision: () => 0,
    resolveSource: async sourceRef => ({ sourceRef, side: 'baseline', bundleRoot: 'bundle', entryRelativePath: 'a.html', contentHash: 'hash', origin: 'historical_artifact' }),
    registerDerivedMedia: async () => { throw new Error('no registration on failure'); },
    registerDerivedMediaBatch: async () => { throw new Error('no registration on failure'); },
  }, render: async request => {
    roots.push(request.outputRoot); active++; peak = Math.max(peak, active);
    if (active === 2) both();
    await gate; active--;
    return { ok: false, failure: { kind: 'capture_failed', message: 'fixture' }, diagnostics: [] };
  } });
  const signal = new AbortController().signal;
  const one = tool.execute({ sourceRef: 'ev-01', viewport: { width: 320, height: 240 } }, signal);
  const two = tool.execute({ sourceRef: 'ev-01', viewport: { width: 640, height: 480 } }, signal);
  await started;
  const abort = new AbortController();
  const third = tool.execute({ sourceRef: 'ev-01' }, abort.signal);
  await Promise.resolve(); await Promise.resolve();
  abort.abort(new Error('queued cancellation'));
  await assert.rejects(third, /queued cancellation/);
  release(); await Promise.all([one, two]);
  assert.equal(roots.length, 2); assert.equal(new Set(roots).size, 2); assert.equal(peak, 2);
});

test('capacity handoff preserves FIFO and releases capacity on action failure or cancellation', async () => {
  const capacity = new AsyncCapacity(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: number[] = [];
  const one = capacity.run(new AbortController().signal, async () => { await gate; order.push(1); });
  const two = capacity.run(new AbortController().signal, async () => { order.push(2); throw new Error('failure'); });
  const rejected = assert.rejects(two, /failure/);
  const abort = new AbortController();
  const three = capacity.run(abort.signal, async () => { order.push(3); });
  abort.abort(new Error('cancelled'));
  await assert.rejects(three, /cancelled/);
  const four = capacity.run(new AbortController().signal, async () => { order.push(4); });
  release(); await Promise.all([one, rejected, four]);
  assert.deepEqual(order, [1, 2, 4]);
  await assert.rejects(capacity.run(AbortSignal.abort(new Error('early')), async () => 0), /early/);
});

test('real same-source browser renders overlap with isolated outputs and capacity two', { skip: process.env.REPRISE_REAL_BROWSER !== '1' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-real-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.html'), '<!doctype html><body style="background:green">parallel render');
  const catalog = createEphemeralRenderCatalog({ sources: [{ sourceRef: 'ev-01', side: 'candidate', bundleRoot: root,
    entryRelativePath: 'source.html', contentHash: sha256(await readFile(join(root, 'source.html'))), origin: 'candidate' }],
    mediaRoot: join(root, 'media'), reviewRoot: join(root, 'review') });
  let active = 0, peak = 0;
  const roots: string[] = [];
  const intervals: { start: number; end: number }[] = [];
  const tool = createRenderArtifactTool({ catalog, attemptRoot: root, render: async request => {
    active++; peak = Math.max(peak, active); roots.push(request.outputRoot);
    const interval = { start: Date.now(), end: 0 }; intervals.push(interval);
    try { return await renderFrozenArtifact(request); }
    finally { interval.end = Date.now(); active--; }
  } });
  const results = await Promise.all([320, 480, 640].map(width => tool.execute({ sourceRef: 'ev-01', viewport: { width, height: 240 } }, new AbortController().signal)));
  for (const result of results) assert.equal((JSON.parse(result.content) as { status: string }).status, 'ok');
  assert.equal(peak, 2); assert.equal(new Set(roots).size, 3);
  assert.ok(intervals[1]!.start < intervals[0]!.end, 'actual browser render operations overlapped');
  assert.ok(intervals[2]!.start >= Math.min(intervals[0]!.end, intervals[1]!.end), 'third render waited for capacity');
});
