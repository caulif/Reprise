import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGeometrySample, createGeometryWorld, validateGeometrySample, validGeometryQueries } from '../../src/infrastructure/artifact-geometry.js';
import { renderFrozenArtifact } from '../../src/infrastructure/artifact-renderer.js';
import type { CdpSession } from '../../src/infrastructure/artifact-cdp.js';
import type { RenderGeometryQuery } from '../../src/core/schema.js';

const query: RenderGeometryQuery = { name: 'line', selector: '#line', kind: 'svg_geometry' };
const validSample = () => ({ schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: 2, finishedAtMs: 3,
  observations: [{ ...query, tagName: 'line', status: 'ok', bounds: { x: 10, y: 20, width: 6, height: 8 },
    localPoints: [{ name: 'start', x: 0, y: 0 }, { name: 'end', x: 3, y: 4 }],
    screenPoints: [{ name: 'start', x: 10, y: 20 }, { name: 'end', x: 16, y: 28 }],
    matrix: { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 } }] });

test('selector diagnostics are bounded, bound to failure status and never treated as measurements', () => {
  const candidate = { tagName: 'line', elementId: '<untrusted>', parentId: 'group' };
  const sample = (status: string, matchCount: number, candidates: unknown[]) => ({ ...validSample(),
    observations: [{ ...query, status, selectorDiagnostics: { matchCount, candidates } }] });
  assert.equal(validateGeometrySample(sample('missing', 0, []), [query], 0).observations[0]!.status, 'missing');
  assert.equal(validateGeometrySample(sample('ambiguous', 6, Array(4).fill(candidate)), [query], 0).observations[0]!.status, 'ambiguous');
  for (const invalid of [sample('missing', 1, [candidate]), sample('ambiguous', 1, [candidate]),
    sample('unsupported', 2, [candidate, candidate]), sample('ambiguous', 5, Array(5).fill(candidate)),
    sample('ambiguous', 2, [{ ...candidate, elementId: 'x'.repeat(65) }, candidate]), sample('ambiguous', 2, [candidate])]) {
    assert.throws(() => validateGeometrySample(invalid, [query], 0));
  }
});

test('geometry sample rejects unbound queries, bad matrix mappings, timing and nonfinite values', () => {
  assert.equal(validateGeometrySample(validSample(), [query], 1).observations[0]!.status, 'ok');
  for (const mutate of [
    (sample: ReturnType<typeof validSample>) => { sample.observations[0]!.selector = '#other'; },
    (sample: ReturnType<typeof validSample>) => { sample.observations[0]!.matrix.e = 11; },
    (sample: ReturnType<typeof validSample>) => { sample.observations[0]!.screenPoints[0]!.x = Infinity; },
    (sample: ReturnType<typeof validSample>) => { sample.observations[0]!.localPoints[0]!.name = 'target'; },
    (sample: ReturnType<typeof validSample>) => { sample.finishedAtMs = 1; },
  ]) {
    const sample = validSample(); mutate(sample);
    assert.throws(() => validateGeometrySample(sample, [query], 1));
  }
  assert.throws(() => validateGeometrySample(validSample(), [query], 4));
  assert.throws(() => validateGeometrySample({ ...validSample(), extra: 'x'.repeat(20_000) }, [query], 0));
  assert.equal(validGeometryQueries([query, query]), false);
  assert.equal(validGeometryQueries(Array.from({ length: 9 }, (_, i) => ({ ...query, name: String(i) }))), false);
  assert.equal(validGeometryQueries([{ ...query, selector: 'x'.repeat(161) }]), false);
  const domQuery: RenderGeometryQuery = { ...query, kind: 'dom_rect' };
  const dom = { schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: 2, finishedAtMs: 3,
    observations: [{ ...domQuery, status: 'ok', bounds: { x: 1, y: 2, width: 3, height: 4 }, screenPoints: [
      { name: 'top_left', x: 1, y: 2 }, { name: 'top_right', x: 4, y: 2 }, { name: 'bottom_right', x: 4, y: 6 }, { name: 'bottom_left', x: 1, y: 6 },
    ] }] };
  assert.equal(validateGeometrySample(dom, [domQuery], 0).observations[0]!.status, 'ok');
  dom.observations[0]!.screenPoints[2]!.x = 5;
  assert.throws(() => validateGeometrySample(dom, [domQuery], 0), /rectangle mapping/);
});

