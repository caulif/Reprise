import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { createComparisonRenderCatalogPort } from '../../src/application/comparison-render-catalog.js';
import { createRenderArtifactTool } from '../../src/application/comparison-render-tools.js';

test('opt-in browser registers each frame with its own scroll and document height', async t => {
  if (process.env.REPRISE_OPT_IN_BROWSER_RENDER !== '1') {
    t.skip('set REPRISE_OPT_IN_BROWSER_RENDER=1 for live browser capture');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'reprise-frame-layout-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const finals = join(root, 'finals');
  await mkdir(finals);
  await writeFile(join(finals, 'scroll.html'), `<!doctype html><html><body style="margin:0">
    <div style="height:1000px;background:red">TOP</div><div id="tail" style="height:1000px;background:blue">BOTTOM</div>
    <script>setTimeout(() => { document.getElementById('tail').style.height = '2000px'; scrollTo(0, 1000); }, 1500)</script>
    </body></html>`);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptId: 'frame-layout', attemptRoot: root,
    links: [{ side: 'baseline', inspectPath: 'finals/scroll.html', shortRef: 'ev-01' }], media: [] });
  const port = createComparisonRenderCatalogPort({ catalog, attemptRoot: root,
    mounts: { finals, candidate: join(root, 'candidate'), history: join(root, 'history'), evidence: join(root, 'evidence') } });
  const result = await createRenderArtifactTool({ catalog: port, attemptRoot: root }).execute({
    sourceRef: 'ev-01', sampleTimesMs: [0, 2500], viewport: { width: 1200, height: 760 },
  }, AbortSignal.timeout(45_000));
  const media = catalog.snapshot().media;
  assert.equal(media.length, 2, result.content);
  assert.notEqual(media[0]!.contentHash, media[1]!.contentHash);
  assert.deepEqual(media.map(frame => frame.derivation?.scrollOffset), [{ x: 0, y: 0 }, { x: 0, y: 1000 }]);
  assert.deepEqual(media.map(frame => frame.derivation?.documentHeight), [2000, 3000]);
});
