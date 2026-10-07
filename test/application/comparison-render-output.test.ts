import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Value } from '@sinclair/typebox/value';
import { ComparisonRenderMeasurementDocumentSchema } from '../../src/core/schema.js';
import { boundedRenderOutput, comparisonToolTextBytes } from '../../src/application/comparison-render-output.js';
import type { ComparisonRenderedCheck, ComparisonRenderCatalogPort } from '../../src/application/comparison-render-tools.js';
import { prunePiMessagesForBudget } from '../../src/infrastructure/agent/compaction.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { createComparisonRenderCatalogPort } from '../../src/application/comparison-render-catalog.js';
import { readComparisonJsonPages } from './comparison-paged-json-reader.js';
import { sha256 } from '../../src/core/identity.js';

function check(count = 4): ComparisonRenderedCheck {
  return { sourceRef: 'ev-01', sourceHash: 'a'.repeat(64), side: 'candidate', status: 'ok',
    viewport: { width: 1000, height: 700, scale: 1 }, requestedSampleTimesMs: Array.from({ length: count }, (_, i) => i * 500),
    frames: Array.from({ length: count }, (_, i) => ({ sampleTimeMs: i * 500, actualTimeMs: i * 500 + 7, contentHash: 'b'.repeat(64),
      geometrySample: { schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: i * 500 + 8, finishedAtMs: i * 500 + 9,
        observations: Array.from({ length: 6 }, (_, n) => ({ name: `point${n}`, selector: `#element${n}`, kind: 'svg_geometry' as const, status: 'ok' as const,
          bounds: { x: 1, y: 2, width: 3, height: 4 }, localPoints: [{ name: 'end', x: 1, y: 2 }],
          screenPoints: [{ name: 'end', x: 72 + n, y: 200 + i }], matrix: { a: 1, b: 0, c: 0, d: 1, e: 71, f: 198 + i } })),
      } })),
  };
}

function catalogFixture(revision: () => number): ComparisonRenderCatalogPort {
  return { revision, resolveSource: async () => undefined,
    registerDerivedMedia: async () => ({ ok: false, code: 'not_used', message: 'Not used in output projection' }),
    registerDerivedMediaBatch: async () => ({ ok: false, code: 'not_used', message: 'Not used in output projection' }) };
}

test('production analysis registration binds the saved JSON to its original source and exposes rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'render-output-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const finals = join(root, 'finals');
  await mkdir(finals);
  await writeFile(join(finals, 'card.html'), '<html><body>Card</body></html>');
  const evidence = await ComparisonEvidenceCatalog.create({ attemptId: 'attempt', attemptRoot: root,
    links: [{ side: 'candidate', inspectPath: 'finals/card.html', shortRef: 'ev-01', origin: 'candidate_delivery' }], media: [] });
  const catalog = createComparisonRenderCatalogPort({ catalog: evidence, attemptRoot: root,
    mounts: { finals, candidate: join(root, 'candidate'), history: join(root, 'history'), evidence: join(root, 'evidence') } });
  const source = await catalog.resolveSource('ev-01');
  assert.ok(source);
  const original = check(); original.sourceHash = source.contentHash;
  const output = await boundedRenderOutput({ payload: { padding: 'x'.repeat(20_000) }, check: original,
    attemptRoot: root, catalog, signal: new AbortController().signal });
  const full = output.fullMeasurement as { evidenceRef: string; contentHash: string; path: string };
  const registered = evidence.snapshot().links.find(link => link.shortRef === full.evidenceRef);
  assert.ok(registered);
  assert.deepEqual(registered.sourceRefs, ['ev-01']);
  assert.equal(registered.contentHash, full.contentHash);
  const relativePath = full.path.slice('scratch/'.length);
  const failed = await catalog.registerAnalysisEvidence!({ relativePath, sourceRef: 'ev-99' }, new AbortController().signal);
  assert.equal(failed.code, 'missing_source');
});

test('large render output retains decisive screen points inline and the complete schema-checked document in paged evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'render-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let revision = 3;
  let registeredPath = '';
  const catalog: ComparisonRenderCatalogPort = { ...catalogFixture(() => revision), registerAnalysisEvidence: async entry => {
    assert.equal(entry.sourceRef, 'ev-01'); registeredPath = entry.relativePath; revision++; return { shortRef: 'ev-09' };
  } };
  const original = check();
  const payload = { diagnostics: ['x'.repeat(20_000)], media: [{ shortRef: 'media-01' }] };
  const output = await boundedRenderOutput({ payload, check: original, attemptRoot: root, catalog, signal: new AbortController().signal });
  const text = JSON.stringify(output);
  assert.ok(comparisonToolTextBytes(output) <= 10_240);
  assert.match(text, /"x":72/);
  assert.match(text, /"coordinateDomain":"viewport_css_pixels"/);
  assert.match(text, /"inlineGeometryFrames":4/);
  assert.match(text, /"omittedGeometryFrames":0/);
  assert.equal(output.revision, 4);
  const full: unknown = JSON.parse(await readFile(join(root, 'scratch', registeredPath), 'utf8'));
  assert.ok(Value.Check(ComparisonRenderMeasurementDocumentSchema, full));
  assert.deepEqual(full.renderedCheck, original);
  assert.deepEqual(full.payload, payload);
  const messages: AgentMessage[] = [{ role: 'toolResult', toolName: 'render_artifact', toolCallId: 'call', timestamp: 0, isError: false, content: [{ type: 'text', text }] }];
  assert.equal(prunePiMessagesForBudget(messages).changed, false);
});

