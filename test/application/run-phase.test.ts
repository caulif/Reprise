import test from 'node:test';
import assert from 'node:assert/strict';
import { runningChrome } from '../../src/tui/pages/run.js';
import { renderResult } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';
import { renderWorkbench } from '../../src/tui/workbench.js';

test('candidate running chrome shows reconnect count and a stale wait hint', () => {
  const theme = createTheme(120, false);
  const now = Date.parse('2026-08-28T00:02:10.000Z');
  const reconnect = runningChrome(theme, 120, {
    entries: [], selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:46', turns: { used: 1 }, calls: { used: 0 }, detailExpanded: false,
    runPhase: 'candidate_reconnecting', reconnectCount: 3, reconnectTotal: 5,
    lastRuntimeEventAt: '2026-08-28T00:02:00.000Z', runStartedAt: now - 46_000, tick: now,
    locale: 'zh', productLabel: 'Codex',
  }).join('\n');
  assert.match(reconnect, /正在重连（3\/5）/);
  assert.doesNotMatch(reconnect, /正在恢复/);
  const stale = runningChrome(theme, 120, {
    entries: [], selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '02:10', turns: { used: 1 }, calls: { used: 0 }, detailExpanded: false,
    runPhase: 'candidate_generating', lastRuntimeEventAt: '2026-08-28T00:00:00.000Z',
    runStartedAt: now - 130_000, tick: now, locale: 'zh', productLabel: 'Codex',
  }).join('\n');
  assert.match(stale, /Ctrl\+C/);
});

test('candidate running header is not the recovery title', () => {
  const text = renderWorkbench({
    page: 'running', cwd: 'C:\\repo', hasApiConfig: true, hasTaskCase: true, locale: 'zh', message: '',
    inlineHelp: false,
    running: {
      entries: [], selected: 0, filter: 'ALL', following: true, cancelling: false,
      currentState: 'awaiting_target', elapsed: '00:12', turns: { used: 1 }, calls: { used: 0 }, detailExpanded: false,
      productLabel: 'Codex',
    },
  }, 120).join('\n');
  assert.match(text, /候选运行中/);
  assert.doesNotMatch(text, /正在恢复会话/);
});

test('recovery runPhase keeps the recovering header after preparePhase is cleared', () => {
  const text = renderWorkbench({
    page: 'running', cwd: 'C:\\repo', hasApiConfig: true, hasTaskCase: true, locale: 'zh', message: '',
    inlineHelp: false,
    running: {
      entries: [], selected: 0, filter: 'ALL', following: true, cancelling: false,
      currentState: undefined, elapsed: '00:12', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
      productLabel: 'Codex',
      runPhase: 'recovery',
    },
  }, 120).join('\n');
  assert.match(text, /正在恢复会话/);
  assert.doesNotMatch(text, /候选运行中/);
  assert.doesNotMatch(text, /发给 Codex/);
  assert.doesNotMatch(text, /正在写回复/);
});

test('upstream runtime failure names the temporary outage on the result page', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        task: { status: 'indeterminate' },
        termination: {
          kind: 'failed', code: 'failed.runtime',
          failure: {
            origin: 'runtime',
            code: 'failed.runtime.upstream_unavailable',
            message: 'HTTP 503 after 5 reconnects.',
            evidenceRefs: [],
          },
        },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'failed' },
    comparison: { result: { status: 'skipped' } },
  } as never, 'zh', 'Codex').join('\n');
  assert.match(text, /上游服务暂时不可用/);
  assert.match(text, /HTTP 503/);
});
