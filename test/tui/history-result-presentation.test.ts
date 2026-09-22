import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { ExperimentResult } from '../../src/application/experiment.js';
import { historyExperimentFromResult } from '../../src/application/history-result-facts.js';
import {
  deriveResultPresentationFromHistory,
  deriveResultPresentationFromResult,
} from '../../src/tui/display-state.js';
import { historyDetailPointerAction, renderHistoryDetail, renderHistoryDetailWithHits } from '../../src/tui/pages/history.js';
import { createTheme } from '../../src/tui/theme.js';
import { setCapabilities } from '@earendil-works/pi-tui';

test('live and history share presentation semantics for cancelled comparison', () => {
  const experimentRoot = join('C:', 'exp');
  const live = {
    experimentRoot,
    reportPath: join(experimentRoot, 'comparison-failure.html'),
    record: {
      attempt: { runId: 'run-1', createdAt: '2026-09-20T00:00:00.000Z' },
      outcome: {
        task: { status: 'apparently_completed' },
        termination: { kind: 'completed', code: 'completed.controller_satisfied' },
        cleanup: { status: 'unknown' },
      },
    },
    comparison: { result: { status: 'cancelled' } },
  } as unknown as ExperimentResult;

  const fromLive = deriveResultPresentationFromResult(live, 'zh');
  const history = historyExperimentFromResult(live, { experimentRoot, taskCaseId: 'case-1' });
  const fromHistory = deriveResultPresentationFromHistory(history, 'zh');

  assert.equal(fromHistory.comparisonKind, fromLive.comparisonKind);
  assert.equal(fromHistory.comparisonLabel, fromLive.comparisonLabel);
  assert.equal(fromHistory.taskLabel, fromLive.taskLabel);
  assert.equal(fromHistory.cleanupLabel, fromLive.cleanupLabel);
  assert.equal(fromHistory.reportKind, fromLive.reportKind);
  assert.equal(fromHistory.statusTone, fromLive.statusTone);
  assert.equal(fromHistory.comparisonKind, 'cancelled');
  assert.equal(fromHistory.reportKind, 'diagnostic');
  assert.notEqual(fromHistory.statusTone, 'ok');
});

test('history insufficient_evidence matches live comparison presentation', () => {
  const experimentRoot = join('C:', 'exp');
  const live = {
    experimentRoot,
    reportPath: join(experimentRoot, 'report.html'),
    record: {
      attempt: { runId: 'run-1', createdAt: '2026-09-20T00:00:00.000Z' },
      outcome: {
        task: { status: 'incomplete' },
        termination: { kind: 'completed', code: 'completed.controller_satisfied' },
        cleanup: { status: 'complete' },
      },
    },
    comparison: {
      result: {
        status: 'completed',
        sessionId: 'cmp-1',
        value: { status: 'insufficient_evidence', reportPath: 'report.html', evidenceRefs: [] },
      },
    },
  } as unknown as ExperimentResult;
  const fromLive = deriveResultPresentationFromResult(live, 'en');
  const fromHistory = deriveResultPresentationFromHistory(
    historyExperimentFromResult(live, { experimentRoot, taskCaseId: 'case-1' }),
    'en',
  );
  assert.equal(fromHistory.comparisonKind, 'insufficient_evidence');
  assert.equal(fromHistory.comparisonKind, fromLive.comparisonKind);
  assert.equal(fromHistory.comparisonLabel, fromLive.comparisonLabel);
  assert.equal(fromHistory.reportKind, 'diagnostic');
});

test('history detail pointer opens the clicked HTML path for previous report and diagnostic', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(120, false);
  const diagnostic = 'C:\\exp\\comparison-failure.html';
  const previous = 'C:\\exp\\report.html';
  const item = {
    experimentId: 'exp-1',
    taskCaseId: 'case-1',
    path: 'C:\\exp',
    sizeBytes: 1,
    comparisonStatus: 'cancelled',
    reportPath: diagnostic,
    previousReportPath: previous,
  };
  const lines = renderHistoryDetail(theme, 120, item, 'zh');
  let diagHit: ReturnType<typeof historyDetailPointerAction>;
  let prevHit: ReturnType<typeof historyDetailPointerAction>;
  let pathHit: ReturnType<typeof historyDetailPointerAction>;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? '';
    for (let col = 0; col < line.length; col += 1) {
      const hit = historyDetailPointerAction(lines, row, col, item);
      if (hit?.action === 'open-report' && hit.reportPath === diagnostic) diagHit = hit;
      if (hit?.action === 'open-report' && hit.reportPath === previous) prevHit = hit;
      if (hit?.action === 'open-local' && /Path/.test(line)) pathHit = hit;
    }
  }
  assert.deepEqual(diagHit, { action: 'open-report', reportPath: diagnostic });
  assert.deepEqual(prevHit, { action: 'open-report', reportPath: previous });
  assert.deepEqual(pathHit, { action: 'open-local' });
});

test('history detail pointer keeps all local links clickable without OSC 8 support', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const theme = createTheme(120, false);
  const report = 'C:\\exp\\report.html';
  const item = {
    experimentId: 'exp-1', taskCaseId: 'case-1', path: 'C:\\exp', sizeBytes: 1,
    comparisonStatus: 'completed', reportPath: report,
  };
  const rendered = renderHistoryDetailWithHits(theme, 120, item, 'zh');
  let reportHit: ReturnType<typeof historyDetailPointerAction>;
  let pathHit: ReturnType<typeof historyDetailPointerAction>;
  for (const [row, hits] of rendered.rowHits) {
    for (const hit of hits) {
      const resolved = historyDetailPointerAction(rendered.lines, row, hit.x0, item, rendered.rowHits);
      if (hit.path === report) reportHit = resolved;
      if (hit.path === item.path) pathHit = resolved;
    }
  }
  assert.deepEqual(reportHit, { action: 'open-report', reportPath: report });
  assert.deepEqual(pathHit, { action: 'open-local' });
});