test('overflow explicitly counts omitted inline states; failed registration preserves readable full values and unknown statuses', async t => {
  const root = await mkdtemp(join(tmpdir(), 'render-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = check(8);
  for (const frame of original.frames) for (const observation of frame.geometrySample!.observations) observation.selector = '#x'.padEnd(160, 'a');
  const frame = original.frames[0]!;
  frame.geometrySample!.observations[0] = { name: 'missing', selector: '#missing', kind: 'svg_geometry', status: 'missing' };
  const catalog: ComparisonRenderCatalogPort = { ...catalogFixture(() => 2), registerAnalysisEvidence: async () => ({ code: 'missing_source', message: 'Source unavailable' }) };
  const output = await boundedRenderOutput({ payload: {}, check: original, attemptRoot: root, catalog, signal: new AbortController().signal });
  assert.ok(comparisonToolTextBytes(output) <= 10_240);
  assert.ok(Number(output.omittedGeometryFrames) > 0);
  const fullMeasurement = output.fullMeasurement as { path: string; registration: string; registrationCode: string };
  assert.equal(fullMeasurement.registration, 'unavailable');
  assert.equal(fullMeasurement.registrationCode, 'missing_source');
  const full: unknown = JSON.parse(await readFile(join(root, fullMeasurement.path), 'utf8'));
  assert.ok(Value.Check(ComparisonRenderMeasurementDocumentSchema, full));
  assert.deepEqual(full.renderedCheck.frames[0]!.geometrySample!.observations[0], frame.geometrySample!.observations[0]);
});

test('small results stay complete; malformed persisted geometry and cancelled writes fail explicitly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'render-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = catalogFixture(() => 0);
  const small = check(1);
  assert.deepEqual(await boundedRenderOutput({ payload: {}, check: small, attemptRoot: root, catalog, signal: new AbortController().signal }), { renderedCheck: small });
  const bad = check(); bad.frames[0]!.geometrySample!.finishedAtMs = NaN;
  await assert.rejects(boundedRenderOutput({ payload: { padding: 'x'.repeat(20_000) }, check: bad, attemptRoot: root, catalog, signal: new AbortController().signal }), /Invalid persisted/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedRenderOutput({ payload: { padding: 'x'.repeat(20_000) }, check: check(), attemptRoot: root, catalog, signal: controller.signal }));
  const unregistered = await boundedRenderOutput({ payload: { padding: 'x'.repeat(20_000) }, check: check(), attemptRoot: root, catalog, signal: new AbortController().signal });
  assert.match(JSON.stringify(unregistered), /"registrationCode":"port_unavailable"/);
  const unavailable = check(1);
  delete unavailable.frames[0]!.geometrySample;
  unavailable.frames[0]!.geometryUnavailable = 'No sample was returned; this is unknown.';
  const unknown = await boundedRenderOutput({ payload: { padding: 'x'.repeat(20_000) }, check: unavailable, attemptRoot: root, catalog, signal: new AbortController().signal });
  assert.match(JSON.stringify(unknown), /No sample was returned; this is unknown/);
  assert.equal(unknown.inlineGeometryFrames, 0);
  await assert.rejects(boundedRenderOutput({ payload: { media: 'x'.repeat(20_000) }, check: check(), attemptRoot: root, catalog, signal: new AbortController().signal }), /inventory exceeds/);
});

test('real byte-range read reconstructs complete render JSON containing Chinese and emoji without replacement characters', async t => {
  const root = await mkdtemp(join(tmpdir(), 'render-output-unicode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = check();
  original.frames[0]!.geometrySample!.observations[0]!.selector = '#车轮🚲';
  const payload = { diagnostics: ['中文🚲'.repeat(4000)], label: '完整测量🌍', surrogate: `Unpaired ${String.fromCharCode(0xd800)} and paired 🌍` };
  const output = await boundedRenderOutput({ payload, check: original, attemptRoot: root,
    catalog: catalogFixture(() => 0), signal: new AbortController().signal });
  const full = output.fullMeasurement as { path: string; contentHash: string; byteLength: number };
  const pages = await readComparisonJsonPages(root, full.path);
  const reconstructed: unknown = JSON.parse(pages);
  assert.ok(Value.Check(ComparisonRenderMeasurementDocumentSchema, reconstructed));
  assert.deepEqual(reconstructed.renderedCheck, original);
  assert.deepEqual(reconstructed.payload, payload);
  const bytes = await readFile(join(root, full.path));
  assert.equal(full.byteLength, bytes.byteLength);
  assert.equal(full.contentHash, sha256(bytes));
});