test('geometry evaluator uses isolated context, escapes selectors and honors cancellation', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const hostile = { ...query, selector: String.raw`[id="x\";globalThis.pwn=1;//"]` };
  const session: CdpSession = { diagnostics: [], close: async () => {}, on: () => () => {},
    send: async <T>(method: string, params?: Record<string, unknown>) => {
      calls.push({ method, ...(params ? { params } : {}) });
      return (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } }
        : method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
        : { result: { value: { schemaVersion: 1, coordinateDomain: 'viewport_css_pixels', startedAtMs: 2, finishedAtMs: 3, observations: [{ ...hostile, status: 'invalid_selector' }] } } }) as T;
    } };
  const context = await createGeometryWorld(session, 'page');
  await collectGeometrySample(session, 'page', context, [hostile], 0, 1, new AbortController().signal);
  assert.equal(calls[2]!.params!.contextId, 7);
  assert.ok(String(calls[2]!.params!.expression).includes(JSON.stringify([hostile])));
  await assert.rejects(collectGeometrySample(session, 'page', context, [query], 0, 0, AbortSignal.abort()), /cancelled/);
  assert.equal(calls.length, 3);
});

test('raster geometry requests fail explicitly without starting browser', async () => {
  const result = await renderFrozenArtifact({ bundleRoot: '.', entryRelativePath: 'picture.png', viewport: { width: 320, height: 240, scale: 1 }, sampleTimesMs: [0], outputRoot: '.', signal: new AbortController().signal, geometryQueries: [query] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.kind, 'invalid_request');
});

test('opt-in geometry observes nested viewBox and parent transforms despite page prototype overrides', async t => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== '1') { t.skip('set REPRISE_OPT_IN_BROWSER_RENDER=1 for local browser'); return; }
  const root = await mkdtemp(join(tmpdir(), 'reprise-geometry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), `<!doctype html><style>body{margin:0}svg{display:block}#box{width:20px;height:30px;transform:translate(7px,9px)}</style>
    <svg width="320" height="240" viewBox="0 0 160 120"><g transform="translate(10 20)"><svg x="5" y="6" width="100" height="80" viewBox="0 0 50 40"><g transform="translate(3 4)"><line id="line" x1="1" y1="2" x2="4" y2="6" stroke="black"/><circle id="circle" cx="2" cy="3" r="1"/><path id="path" d="M1 2L4 6" stroke="black"/></g></svg></g><line class="duplicate"/><line class="duplicate"/><line id="hidden" style="display:none"/></svg><div id="box"></div>
    <script>SVGGraphicsElement.prototype.getScreenCTM=()=>new DOMMatrix();Element.prototype.getBoundingClientRect=()=>({x:0,y:0,width:0,height:0});Document.prototype.querySelectorAll=()=>[];performance.now=()=>0;</script>`);
  const queries: RenderGeometryQuery[] = [query, { ...query, name: 'circle', selector: '#circle' }, { ...query, name: 'path', selector: '#path' },
    { name: 'box', selector: '#box', kind: 'dom_rect' }, { ...query, name: 'missing', selector: '#missing' }, { ...query, name: 'multiple', selector: '.duplicate' }, { ...query, name: 'bad', selector: '[' }, { ...query, name: 'hidden', selector: '#hidden' }];
  const result = await renderFrozenArtifact({ bundleRoot: root, entryRelativePath: 'index.html', viewport: { width: 320, height: 240, scale: 1 }, sampleTimesMs: [0, 10], outputRoot: join(root, 'out'), signal: AbortSignal.timeout(45_000), geometryQueries: queries });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  for (const frame of result.frames) {
    const sample = frame.geometrySample!;
    assert.ok(sample.startedAtMs >= frame.actualTimeMs);
    const line = sample.observations[0]!;
    assert.equal(line.status, 'ok');
    if (line.status !== 'ok' || line.kind !== 'svg_geometry') return;
    assert.deepEqual(line.localPoints, [{ name: 'start', x: 1, y: 2 }, { name: 'end', x: 4, y: 6 }]);
    assert.deepEqual(line.screenPoints, [{ name: 'start', x: 46, y: 76 }, { name: 'end', x: 58, y: 92 }]);
    assert.deepEqual(sample.observations.slice(4).map(o => o.status), ['missing', 'ambiguous', 'invalid_selector', 'unavailable']);
    const missing = sample.observations[4]!, ambiguous = sample.observations[5]!;
    if (missing.status !== 'ok') assert.deepEqual(missing.selectorDiagnostics, { matchCount: 0, candidates: [] });
    if (ambiguous.status !== 'ok') assert.deepEqual(ambiguous.selectorDiagnostics, { matchCount: 2, candidates: [
      { tagName: 'line', elementId: '', parentId: '' }, { tagName: 'line', elementId: '', parentId: '' },
    ] });
    const box = sample.observations[3]!;
    assert.equal(box.status, 'ok');
    if (box.status === 'ok') assert.deepEqual(box.bounds, { x: 7, y: 249, width: 20, height: 30 });
    assert.equal(sample.observations[1]!.status, 'ok');
    assert.equal(sample.observations[2]!.status, 'ok');
  }
});

test('opt-in geometry exposes moving parent output despite identical local endpoints', async t => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== '1') { t.skip('set REPRISE_OPT_IN_BROWSER_RENDER=1 for local browser'); return; }
  const root = await mkdtemp(join(tmpdir(), 'reprise-geometry-motion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), `<!doctype html><style>body{margin:0}svg{display:block}</style>
    <svg width="320" height="240"><g transform="translate(20 30)"><g id="moving"><line id="line" x1="0" y1="0" x2="10" y2="15" stroke="black"/></g></g></svg>
    <script>const started=performance.now();function tick(){document.getElementById('moving').style.transform=performance.now()-started<300?'translate(0px,0px)':'translate(100px,50px)';requestAnimationFrame(tick)}tick();</script>`);
  const result = await renderFrozenArtifact({ bundleRoot: root, entryRelativePath: 'index.html', viewport: { width: 320, height: 240, scale: 1 }, sampleTimesMs: [0, 500], outputRoot: join(root, 'out'), signal: AbortSignal.timeout(45_000), geometryQueries: [query] });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const observations = result.frames.map(frame => frame.geometrySample!.observations[0]!);
  const first = observations[0]!, second = observations[1]!;
  assert.equal(first.status, 'ok'); assert.equal(second.status, 'ok');
  if (first.status !== 'ok' || second.status !== 'ok' || first.kind !== 'svg_geometry' || second.kind !== 'svg_geometry') return;
  assert.deepEqual(first.localPoints, second.localPoints);
  assert.deepEqual(first.screenPoints, [{ name: 'start', x: 20, y: 30 }, { name: 'end', x: 30, y: 45 }]);
  assert.deepEqual(second.screenPoints, [{ name: 'start', x: 120, y: 80 }, { name: 'end', x: 130, y: 95 }]);
  assert.equal(second.screenPoints[1]!.x - first.screenPoints[1]!.x, 100);
  assert.equal(second.screenPoints[1]!.y - first.screenPoints[1]!.y, 50);
  assert.notEqual(result.frames[0]!.contentHash, result.frames[1]!.contentHash);
});

test('opt-in geometry measures used CSS and percentage shapes instead of overridden SVG attributes', async t => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== '1') { t.skip('set REPRISE_OPT_IN_BROWSER_RENDER=1 for local browser'); return; }
  const root = await mkdtemp(join(tmpdir(), 'reprise-geometry-css-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), `<!doctype html><style>body{margin:0}svg{display:block}#circle{cx:80px;cy:60px;r:10px}#ellipse{cx:50%;cy:50%;rx:10%;ry:20%}#path{d:path('M40 50 L60 70')}#three{width:10px;height:10px;transform:rotateX(30deg)}</style>
    <svg width="320" height="240"><g transform="translate(5 7)"><circle id="circle" cx="1" cy="2" r="3"/><ellipse id="ellipse" cx="1" cy="2" rx="3" ry="4"/><path id="path" d="M1 2L3 4" stroke="black"/></g></svg><div id="three"></div>
    <script>SVGGraphicsElement.prototype.getBBox=()=>({x:0,y:0,width:2,height:2});</script>`);
  const queries: RenderGeometryQuery[] = [{ ...query, name: 'circle', selector: '#circle' }, { ...query, name: 'ellipse', selector: '#ellipse' }, { ...query, name: 'path', selector: '#path' }, { name: 'three', selector: '#three', kind: 'dom_rect' }];
  const result = await renderFrozenArtifact({ bundleRoot: root, entryRelativePath: 'index.html', viewport: { width: 320, height: 240, scale: 1 }, sampleTimesMs: [0], outputRoot: join(root, 'out'), signal: AbortSignal.timeout(45_000), geometryQueries: queries });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const observations = result.frames[0]!.geometrySample!.observations;
  const circle = observations[0]!, ellipse = observations[1]!, path = observations[2]!;
  assert.equal(circle.status, 'ok'); assert.equal(ellipse.status, 'ok'); assert.equal(path.status, 'ok');
  if (circle.status !== 'ok' || circle.kind !== 'svg_geometry' || ellipse.status !== 'ok' || ellipse.kind !== 'svg_geometry' || path.status !== 'ok' || path.kind !== 'svg_geometry') return;
  assert.deepEqual(circle.localPoints, [{ name: 'center', x: 80, y: 60 }, { name: 'x_radius', x: 90, y: 60 }, { name: 'y_radius', x: 80, y: 70 }]);
  assert.deepEqual(circle.screenPoints[0], { name: 'center', x: 85, y: 67 });
  assert.deepEqual(circle.bounds, { x: 75, y: 57, width: 20, height: 20 });
  assert.deepEqual(ellipse.localPoints, [{ name: 'center', x: 160, y: 120 }, { name: 'x_radius', x: 192, y: 120 }, { name: 'y_radius', x: 160, y: 168 }]);
  assert.deepEqual(path.localPoints, [{ name: 'start', x: 40, y: 50 }, { name: 'end', x: 60, y: 70 }]);
  assert.equal(observations[3]!.status, 'unsupported');
});
