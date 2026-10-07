import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createRenderArtifactTool, type ComparisonRenderCatalogPort, type ComparisonRenderedCheck } from '../../src/application/comparison-render-tools.js';
import type { RenderGeometryQuery, RenderGeometrySample } from '../../src/core/schema.js';
import { sha256 } from '../../src/core/identity.js';
import type { RenderRequest, RenderResult } from '../../src/infrastructure/artifact-render-types.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';

const viewport = { width: 640, height: 480, scale: 1 };
const query: RenderGeometryQuery = { name: 'pedal', selector: '#pedal', kind: 'svg_geometry' };
function sample(time: number): RenderGeometrySample {
  return { schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: time + 8, finishedAtMs: time + 9,
    observations: [{ ...query, status: 'ok', tagName: 'line', elementId: 'pedal', parentId: 'crank',
      bounds: { x: 0, y: 0, width: 10, height: 0 }, localPoints: [{ name: 'start', x: 0, y: 0 }],
      screenPoints: [{ name: 'start', x: 72, y: 380 }], matrix: { a: 1, b: 0, c: 0, d: 1, e: 72, f: 380 } }] };
}
function success(same = false): Extract<RenderResult, { ok: true }> {
  return { ok: true, diagnostics: [], measured: { viewport, loadMs: 1, origin: 'private' },
    frames: [0, 500].map(time => ({ sampleTimeMs: time, actualTimeMs: time + 7, pngPath: 'C:/private/frame.png',
      byteLength: 20, contentHash: same ? 'same-hash' : `hash-${time}`, geometrySample: sample(time) })) };
}
function fixture(result: RenderResult, registrationFails = false, afterRender?: () => void) {
  const checks: ComparisonRenderedCheck[] = [];
  const requests: RenderRequest[] = [];
  const catalog: ComparisonRenderCatalogPort = {
    revision: () => 1,
    resolveSource: async () => ({ sourceRef: 'ev-01', side: 'candidate', bundleRoot: 'C:/private/source', entryRelativePath: 'wheel.svg', contentHash: 'source-hash', origin: 'candidate' }),
    registerDerivedMedia: async () => ({ ok: false, code: 'unused', message: 'unused' }),
    registerDerivedMediaBatch: async inputs => registrationFails ? { ok: false, code: 'io_failed', message: 'failed' }
      : { ok: true, items: inputs.map((_item, i) => ({ ok: true as const, shortRef: `media-0${i + 1}`, mediaRef: `media:${i}`, revision: 1 })) },
  };
  const tool = createRenderArtifactTool({ catalog, attemptRoot: 'C:/private/attempt', allowImages: false,
    render: async request => { requests.push(request); afterRender?.(); return result; },
    onRenderedCheck: check => { checks.push(check); } });
  const params = { sourceRef: 'ev-01', sampleTimesMs: [0, 500], viewport, geometryQueries: [query], includeImages: true };
  const run = async (overrides: Record<string, unknown> = {}, signal = new AbortController().signal) => {
    const result = await tool.execute({ ...params, ...overrides }, signal);
    return { result, body: JSON.parse(result.content) as { status: string; imageDelivery?: string; renderedCheck: ComparisonRenderedCheck } };
  };
  return { tool, params, run, checks, requests };
}

test('geometry external requests reject duplicate names, excess queries and executable expression fields before rendering', async () => {
  const f = fixture(success());
  for (const geometryQueries of [[query, query], Array.from({ length: 9 }, (_, i) => ({ ...query, name: `q${i}` })), [{ ...query, expression: 'window.secret' }]]) {
    assert.equal((await f.run({ geometryQueries })).body.status, 'invalid_request');
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.checks.length, 0);
});

test('text-only geometry observations retain exact source/frame/window binding without claiming sight', async () => {
  const f = fixture(success());
  const { result, body } = await f.run();
  assert.equal(body.status, 'ok');
  assert.equal(body.imageDelivery, 'not_authorized');
  assert.equal(result.contentBlocks, undefined);
  assert.deepEqual(f.requests[0]?.geometryQueries, [query]);
  assert.deepEqual(body.renderedCheck.frames[0]?.geometrySample, sample(0));
  assert.deepEqual(body.renderedCheck, f.checks[0]);
  assert.equal(body.renderedCheck.sourceHash, 'source-hash');
  assert.equal(body.renderedCheck.frames[0]?.contentHash, 'hash-0');
  assert.match(body.renderedCheck.geometryScope!, /Comparison-stage.*viewport CSS pixels.*not an exact screenshot instant/);
  assert.doesNotMatch(JSON.stringify(body.renderedCheck), /private|pngPath|delivered|seen/);
});

