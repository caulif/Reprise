import test from 'node:test';
import assert from 'node:assert/strict';
import { renderResult } from '../src/tui/pages/result.js';
import { createTheme } from '../src/tui/theme.js';

test('result page uses comparison headline and hides satisfied rationale', () => {
  const theme = createTheme(120, false);
  const compared = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
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
      outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied', rationale: '已在当前工作目录生成可打开的三页 PPT 样式 HTML。' } },
    comparison: { result: { status: 'skipped' } },
  } as never).join('\n');
  assert.match(skipped, /not run/);
  assert.doesNotMatch(skipped, /三页 PPT/);
  assert.doesNotMatch(skipped, /Both delivered|两边都/);
  assert.doesNotMatch(skipped, /Report/);
});
