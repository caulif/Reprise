import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComparisonReportFacts } from '../../src/agents/comparison-agent.js';
import { renderComparisonReportShell, extractHostZoneSnapshot, hostZonesMismatch, renderComparisonReportFromModel } from '../../src/application/comparison-report-shell.js';
import { comparisonReportModelFromHtml } from '../../src/application/comparison-publication.js';
import { comparisonCompactTextCharacters } from '../../src/application/comparison-report-text.js';

test('compact substitute disclosure belongs to Host and survives model reconstruction in both locales', () => {
  const facts: ComparisonReportFacts = {
    run: { runId: 'r', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { baseline: 'original-model', candidate: 'candidate-model' }, activity: {}, limits: { triggered: [] },
    runtime: { productId: 'fixture' }, delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'unknown' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' },
  };
  for (const locale of ['zh', 'en'] as const) {
    const render = () => renderComparisonReportShell({ formatVersion: 3, task: 'Compare', facts, metrics: {}, locale,
      slots: { headline: 'Use candidate', boundary: '', differences: [], comparison: '<p>Candidate preserves the final paragraph.</p>' } });
    delete facts.replay.baselineIsSubstitute;
    const ordinary = render();
    assert.doesNotMatch(ordinary, /data-host="substitute-baseline"/);
    facts.replay.baselineIsSubstitute = true;
    const html = render();
    const expected = locale === 'zh' ? /历史材料为用户指定替代品，非历史模型原件；模型与指标属于原会话。/ : /Historical material is a user-selected substitute.*Model and metrics refer to the original session\./;
    assert.match(html, expected);
    assert.equal(comparisonCompactTextCharacters(html), comparisonCompactTextCharacters(ordinary));
    const snapshot = extractHostZoneSnapshot(html)!;
    const tampered = html.replace(/<p class="metric-note" data-host="substitute-baseline">.*?<\/p>/, '');
    assert.match(hostZonesMismatch(tampered, snapshot, {}, locale)!, /Host zone "header" was modified/);
    const model = comparisonReportModelFromHtml(html, facts, { status: 'completed', reportPath: 'report.html', headline: 'Use candidate', evidenceRefs: [] }, [], [], locale);
    assert.match(renderComparisonReportFromModel({ model, facts, locale }), expected);
  }
});
