import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComparisonReportShell, agentContentFromDraft, hostMetricsMismatch, missingComparisonSlots } from '../../src/application/comparison-report-shell.js';
import { comparisonCompactTextBudgetError } from '../../src/application/comparison-report-text.js';

test('restored compact report keeps PR126 layout, fixed k, frozen identity and abstract task through rebuild', () => {
  const facts = {
    run: { runId: 'run', outcome: 'completed', terminationCode: 'done', initiatedBy: 'controller' },
    models: { baseline: 'history-model', candidate: 'current-model', comparison: 'analysis-model' },
    sessionDates: { baseline: '2026-10-14', candidate: '2026-10-16' },
    activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
    delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'unknown' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available', baselineIsSubstitute: true },
  };
  const metrics = { baseline: { tokens: { total: 70480 } }, candidate: { tokens: { total: 11698718 } } };
  const slots = { category: '文档修订', headline: '先核验当前版的修订留痕，再验收。', boundary: '尚未核验打开效果。', differences: ['当前保留编号，便于继续核对。'], comparison: '<p>两版修订记录均存在。</p>' };
  const render = (overrides = {}) => renderComparisonReportShell({ formatVersion: 5, task: 'C:\\Private\\secret.docx', facts, metrics, slots: { ...slots, ...overrides } });
  const html = render();
  assert.match(html, /data-report-format="5"/);
  assert.match(html, /class="models"/);
  assert.match(html, /data-agent-zone="differences"/);
  assert.match(html, /Token（k）/);
  assert.match(html, />70\.5<\/td>/);
  assert.match(html, />11,698\.7<\/td>/);
  assert.match(html, /2026-10-14 UTC/);
  assert.match(html, /data-host="substitute-baseline"/);
  assert.match(html, /height:auto; max-height:none; object-fit:contain/);
  assert.doesNotMatch(html, /Private|secret|data-report-format="3"|<details/);
  assert.equal(missingComparisonSlots(html), undefined);
  assert.equal(hostMetricsMismatch(html, metrics), undefined);
  assert.equal(comparisonCompactTextBudgetError(html), undefined);
  const extracted = agentContentFromDraft(html);
  assert.ok('slots' in extracted);
  assert.equal(renderComparisonReportShell({ task: 'Another private task', facts, metrics, ...extracted }), html);
  for (const overrides of [{ differences: ['private.docx'] }, { boundary: 'person@example.org' }, { comparison: '<img alt="C:\\Private\\secret">' }]) {
    assert.match(comparisonCompactTextBudgetError(render(overrides))!, /possible path/);
  }
});
