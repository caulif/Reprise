import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities } from '@earendil-works/pi-tui';
import { renderResult } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';

test('result page uses comparison headline and hides satisfied rationale', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(120, false);
  const compared = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied', rationale: '已在当前工作目录生成可打开的三页 PPT 样式 HTML。' } },
    comparison: { result: { status: 'completed', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [], headline: 'Both delivered slides. The candidate used one turn.' } } },
  } as never).join('\n');
  assert.match(compared, /Both delivered slides/);
  assert.match(compared, /environment\/runs\/run-1/);
  assert.doesNotMatch(compared, /三页 PPT/);
  const skipped = renderResult(theme, 120, {
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied', rationale: '已在当前工作目录生成可打开的三页 PPT 样式 HTML。' } },
    comparison: { result: { status: 'skipped' } },
  } as never).join('\n');
  assert.match(skipped, /not run/);
  assert.doesNotMatch(skipped, /三页 PPT/);
  assert.doesNotMatch(skipped, /Both delivered|两边都/);
  assert.doesNotMatch(skipped, /Report/);
});

test('failed comparison remains distinct from a stalled candidate in both terminal widths', () => {
  for (const width of [60, 120]) {
    const text = renderResult(createTheme(width, false), width, {
      reportPath: 'C:\\exp\\comparison-failure.html',
      experimentRoot: 'C:\\exp',
      record: {
        attempt: { runId: 'run-1' },
        outcome: { task: { status: 'incomplete' }, termination: { kind: 'stalled', code: 'stalled.controller_no_further_value' }, cleanup: { status: 'complete' } },
      },
      decision: { status: 'completed', value: { type: 'done', reason: 'no_further_value', rationale: 'Delivery is incomplete.' } },
      comparison: { result: { status: 'failed', failure: { code: 'agent_failure', kind: 'protocol' } } },
    } as never).join('\n');
    assert.match(text, /stalled/);
    assert.match(text, /Task\s+incomplete/);
    assert.match(text, /Report generation failed/);
    assert.match(text, /protocol/);
    assert.match(text, /Diagnostic/);
    assert.match(text, /comparison-failure\.html/);
  }
});

test('Controller opening failure names the stage and retryability without a candidate failure verdict', () => {
  const text = renderResult(createTheme(120, false), 120, {
    record: { outcome: { task: { status: 'not_assessed' }, termination: { kind: 'failed', code: 'failed.controller', failure: { origin: 'controller', code: 'agent_failure', message: 'provider detail' } } } },
    decision: { status: 'failed', failure: { code: 'agent_failure', kind: 'transient_upstream' } },
    comparison: { result: { status: 'skipped' } },
  } as never, 'zh').join('\n');
  assert.match(text, /Controller 开场理解.*暂时失败/);
  assert.match(text, /not_assessed/);
  assert.doesNotMatch(text, /provider detail/);
});