test('missing, wrong identity, missing observation and reversed collection window cannot become geometry measurements', async () => {
  for (const corruption of ['missing', 'identity', 'short', 'time'] as const) {
    const rendered = success();
    const first = rendered.frames[0]!;
    if (corruption === 'missing') delete first.geometrySample;
    else if (corruption === 'identity') first.geometrySample!.observations[0]!.selector = '#other';
    else if (corruption === 'short') first.geometrySample!.observations = [];
    else first.geometrySample!.finishedAtMs = 0;
    const { body } = await fixture(rendered).run();
    assert.equal(body.status, 'ok');
    assert.equal(body.renderedCheck.frames[0]?.geometrySample, undefined);
    assert.match(String(body.renderedCheck.frames[0]?.geometryUnavailable), /no measurement|discarded/);
    assert.deepEqual(body.renderedCheck.frames[1]?.geometrySample, sample(500));
  }
});

test('same PNG, media registration failure and cancellation retain actual observations without certifying a completed render', async () => {
  for (const [same, failed, expected] of [[true, false, 'motion_not_proven'], [false, true, 'capture_failed']] as const) {
    const { body } = await fixture(success(same), failed).run();
    assert.equal(body.status, expected);
    assert.deepEqual(body.renderedCheck.frames[0]?.geometrySample, sample(0));
  }
  const controller = new AbortController();
  const f = fixture(success(), false, () => controller.abort());
  const { body } = await f.run({}, controller.signal);
  assert.equal(body.status, 'cancelled');
  assert.deepEqual(body.renderedCheck.frames[0]?.geometrySample, sample(0));
  const pre = fixture(success());
  assert.equal((await pre.run({}, controller.signal)).body.status, 'cancelled');
  assert.equal(pre.requests.length, 0);
});

test('unsolicited renderer geometry never changes legacy no-query checks', async () => {
  const { body } = await fixture(success()).run({ geometryQueries: undefined });
  assert.equal(body.renderedCheck.geometryScope, undefined);
  assert.equal(body.renderedCheck.geometryQueries, undefined);
  assert.equal(body.renderedCheck.frames[0]?.geometrySample, undefined);
  assert.equal(body.renderedCheck.frames[0]?.geometryUnavailable, undefined);
});

test('standard persisted tool events reconstruct actual geometry text for a text-only model after reopening', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-geometry-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'exp-geometry');
  await store.acquireWriter();
  const f = fixture(success());
  const host = new AgentHost({ inputCapabilities: ['text'], createSession: input => ({
    inputCapabilities: ['text'], append: async ({ signal }) => {
      await input.onModelRequest!({ model: 'text', digest: sha256('first'), messageCount: 1, images: [] });
      const result = await input.tools[0]!.execute(f.params, signal);
      assert.equal(result.contentBlocks, undefined);
      assert.match(result.content, /viewport_css_pixels/);
      await input.onModelRequest!({ model: 'text', digest: sha256('after-geometry'), messageCount: 3, images: [] });
      return '{"ok":true}';
    }, cancel() {},
  }) });
  const outcome = await host.request({ role: 'comparison', systemPrompt: 'Compare', allowModelText: true,
    schema: Type.Object({ ok: Type.Boolean() }), timeoutMs: 0, maxRepairAttempts: 0, promptContent: 'Measure',
    tools: [f.tool], audit: experimentAgentAuditSink(store, 'run-geometry') });
  assert.equal(outcome.status, 'completed');
  await store.close();
  const reopened = await ExperimentStore.open(root, 'exp-geometry');
  t.after(() => reopened.close());
  const rebuilt = await reconstructModelRequests(reopened.events(), experimentModelInputResolver(reopened, 'run-geometry'));
  assert.equal(rebuilt.diagnostic, undefined);
  assert.equal(rebuilt.requests.at(-1)?.contentComplete, true);
  assert.deepEqual(rebuilt.requests.at(-1)?.nativeImages, []);
  const messages = JSON.stringify(rebuilt.requests.at(-1)?.messages);
  assert.match(messages, /viewport_css_pixels/);
  assert.match(messages, /source-hash/);
  assert.match(messages, /startedAtMs/);
  assert.match(messages, /screenPoints/);
  assert.match(messages, /72/);
});
