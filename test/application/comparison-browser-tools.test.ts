import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Value } from '@sinclair/typebox/value';
import { ComparisonRenderMeasurementDocumentSchema } from '../../src/core/schema.js';
import { createRenderArtifactTool, type ComparisonRenderedCheck } from '../../src/application/comparison-render-tools.js';
import { renderFrozenArtifact } from '../../src/infrastructure/artifact-renderer.js';
import { DEFAULT_RENDER_VIEWPORT } from '../../src/infrastructure/artifact-render-types.js';
import { createEphemeralRenderCatalog } from './comparison-render-catalog-ephemeral.js';
import { comparisonOrientation } from '../../src/application/comparison-briefing.js';

test('orientation presents both deliveries before process navigation without treating leads as certified outcomes', () => {
  const text = comparisonOrientation({ briefingRoot: 'unused', indexMarkdown: 'PROCESS NAVIGATION', baselineAvailable: true, candidateAvailable: true,
    links: [{ side: 'baseline', inspectPath: 'finals/a.txt', shortRef: 'ev-01' }, { side: 'candidate', inspectPath: 'candidate/b.csv', shortRef: 'ev-02' }] });
  assert.ok(text.indexOf('initial-input.txt') < text.indexOf('ev-01'));
  assert.ok(text.indexOf('ev-02') < text.indexOf('PROCESS NAVIGATION'));
  assert.match(text, /not certified final versions/);
  assert.match(text, /Follow-up requirements may change/);
});

test('raster rejects browser actions rather than silently pretending to exercise them', async () => {
  const base = { bundleRoot: '.', entryRelativePath: 'image.png', viewport: DEFAULT_RENDER_VIEWPORT,
    outputRoot: '.', sampleTimesMs: [0], signal: new AbortController().signal };
  for (const options of [{ actions: [{ kind: 'inspect' as const, selector: 'body' }] }, { media: { reducedMotion: 'reduce' as const } }]) {
    const result = await renderFrozenArtifact({ ...base, ...options });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.kind, 'invalid_request');
  }
});

test('opt-in real browser tool checks interactions, preferences, fresh replay and external blocking', async t => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== '1') { t.skip('set REPRISE_OPT_IN_BROWSER_RENDER=1'); return; }
  const root = await mkdtemp(join(tmpdir(), 'reprise-browser-actions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let hits = 0;
  const external = createServer((_req, res) => { hits++; res.end('unexpected'); });
  await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => external.close(error => error ? reject(error) : resolve())));
  const address = external.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(join(root, 'index.html'), `<!doctype html><html><body>
    <button id="toggle">0</button><input id="name" value="old"><p id="prefs"></p>
    <button id="fetch">Network</button><div style="height:1800px"></div><p id="bottom">Bottom</p>
    <script>
      const b=document.querySelector('#toggle'); b.onclick=()=>b.textContent=String(Number(b.textContent)+1);
      document.querySelector('#prefs').textContent=matchMedia('(prefers-reduced-motion: reduce)').matches+':'+matchMedia('(prefers-color-scheme: dark)').matches;
      document.querySelector('#fetch').onclick=()=>fetch('http://127.0.0.1:${address.port}/blocked').catch(()=>{});
    </script></body></html>`);
  const catalog = createEphemeralRenderCatalog({ sources: [{ sourceRef: 'ev-01', side: 'candidate', bundleRoot: root,
    entryRelativePath: 'index.html', contentHash: 'fixture', origin: 'candidate' }], mediaRoot: join(root, 'media'), reviewRoot: join(root, 'review') });
  const checks: ComparisonRenderedCheck[] = [];
  const tool = createRenderArtifactTool({ attemptRoot: root, catalog, onRenderedCheck: check => { checks.push(check); } });
  const result = JSON.parse((await tool.execute({ sourceRef: 'ev-01', media: { reducedMotion: 'reduce', colorScheme: 'dark' },
    actions: [{ kind: 'inspect', selector: '#prefs' }, { kind: 'click', selector: '#toggle' },
      { kind: 'inspect', selector: '#toggle' }, { kind: 'key', key: 'Enter' }, { kind: 'inspect', selector: '#toggle' },
      { kind: 'fill', selector: '#name', text: '新的内容' }, { kind: 'inspect', selector: '#name' },
      { kind: 'click', selector: '#fetch' }, { kind: 'wait', ms: 100 },
      { kind: 'scroll', x: 0, y: 1000 }, { kind: 'wait', ms: 100 }, { kind: 'inspect', selector: '#bottom' }],
  }, AbortSignal.timeout(45000))).content) as { status: string; media: unknown[] };
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const observations = checks[0]!.browserObservations!;
  assert.equal(observations.find(o => o.actionIndex === 0)?.text, 'true:true');
  assert.equal(observations.find(o => o.actionIndex === 2)?.text, '1');
  assert.equal(observations.find(o => o.actionIndex === 4)?.text, '2');
  assert.equal(observations.find(o => o.actionIndex === 6)?.value, '新的内容');
  assert.ok(observations.find(o => o.actionIndex === 11)!.rect.y < 1800);
  assert.equal(hits, 0);
  assert.ok(result.media.length > 0);
  assert.equal(Value.Check(ComparisonRenderMeasurementDocumentSchema, { schemaVersion: 1, renderedCheck: checks[0], payload: {} }), true);
  const again = JSON.parse((await tool.execute({ sourceRef: 'ev-01', actions: [{ kind: 'inspect', selector: '#toggle' }] }, AbortSignal.timeout(45000))).content) as { status: string };
  assert.equal(again.status, 'ok');
  assert.equal(checks[1]!.browserObservations![0]?.text, '0');
  const ambiguous = JSON.parse((await tool.execute({ sourceRef: 'ev-01', actions: [{ kind: 'click', selector: 'button' }] }, AbortSignal.timeout(45000))).content) as { status: string; failure: { message: string } };
  assert.equal(ambiguous.status, 'capture_failed');
  assert.match(ambiguous.failure.message, /one visible enabled/);
});
