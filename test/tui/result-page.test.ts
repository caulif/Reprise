import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { renderResult, resultHints } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';
import { kv } from '../../src/tui/widgets.js';
import { syntheticExperimentResult } from './fixtures/synthetic-flow.js';

test('result page uses comparison headline and hides satisfied rationale', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(120, false);
  const compared = renderResult(theme, 120, {
    ...syntheticExperimentResult({
      runId: 'run-1',
      experimentRoot: String.raw`C:\exp`,
      comparison: {
        status: 'completed',
        headline: 'Both delivered slides. The candidate used one turn.',
      },
      candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
    }),
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied', rationale: '已在当前工作目录生成可打开的三页 PPT 样式 HTML。' } },
  } as never).join('\n');
  assert.match(compared, /Both delivered slides/);
  assert.match(compared, /environment\/runs\/run-1/);
  assert.doesNotMatch(compared, /三页 PPT/);
  const skipped = renderResult(theme, 120, {
    ...syntheticExperimentResult({
      runId: 'run-1',
      experimentRoot: String.raw`C:\exp`,
      comparison: { status: 'skipped' },
      candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
    }),
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied', rationale: '已在当前工作目录生成可打开的三页 PPT 样式 HTML。' } },
  } as never).join('\n');
  assert.match(skipped, /not run/);
  assert.doesNotMatch(skipped, /三页 PPT/);
  assert.doesNotMatch(skipped, /Both delivered|两边都/);
  assert.match(skipped, /Report/);
  assert.match(skipped, /History final/);
  assert.match(skipped, /Candidate final/);
});

test('synthetic fixture covers cancelled and insufficient_evidence comparison independently of candidate success', () => {
  const theme = createTheme(120, false);
  const cancelledFixture = syntheticExperimentResult({
    comparison: { status: 'cancelled' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
  });
  assert.equal((cancelledFixture.comparison as { result: { status: string } }).result.status, 'cancelled');
  assert.equal(
    (cancelledFixture.record as { outcome: { task: { status: string }; termination: { kind: string } } }).outcome.task.status,
    'apparently_completed',
  );
  assert.match(String(cancelledFixture.reportPath), /comparison-failure\.html/);
  assert.equal(
    (cancelledFixture.pathLinks as { report?: string }).report,
    cancelledFixture.reportPath,
  );
  // Baseline (T01): cancelled currently paints as "Comparison complete" — fixture must still carry cancelled.
  const cancelledPaint = renderResult(theme, 120, cancelledFixture as never).join('\n');
  assert.match(cancelledPaint, /apparently_completed|completed\.controller_satisfied/);
  assert.match(cancelledPaint, /Comparison complete/);
  assert.match(cancelledPaint, /comparison-failure\.html/);

  const insufficientFixture = syntheticExperimentResult({
    comparison: { status: 'completed', valueStatus: 'insufficient_evidence', headline: 'Evidence was incomplete.' },
    candidate: { task: 'incomplete', termination: 'stalled', cleanup: 'unknown' },
  });
  assert.equal(
    (insufficientFixture.comparison as { result: { value: { status: string; headline?: string } } }).result.value.status,
    'insufficient_evidence',
  );
  assert.equal(
    (insufficientFixture.record as { outcome: { cleanup: { status: string } } }).outcome.cleanup.status,
    'unknown',
  );
  const insufficient = renderResult(theme, 120, insufficientFixture as never).join('\n');
  assert.match(insufficient, /stalled|incomplete/);
  assert.match(insufficient, /Evidence was incomplete/);
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

test('result page footer lists path open keys and c during compare gate', () => {
  assert.deepEqual(resultHints(), [
    ['o', 'Open report'],
    ['h', 'History final'],
    ['f', 'Candidate final'],
    ['Esc', 'Home'],
  ]);
  assert.deepEqual(resultHints('en', true), [
    ['c', 'Generate comparison card'],
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

test('failed result shows the recorded failure instead of limitations copy', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: ['fingerprint differs'] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        task: { status: 'indeterminate' },
        termination: {
          kind: 'failed',
          code: 'failed.controller',
          failure: { origin: 'controller', code: 'invalid_output', message: 'Controller decision failed the output contract.', evidenceRefs: [] },
        },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'failed' },
    comparison: { result: { status: 'failed', failure: { code: 'agent_failure', kind: 'protocol' } } },
  } as never).join('\n');
  assert.match(text, /failed\.controller/);
  assert.match(text, /Controller: Controller decision failed the output contract/);
  assert.doesNotMatch(text, /Limitations|Single run|fingerprint differs/);
});

test('runtime failure identifies the selected product rather than Codex', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        task: { status: 'indeterminate' },
        termination: {
          kind: 'failed', code: 'failed.runtime',
          failure: { origin: 'runtime', code: 'runtime.invalid_json', message: 'invalid JSON', evidenceRefs: [] },
        },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'failed' },
    comparison: { result: { status: 'failed', failure: { code: 'agent_failure', kind: 'protocol' } } },
  } as never, 'en', 'Claude Code').join('\n');
  assert.match(text, /Claude Code: invalid JSON/);
  assert.match(text, /not a Claude Code runtime crash/);
  assert.doesNotMatch(text, /Codex/);
});

test('blocked result is a warning with controller reason and short paths', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(120, false);
  const lines = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'incomplete' }, termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked', rationale: 'Sandbox denied the WeChat data path.' } },
    comparison: { result: { status: 'completed' } },
  } as never);
  for (const line of lines) assert.equal(visibleWidth(line), 120, line);
  const text = lines.join('\n');
  assert.match(text, /blocked\.controller_done/);
  assert.match(text, /Sandbox denied the WeChat data path/);
  assert.match(text, /Report\s+.*report\.html/);
  assert.match(text, /Trace\s+.*runs\/run-1\//);
  assert.match(text, /\u001b\]8;;file:\/\/\/.*report\.html\u001b\\/);
  assert.match(text, /\u001b\]8;;file:\/\/\/.*runs[/\\]run-1\u001b\\/);
  assert.doesNotMatch(text, /C:\\exp\\report\.html/);
  assert.doesNotMatch(text, /✗ blocked/);
  assert.doesNotMatch(text, /Cost not recorded|not recorded/);
});

test('limit_reached result explains the turn cap', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'incomplete' }, termination: { kind: 'limit_reached', code: 'limit.target_turns' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'send', message: 'Continue.' } },
    comparison: { result: { status: 'completed' } },
  } as never).join('\n');
  assert.match(text, /limit\.target_turns/);
  assert.match(text, /target turn limit/);
  assert.match(text, /Comparison still ran/);
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

test('cancelled comparison is not labeled as comparison complete', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\comparison-failure.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        task: { status: 'apparently_completed' },
        termination: { kind: 'completed', code: 'completed.controller_satisfied' },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
    comparison: { result: { status: 'cancelled' } },
  } as never).join('\n');
  assert.match(text, /Comparison cancelled|对照已取消/);
  assert.doesNotMatch(text, /Comparison complete|对照完成/);
});
