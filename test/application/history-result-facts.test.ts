import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { selectComparisonArtifacts } from '../../src/application/comparison-artifacts.js';
import { historyExperimentFromResult } from '../../src/application/history-result-facts.js';
import type { ExperimentResult } from '../../src/application/experiment.js';

test('selectComparisonArtifacts prefers diagnostic for cancelled and keeps old report separate', () => {
  const both = selectComparisonArtifacts({
    comparisonStatus: 'cancelled',
    diagnosticPath: '/exp/comparison-failure.html',
    successPath: '/exp/report.html',
  });
  assert.equal(both.reportPath, '/exp/comparison-failure.html');
  assert.equal(both.previousReportPath, '/exp/report.html');
  assert.equal(both.reportAttemptUnconfirmed, undefined);

  const onlyOld = selectComparisonArtifacts({
    comparisonStatus: 'cancelled',
    successPath: '/exp/report.html',
  });
  assert.equal(onlyOld.reportPath, '/exp/report.html');
  assert.equal(onlyOld.reportAttemptUnconfirmed, true);
});

test('selectComparisonArtifacts does not promote unreadable comparison leftovers to confirmed success', () => {
  const unread = selectComparisonArtifacts({
    successPath: '/exp/report.html',
    diagnosticPath: '/exp/comparison-failure.html',
    comparisonReadable: false,
  });
  assert.equal(unread.reportAttemptUnconfirmed, true);
  assert.equal(unread.reportPath, '/exp/report.html');
  assert.equal(unread.previousReportPath, undefined);
});

test('live and history projections share semantic fields for the same fixture', () => {
  const experimentRoot = join('C:', 'exp');
  const diagnostic = join(experimentRoot, 'comparison-failure.html');
  const live = {
    experimentRoot,
    reportPath: diagnostic,
    taskCase: { caseId: 'case-1', initialInput: { id: 'message-1', role: 'user', text: 'Create the slides' } },
    record: {
      attempt: { runId: 'run-1', createdAt: '2026-09-20T00:00:00.000Z' },
      outcome: {
        task: { status: 'apparently_completed' },
        termination: { kind: 'completed', code: 'completed.controller_satisfied' },
        cleanup: { status: 'unknown' },
      },
    },
    comparison: {
      result: {
        status: 'cancelled',
      },
    },
  } as unknown as ExperimentResult;

  const fromLive = historyExperimentFromResult(live, { experimentRoot, taskCaseId: 'case-1' });
  const fromHistory = {
    ...fromLive,
    previousReportPath: join(experimentRoot, 'report.html'),
    sizeBytes: 12,
  };

  assert.equal(fromLive.outcome, 'completed');
  assert.equal(fromLive.taskTitle, 'Create the slides');
  assert.equal(fromLive.taskStatus, 'apparently_completed');
  assert.equal(fromLive.cleanupStatus, 'unknown');
  assert.equal(fromLive.comparisonStatus, 'cancelled');
  assert.equal(fromLive.reportPath, diagnostic);

  assert.equal(fromHistory.outcome, fromLive.outcome);
  assert.equal(fromHistory.taskStatus, fromLive.taskStatus);
  assert.equal(fromHistory.cleanupStatus, fromLive.cleanupStatus);
  assert.equal(fromHistory.comparisonStatus, fromLive.comparisonStatus);
  assert.equal(fromHistory.reportPath, fromLive.reportPath);
  assert.equal(fromHistory.previousReportPath, join(experimentRoot, 'report.html'));
});

test('completed insufficient_evidence keeps report.html path and comparisonDetail', () => {
  const experimentRoot = join('C:', 'exp');
  const report = join(experimentRoot, 'report.html');
  const live = {
    experimentRoot,
    reportPath: report,
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
        value: { status: 'insufficient_evidence', reportPath: 'report.html', evidenceRefs: [] },
        sessionId: 'cmp-1',
      },
    },
  } as unknown as ExperimentResult;
  const facts = historyExperimentFromResult(live, { experimentRoot, taskCaseId: 'case-1' });
  assert.equal(facts.reportPath, report);
  assert.equal(facts.comparisonStatus, 'completed');
  assert.equal(facts.comparisonDetail, 'insufficient_evidence');
  assert.equal(facts.reportAttemptUnconfirmed, undefined);
});
