import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { renderWorkbench } from '../../src/tui/workbench.js';
import { createTheme } from '../../src/tui/theme.js';
import { renderResult } from '../../src/tui/pages/result.js';
import { budgetChrome } from '../../src/tui/workbench-layout.js';
import { filterTraceForSurface } from '../../src/tui/timeline.js';

test('T08: 100x30 result first screen shows facts and primary actions without scrolling the timeline', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const result = {
    reportPath: 'C:\\exp\\comparison-failure.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1', candidate: { productId: 'claude-code', requestedModel: 'default' } },
      outcome: {
        task: { status: 'apparently_completed' },
        termination: { kind: 'completed', code: 'completed.controller_satisfied' },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
    comparison: { result: { status: 'cancelled' } },
    pathLinks: {
      report: 'C:\\exp\\comparison-failure.html',
      candidateFinal: 'C:\\exp\\environment\\runs\\run-1\\out.html',
    },
  } as never;
  const lines = renderWorkbench({
    page: 'result',
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasUsableAuth: true,
    hasTaskCase: true,
    message: '',
    productLabel: 'Claude Code',
    locale: 'en',
    result,
    running: {
      entries: Array.from({ length: 40 }, (_, index) => ({
        sequence: index + 1,
        occurredAt: '2026-09-20T00:00:00.000Z',
        source: 'TARGET' as const,
        title: `Noise ${index}`,
        detail: 'should stay folded',
      })),
      selected: 0, filter: 'ALL', following: true, cancelling: false,
      currentState: 'finished', elapsed: '02:56', turns: { used: 1 }, calls: { used: 1 },
    },
  }, 100, 30);
  assert.ok(lines.length <= 30, `expected <= 30 lines, got ${lines.length}`);
  const text = lines.join('\n');
  assert.match(text, /Run result/);
  assert.match(text, /Reprise model judged the task complete/);
  assert.match(text, /Comparison cancelled/);
  assert.match(text, /diagnostic|comparison-failure/);
  assert.match(text, /This run output|out\.html/);
  assert.match(text, /View execution process|Hide process/);
  assert.doesNotMatch(text, /Noise 39/);
  for (const line of lines) assert.ok(visibleWidth(line) <= 100, line);
});

test('T08: 80x24 picker keeps recovery summary and selection without dumping the recovery timeline', () => {
  const lines = renderWorkbench({
    page: 'candidate-model',
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasUsableAuth: true,
    hasTaskCase: true,
    message: '',
    locale: 'zh',
    recoverySummary: {
      recovery: { status: 'ready', summary: '可以继续', unresolved: ['one', 'two'], changedPathCount: 0 },
      expandable: true,
    },
    candidateModel: {
      taskTitle: 'build bike',
      sourceProductLabel: 'Codex',
      candidateProductLabel: 'Claude Code',
      offers: [{ value: 'default', displayName: 'default', resolvedModel: 'claude-opus' }],
      selected: 0,
      status: 'ready',
      locale: 'zh',
    },
    running: {
      entries: Array.from({ length: 30 }, (_, index) => ({
        sequence: index + 1,
        occurredAt: '2026-09-20T00:00:00.000Z',
        source: 'HARNESS' as const,
        title: `▸ 阅读证据 · ${index}`,
        lane: 'recovery' as const,
        kind: 'fold' as const,
      })),
      selected: 0, filter: 'ALL', following: true, cancelling: false,
      currentState: undefined, elapsed: '01:10', turns: { used: 0 }, calls: { used: 0 },
    },
  }, 80, 24);
  assert.ok(lines.length <= 24, `expected <= 24 lines, got ${lines.length}`);
  const text = lines.join('\n');
  assert.match(text, /build bike/);
  assert.match(text, /default|Claude/);
  assert.match(text, /核对运行条件|Review run conditions/);
  assert.doesNotMatch(text, /阅读证据 · 29/);
});

test('T08: comparison-ended diagnostics remain reachable when surfaceScope is comparison', () => {
  const entries = [
    { sequence: 1, occurredAt: '2026-09-20T00:00:00.000Z', source: 'TARGET' as const, title: 'candidate note' },
    { sequence: 2, occurredAt: '2026-09-20T00:01:00.000Z', source: 'HARNESS' as const, title: 'path denied ×5', lane: 'comparison' as const },
  ];
  assert.equal(filterTraceForSurface(entries, 'result', 'overview').length, 0);
  const comparison = filterTraceForSurface(entries, 'result', 'comparison');
  assert.equal(comparison.length, 1);
  assert.equal(comparison[0]?.title, 'path denied ×5');
  const candidate = filterTraceForSurface(entries, 'result', 'candidate');
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0]?.title, 'candidate note');
});

test('T08: chrome budget keeps a readable body on short viewports', () => {
  const budget = budgetChrome(24, { header: 3, context: 1, stage: 1, activity: 2, notice: 2, footer: 2 });
  assert.ok(budget.body >= 4, `body=${budget.body}`);
  const tight = budgetChrome(14, { header: 3, context: 1, stage: 1, activity: 2, notice: 2, footer: 2 });
  assert.ok(tight.body >= 1);
  assert.ok(tight.stage === 0 || tight.context === 0 || tight.activity <= 1);
});

test('T08: cancelled comparison is not labeled complete on the result facts', () => {
  const text = renderResult(createTheme(100, false), 100, {
    reportPath: 'C:\\exp\\comparison-failure.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
    comparison: { result: { status: 'cancelled' } },
  } as never).join('\n');
  assert.match(text, /Comparison cancelled|比较已取消/);
  assert.doesNotMatch(text, /Comparison complete|对照完成/);
  assert.match(text, /diagnostic|诊断/);
});
