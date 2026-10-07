import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComparisonReportFacts } from '../../src/agents/comparison-agent.js';
import { renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';
import { verifyAndRenderComparisonReport } from '../../src/application/comparison-publication.js';
import { reportString } from '../../src/application/comparison-report-strings.js';
import { sha256 } from '../../src/core/identity.js';

const facts: ComparisonReportFacts = {
  run: { runId: 'run-1', outcome: 'completed', terminationCode: 'controller.satisfied', initiatedBy: 'controller' },
  models: { baseline: 'baseline-model', candidate: 'candidate-model' },
  activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
  delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'unknown' },
  replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' },
};
function shell(comparison: string, locale: 'zh' | 'en' = 'zh') {
  return renderComparisonReportShell({ task: 'Compare', facts, metrics: {}, locale,
    slots: { headline: 'A scoped comparison', comparison } });
}
const input = { facts, result: { status: 'completed' as const, reportPath: 'report.html' as const, evidenceRefs: [] },
  attemptRoot: '.', media: [], evidence: [], hostTask: 'Compare' };

test('plain visual wording does not turn negation, quotation, advice or affirmation into a Host semantic claim', async () => {
  for (const [locale, prose] of [
    ['zh', '本报告不含视觉检查，只依据源码。'], ['zh', '未做视觉检查，也没看过PPT。'],
    ['zh', '历史声称“已完成视觉检查”，这只是引述。'], ['zh', '建议后续做视觉检查。'],
    ['en', 'No visual inspection was performed.'], ['en', 'The model said “completed visual inspection”.'],
    ['en', 'Future visual inspection is recommended.'], ['en', 'I completed visual inspection.'],
  ] as const) {
    const verified = await verifyAndRenderComparisonReport({ ...input, locale, html: shell(`<p>${prose}</p>`, locale) });
    assert.ok('html' in verified, JSON.stringify(verified));
    assert.doesNotMatch(verified.html, /data-host-limitation|claimed visual inspection without/);
    assert.ok(verified.html.includes(prose));
  }
});

test('explicit visual claims still fail without registered and actually delivered media', async () => {
  const html = shell('<p data-claim="visual" data-media-ref="media-01">The wheel is red.</p>');
  const missing = await verifyAndRenderComparisonReport({ ...input, html });
  assert.ok('failureClass' in missing);
  assert.equal(missing.code, 'media_unavailable');
  const undelivered = await verifyAndRenderComparisonReport({ ...input, html,
    media: [{ ref: 'artifact:wheel', shortRef: 'media-01', side: 'candidate', inspectPath: 'media/wheel.png',
      reportHref: 'media/wheel.png', mediaType: 'image/png', available: true, contentHash: 'a'.repeat(64) }],
    deliveredImageContentHashes: new Set() });
  assert.ok('failureClass' in undelivered);
  assert.equal(undelivered.code, 'media_unavailable');
  assert.match(undelivered.message, /session-delivered/);
});

test('Host limitations are reprojected once and repeated verification preserves the accepted digest', async () => {
  const obsolete = `<p data-host-limitation>${reportString('zh', 'hostLimitationVisualWordlist')}</p>`;
  const stale = shell(`<p>本报告不含视觉检查。</p>${obsolete}${obsolete}`);
  const clean = await verifyAndRenderComparisonReport({ ...input, html: stale });
  assert.ok('html' in clean);
  assert.doesNotMatch(clean.html, /data-host-limitation/);
  const note = `<p data-host-limitation>${reportString('zh', 'hostLimitationVerifiedWordlist')}</p>`;
  let html = shell(`<p>已核验文件。</p>${note}${note}`);
  let digest: string | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const verified = await verifyAndRenderComparisonReport({ ...input, html });
    assert.ok('html' in verified, JSON.stringify(verified));
    assert.equal((verified.html.match(/data-host-limitation/g) ?? []).length, 1);
    if (digest) assert.equal(sha256(verified.html), digest);
    digest = sha256(verified.html);
    html = verified.html;
  }
});
