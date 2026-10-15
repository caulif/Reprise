import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveResultPresentation, deriveResultPresentationFromHistory, deriveResultPresentationFromResult, type ResultPresentationInput } from '../../src/tui/display-state.js';
import { readLocalHistory, type HistoryExperiment } from '../../src/application/experiment-history-list.js';
import { historyExperimentFromResult } from '../../src/application/history-result-facts.js';
import { startExperiment } from '../../src/application/experiment.js';
import { comparePersistedExperiment } from '../../src/application/experiment-compare-persisted.js';
import { renderHistoryDetail } from '../../src/tui/pages/history.js';
import { createTheme } from '../../src/tui/theme.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const facts: Omit<ResultPresentationInput, 'comparison'> = {
  task: { status: 'apparently_completed' }, termination: { kind: 'completed' }, cleanup: { status: 'complete' },
};
const history: HistoryExperiment = { experimentId: 'experiment', taskCaseId: 'case', path: 'C:/experiment', sizeBytes: 0,
  taskStatus: 'apparently_completed', outcome: 'completed', cleanupStatus: 'complete' };

test('pending and unknown are legal presentation facts without fabricated invocation data', () => {
  const pending = deriveResultPresentation({ ...facts, comparison: { status: 'pending' } }, 'en');
  assert.equal(pending.comparisonKind, 'pending');
  assert.equal(pending.reportKind, 'none');
  const unknown = deriveResultPresentation({ ...facts, comparison: { status: 'unknown' } }, 'en');
  assert.equal(unknown.comparisonKind, 'unknown');
  assert.equal(unknown.statusTone, 'warn');
  assert.equal(unknown.statusLabelKey, 'resultStatusCompareUnknown');
});

for (const detail of [undefined, 'legacy', 'future-status']) {
  test(`historical completed with ${detail ?? 'missing'} detail cannot certify a successful comparison`, () => {
    const item = { ...history, comparisonStatus: 'completed', ...(detail ? { comparisonDetail: detail } : {}) };
    const shown = deriveResultPresentationFromHistory(item, 'zh');
    assert.equal(shown.comparisonKind, 'unknown');
    assert.equal(shown.statusTone, 'warn');
    assert.match(shown.comparisonLabel, /未确认/);
    assert.equal(deriveResultPresentationFromHistory({ ...item, comparisonDetail: 'completed' }, 'zh').comparisonKind, 'completed');
  });
}

test('unknown termination, task and cleanup remain uncertain beside an explicitly completed comparison', () => {
  const shown = deriveResultPresentationFromHistory({ ...history, outcome: 'legacy-success', taskStatus: 'future-task',
    cleanupStatus: 'future-cleanup', comparisonStatus: 'completed', comparisonDetail: 'completed' }, 'zh');
  assert.equal(shown.statusTone, 'warn');
  assert.equal(shown.statusLabelKey, 'resultStatusCleanupUnknown');
  assert.match(shown.terminationLabel, /未确认/);
  assert.match(shown.cleanupLabel, /未知/);
  assert.doesNotMatch(shown.taskLabel, /完成/);
  const interrupted = deriveResultPresentationFromHistory({ ...history, outcome: 'interrupted' }, 'zh');
  assert.equal(interrupted.terminationLabel, '已中断');
  assert.notEqual(interrupted.statusTone, 'ok');
});

test('stored failure tokens are preserved and absent failure details are not invented', () => {
  for (const token of ['authentication', 'publication_failed', 'future_provider_failure']) {
    const shown = deriveResultPresentationFromHistory({ ...history, comparisonStatus: 'failed', comparisonFailure: token }, 'en');
    assert.equal(shown.comparisonKind, 'failed');
    assert.ok(shown.comparisonLabel.includes(token));
  }
  const missing = deriveResultPresentationFromHistory({ ...history, comparisonStatus: 'failed' }, 'en');
  assert.doesNotMatch(missing.comparisonLabel, /agent_failure|history|undefined/);
  assert.equal(missing.statusTone, 'danger');
});

test('startup failure and unconfirmed report diagnoses survive the same History rendering', () => {
  const { taskStatus: _taskStatus, cleanupStatus: _cleanupStatus, ...unknown } = history;
  const item: HistoryExperiment = { ...unknown, outcome: 'failed',
    formatError: 'missing_metadata', startupFailureStage: 'agents', startupFailure: 'fixture startup diagnostic',
    comparisonStatus: 'unknown', reportPath: 'C:/experiment/report.html', reportAttemptUnconfirmed: true };
  const page = renderHistoryDetail(createTheme(120, false), 120, item, 'zh').join('\n');
  assert.match(page, /启动阶段\s+agents/);
  assert.match(page, /fixture startup diagnostic/);
  assert.match(page, /缺少实验元数据/);
  assert.match(page, /已有文件，版本未确认/);
  assert.notEqual(deriveResultPresentationFromHistory(item, 'zh').statusTone, 'ok');
});

test('real live and History projections keep identical fact labels for completed and failed comparisons', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-presentation-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const completed = await startExperiment(base).result;
  const completedHistory = (await readLocalHistory(base.dataDir)).experiments[0]!;
  const failed = await comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy,
    now: base.now, agentConfig: base.agentConfig, comparison: { compare: async () => ({ status: 'failed',
      failure: { code: 'agent_failure', kind: 'authentication', message: 'fixture failure', attempts: 1 } }), cancel: async () => {} } });
  const failedHistory = (await readLocalHistory(base.dataDir)).experiments[0]!;
  for (const [result, reopened] of [[completed, completedHistory], [failed, failedHistory]] as const) {
    const item = historyExperimentFromResult(result, { experimentRoot: result.experimentRoot, taskCaseId: base.caseId });
    for (const locale of ['en', 'zh'] as const) {
      assert.deepEqual(deriveResultPresentationFromResult(result, locale), deriveResultPresentationFromHistory(item, locale));
      assert.deepEqual(deriveResultPresentationFromResult(result, locale), deriveResultPresentationFromHistory(reopened, locale));
    }
  }
  assert.equal(deriveResultPresentationFromResult(completed, 'en', true).comparisonKind, 'pending');
});
