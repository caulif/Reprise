import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities } from '@earendil-works/pi-tui';
import { renderResult, resultHints } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';
import { kv } from '../../src/tui/widgets.js';

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
  assert.match(skipped, /Report/);
  assert.match(skipped, /History final/);
  assert.match(skipped, /Candidate final/);
});

test('skipped comparison still renders history and candidate rows without bare absolute paths', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const theme = createTheme(120, false);
  const historyFinal = 'C:\\exp\\environment\\baselines\\deck.html';
  const candidateFinal = 'C:\\exp\\environment\\runs\\run-1\\out.html';
  const text = renderResult(theme, 120, {
    experimentRoot: 'C:\\exp',
    pathLinks: {
      historyFinal,
      candidateFinal,
      trace: 'C:\\exp\\runs\\run-1',
      replica: 'C:\\exp\\environment\\runs\\run-1',
    },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
    comparison: { result: { status: 'skipped' } },
  } as never).join('\n');
  assert.match(text, /Report/);
  assert.match(text, /History final.*deck\.html/);
  assert.match(text, /Candidate final.*out\.html/);
  assert.doesNotMatch(text, /C:\\exp\\environment\\baselines\\deck\.html/);
  assert.doesNotMatch(text, /C:\\exp\\environment\\runs\\run-1\\out\.html/);
});

test('result page footer lists report, history, and candidate open keys', () => {
  assert.deepEqual(resultHints(), [
    ['o', 'Open report'],
    ['h', 'History final'],
    ['f', 'Candidate final'],
    ['Esc', 'Home'],
  ]);
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
    assert.match(text, /Comparison failed/);
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

test('result metrics show collected token totals and priced cost', () => {
  const text = renderResult(createTheme(120, false), 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'incomplete' }, termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 49_000, turns: 1, controllerCalls: 1, tokenCount: 256, costUsd: 0.49 },
  } as never).join('\n');
  assert.match(text, /256 tokens/);
  assert.match(text, /\$0\.49/);
  assert.doesNotMatch(text, /not recorded tokens/);
  assert.doesNotMatch(text, /not recorded cost/);
});

test('compact result keeps Trace on one line', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(60, false);
  const text = renderResult(theme, 60, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-6d6a47ae-e824-4f40-b1ad-35565ba8943c' },
      outcome: { task: { status: 'incomplete' }, termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 49_000, turns: 1, controllerCalls: 1 },
  } as never).join('\n');
  assert.match(text, /49s/);
  assert.match(text, /not recorded tokens/);
  assert.match(text, /Trace\s+.*runs\/run-6d6a47ae/);
  assert.doesNotMatch(text, /\n\s+runs\//);
});

test('result metrics name candidate time when comparison made the experiment longer', () => {
  const text = renderResult(createTheme(120, false), 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'incomplete' }, termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 72_000, elapsedMs: 148_000, turns: 1, controllerCalls: 1 },
  } as never).join('\n');
  assert.match(text, /148s/);
  assert.match(text, /candidate 72s/);
});

test('result banners use the fail slot and mute kv keys', () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  try {
    const theme = createTheme(120, true);
    const text = renderResult(theme, 120, {
      record: {
        attempt: { runId: 'run-1' },
        outcome: { task: { status: 'incomplete' }, termination: { kind: 'stalled', code: 'stalled.controller_no_further_value' }, cleanup: { status: 'complete' } },
      },
      decision: { status: 'completed', value: { type: 'done', reason: 'no_further_value' } },
      comparison: { result: { status: 'skipped' } },
    } as never).join('\n');
    assert.match(text, /\u001b\[31m|\u001b\[38;2;224;122;122m/);
    const banner = text.split('\n').find((line) => /stalled/.test(line) && /⚠|!/.test(line)) ?? '';
    assert.doesNotMatch(banner, /\u001b\[33m|\u001b\[38;2;238;176;155m/);
    assert.match(kv(theme, 'Task', 'incomplete', 80), /\u001b\[90m|\u001b\[38;2;139;153;149m/);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
});
