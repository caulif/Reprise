import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  historyExperimentFromResult,
  resultFactsFromHistory,
  resultFactsFromLiveResult,
  selectComparisonArtifacts,
} from '../../src/application/history-result-facts.js';
import type { ExperimentResult } from '../../src/application/experiment.js';

test('selectComparisonArtifacts prefers diagnostic for cancelled and keeps old report separate', () => {
  const both = selectComparisonArtifacts({
    comparisonStatus: 'cancelled',
    diagnosticPath: '/exp/comparison-failure.html',
    successPath: '/exp/report.html',
  });
  assert.equal(both.reportKind, 'Diagnostic');
  assert.equal(both.reportPath, '/exp/comparison-failure.html');
  assert.equal(both.previousReportPath, '/exp/report.html');
  assert.equal(both.reportAttemptUnconfirmed, undefined);

  const onlyOld = selectComparisonArtifacts({
    comparisonStatus: 'cancelled',
    successPath: '/exp/report.html',
  });
  assert.equal(onlyOld.reportKind, 'Previous report');
  assert.equal(onlyOld.reportAttemptUnconfirmed, true);
  assert.doesNotMatch(onlyOld.reportKind ?? '', /^Report$/);
});

test('selectComparisonArtifacts does not promote unreadable comparison leftovers to Report', () => {
  const unread = selectComparisonArtifacts({
    successPath: '/exp/report.html',
    diagnosticPath: '/exp/comparison-failure.html',
    comparisonReadable: false,
  });
  assert.equal(unread.reportAttemptUnconfirmed, true);
  assert.notEqual(unread.reportKind, 'Report');
});

test('live and history projections share semantic fields for the same fixture', () => {
  const experimentRoot = join('C:', 'exp');
  const diagnostic = join(experimentRoot, 'comparison-failure.html');
  const live = {
    experimentRoot,
    reportPath: diagnostic,
    taskCase: { caseId: 'case-1' },
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

  const fromLive = resultFactsFromLiveResult(live, { experimentRoot, taskCaseId: 'case-1' });
  const projected = historyExperimentFromResult(live, { experimentRoot, taskCaseId: 'case-1' });
  const fromHistory = resultFactsFromHistory({
    ...projected,
    // History may also observe a leftover success report on disk.
    previousReportPath: join(experimentRoot, 'report.html'),
    sizeBytes: 12,
  });

  assert.equal(fromLive.outcome, 'completed');
  assert.equal(fromLive.taskStatus, 'apparently_completed');
  assert.equal(fromLive.cleanupStatus, 'unknown');
  assert.equal(fromLive.comparisonStatus, 'cancelled');
  assert.equal(fromLive.reportKind, 'Diagnostic');
  assert.equal(fromLive.reportPath, diagnostic);

  assert.equal(fromHistory.outcome, fromLive.outcome);
  assert.equal(fromHistory.taskStatus, fromLive.taskStatus);
  assert.equal(fromHistory.cleanupStatus, fromLive.cleanupStatus);
  assert.equal(fromHistory.comparisonStatus, fromLive.comparisonStatus);
  assert.equal(fromHistory.reportKind, fromLive.reportKind);
  assert.equal(fromHistory.reportPath, fromLive.reportPath);
  assert.equal(fromHistory.previousReportPath, join(experimentRoot, 'report.html'));
});

test('completed insufficient_evidence keeps Report kind and comparisonDetail', () => {
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
  const facts = resultFactsFromLiveResult(live, { experimentRoot, taskCaseId: 'case-1' });
  assert.equal(facts.reportKind, 'Report');
  assert.equal(facts.comparisonStatus, 'completed');
  assert.equal(facts.comparisonDetail, 'insufficient_evidence');
});
