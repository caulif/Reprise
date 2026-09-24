import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { readLocalHistory } from '../../src/tui/local-history.js';
import { renderHistory, renderHistoryDetail } from '../../src/tui/pages/history.js';
import { t as uiText } from '../../src/tui/i18n.js';
import { createTheme } from '../../src/tui/theme.js';
import { sha256 } from '../../src/core/identity.js';
import { isRecord } from '../../src/core/json.js';

test('local history keeps damaged experiment directories visible with a format diagnosis', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-damaged-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const missing = join(root, 'experiments', 'exp-missing');
  const invalid = join(root, 'experiments', 'exp-invalid');
  await mkdir(missing, { recursive: true });
  await mkdir(invalid, { recursive: true });
  await writeFile(join(invalid, 'experiment.json'), '{broken json');
  const history = await readLocalHistory(root);
  assert.equal(history.experiments.length, 2);
  assert.equal(history.experiments.find((item) => item.experimentId === 'exp-missing')?.formatError, 'missing_metadata');
  assert.equal(history.experiments.find((item) => item.experimentId === 'exp-invalid')?.formatError, 'invalid_metadata');
  const detail = renderHistoryDetail(createTheme(80, false), 80, history.experiments.find((item) => item.experimentId === 'exp-invalid')!, 'zh').join('\n');
  assert.match(detail, /实验元数据无法读取或格式无效/);
});

test('a damaged saved task is diagnosed while healthy tasks and runs remain available', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-mixed-cases-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const good = join(root, 'cases', 'good');
  const bad = join(root, 'cases', 'bad');
  const run = join(root, 'experiments', 'run-good');
  await Promise.all([mkdir(good, { recursive: true }), mkdir(bad, { recursive: true }), mkdir(run, { recursive: true })]);
  await writeFile(join(good, 'case.json'), JSON.stringify({
    schemaVersion: 1, caseId: 'good',
    source: { productId: 'codex', sessionId: 'session-good' },
    initialInput: { id: 'input-good', role: 'user', text: 'Repair the build' },
    transcript: [{ id: 'input-good', role: 'user', text: 'Repair the build' }],
    historicalEvents: [], baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    provenance: { packVersion: '1', importedAt: '2026-09-24T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    contentHash: 'b'.repeat(64),
  }));
  await writeFile(join(bad, 'case.json'), '{invalid');
  await Promise.all([writeFile(join(good, 'case.complete'), ''), writeFile(join(bad, 'case.complete'), '')]);
  const history = await readLocalHistory(root);
  assert.equal(history.invalidCaseCount, 1);
  assert.deepEqual(history.cases.map((item) => item.taskCase.caseId), ['good']);
  assert.equal(history.experiments.length, 1);
  const rendered = renderHistory(createTheme(80, false), 80, {
    totalBytes: history.totalBytes, invalidCaseCount: history.invalidCaseCount,
    tab: 'cases', items: history.cases, selected: 0, locale: 'zh',
  }).join('\n');
  assert.match(rendered, /1 个已保存任务文件无法读取/);
  assert.match(rendered, /Repair the build/);
});

test('local history reports experiment and total persisted data sizes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-size');
  await mkdir(experiment, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-size', taskCaseId: 'case-size', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: [] }));
  await writeFile(join(experiment, 'report.html'), 'report bytes');
  const history = await readLocalHistory(root);
  assert.equal(history.experiments.length, 1);
  assert.ok((history.experiments[0]?.sizeBytes ?? 0) >= 12);
  assert.ok(history.totalBytes >= history.experiments[0]!.sizeBytes);
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({ status: 'failed', failure: { code: 'agent_failure', message: 'context_length_exceeded', kind: 'protocol', attempts: 1 } }));
  const failed = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(failed.comparisonStatus, 'failed');
  assert.equal(failed.comparisonFailure, 'protocol');
  assert.equal(failed.reportAttemptUnconfirmed, true);
  assert.equal(failed.reportPath, join(experiment, 'report.html'));
  await writeFile(join(experiment, 'comparison-failure.html'), 'failure diagnosis');
  const diagnostic = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(diagnostic.reportPath, join(experiment, 'comparison-failure.html'));
  assert.equal(diagnostic.previousReportPath, join(experiment, 'report.html'));
  assert.equal(diagnostic.reportAttemptUnconfirmed, undefined);
  assert.equal(await readFile(join(experiment, 'report.html'), 'utf8'), 'report bytes');
});

test('local history treats cancelled comparison like failed for report selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-cancel-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-cancel');
  await mkdir(join(experiment, 'runs', 'run-1'), { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-cancel', taskCaseId: 'case-cancel', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: ['run-1'] }));
  await writeFile(join(experiment, 'runs', 'run-1', 'record.json'), JSON.stringify({
    attempt: {
      schemaVersion: 1,
      experimentId: 'exp-cancel',
      runId: 'run-1',
      caseId: 'case-cancel',
      candidate: { candidateId: 'candidate', productId: 'codex', requestedModel: 'model' },
      policy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 },
      createdAt: '2026-09-20T00:00:00.000Z',
    },
    state: 'finished',
    stageReached: 'awaiting_controller',
    outcome: {
      task: { status: 'apparently_completed', evidenceRefs: [] },
      termination: { kind: 'completed', code: 'completed.controller_satisfied', initiatedBy: 'controller' },
      cleanup: { status: 'unknown', remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: 'exp-cancel', runId: 'run-1', firstSequence: 1, lastSequence: 1 },
    artifactRefs: [],
    warnings: [],
  }));
  await writeFile(join(experiment, 'report.html'), 'old success');
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({ status: 'cancelled' }));
  const cancelledOnlyReport = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(cancelledOnlyReport.comparisonStatus, 'cancelled');
  assert.equal(cancelledOnlyReport.cleanupStatus, 'unknown');
  assert.equal(cancelledOnlyReport.reportAttemptUnconfirmed, true);
  assert.equal(cancelledOnlyReport.reportPath, join(experiment, 'report.html'));
  await writeFile(join(experiment, 'comparison-failure.html'), 'cancel diagnosis');
  const cancelledDiagnostic = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(cancelledDiagnostic.reportPath, join(experiment, 'comparison-failure.html'));
  assert.equal(cancelledDiagnostic.previousReportPath, join(experiment, 'report.html'));
  assert.equal(cancelledDiagnostic.reportAttemptUnconfirmed, undefined);
});

test('local history records nested insufficient_evidence without promoting failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-insuff-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-insuff');
  await mkdir(experiment, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-insuff', taskCaseId: 'case-insuff', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: [] }));
  await writeFile(join(experiment, 'report.html'), 'insuff report');
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({
    status: 'completed',
    sessionId: 'cmp-1',
    value: { status: 'insufficient_evidence', reportPath: 'report.html', evidenceRefs: ['ev-01'] },
  }));
  const item = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(item.comparisonStatus, 'completed');
  assert.equal(item.comparisonDetail, 'insufficient_evidence');
  assert.equal(item.reportPath, join(experiment, 'report.html'));
  assert.equal(item.reportAttemptUnconfirmed, undefined);
});

test('local history marks unreadable comparison leftovers as unconfirmed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-unreadable-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-bad-cmp');
  await mkdir(experiment, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-bad-cmp', taskCaseId: 'case-bad', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: [] }));
  await writeFile(join(experiment, 'report.html'), 'leftover');
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({ status: 'nope' }));
  const item = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(item.comparisonStatus, undefined);
  assert.equal(item.reportAttemptUnconfirmed, true);
  assert.equal(item.reportPath, join(experiment, 'report.html'));
});

test('history detail uses shared result fact labels for cleanup and previous report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-detail-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-detail');
  await mkdir(join(experiment, 'runs', 'run-1'), { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-detail', taskCaseId: 'case-detail', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: ['run-1'] }));
  await writeFile(join(experiment, 'runs', 'run-1', 'record.json'), JSON.stringify({
    attempt: {
      schemaVersion: 1,
      experimentId: 'exp-detail',
      runId: 'run-1',
      caseId: 'case-detail',
      candidate: { candidateId: 'candidate', productId: 'codex', requestedModel: 'model' },
      policy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 },
      createdAt: '2026-09-20T00:00:00.000Z',
    },
    state: 'finished',
    stageReached: 'awaiting_controller',
    outcome: {
      task: { status: 'incomplete', evidenceRefs: [] },
      termination: { kind: 'cancelled', code: 'cancelled.user', initiatedBy: 'user' },
      cleanup: { status: 'unknown', remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: 'exp-detail', runId: 'run-1', firstSequence: 1, lastSequence: 1 },
    artifactRefs: [],
    warnings: [],
  }));
  await writeFile(join(experiment, 'report.html'), 'old');
  await writeFile(join(experiment, 'comparison-failure.html'), 'diag');
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({ status: 'cancelled' }));
  const item = (await readLocalHistory(root)).experiments[0]!;
  const zh = renderHistoryDetail(createTheme(120, false), 120, item, 'zh').join('\n');
  assert.match(zh, /清理/);
  assert.match(zh, /清理\s+未知/);
  assert.match(zh, /比较已取消/);
  assert.match(zh, /诊断/);
  assert.match(zh, /此前报告/);
});

test('history detail shows stored comparison failure kind not agent_failure placeholder', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-fail-label-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-fail-label');
  await mkdir(experiment, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-fail-label', taskCaseId: 'case-fail', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: [] }));
  await writeFile(join(experiment, 'comparison-failure.html'), 'diag');
  await writeFile(join(experiment, 'comparison.json'), JSON.stringify({ status: 'failed', failure: { code: 'agent_failure', message: 'context_length_exceeded', kind: 'protocol', attempts: 1 } }));
  const item = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(item.comparisonFailure, 'protocol');
  const en = renderHistoryDetail(createTheme(120, false), 120, item, 'en').join('\n');
  assert.match(en, /Comparison failed \(protocol\)/);
  assert.doesNotMatch(en, /Comparison failed \(agent_failure\)/);
});

test('local history keeps sealed baseline copies when reporting size', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-reclaim-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-reclaim');
  const baseline = join(experiment, 'environment', 'baselines', 'case-reclaim');
  await mkdir(baseline, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-reclaim', taskCaseId: 'case-reclaim', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: ['run-1'] }));
  await writeFile(join(experiment, 'environment', 'baselines', 'case-reclaim.marker.json'), '{"sourceFingerprint":"abc"}');
  await writeFile(join(baseline, 'payload.bin'), 'x'.repeat(4096));
  await writeFile(join(experiment, 'report.html'), 'report');
  const history = await readLocalHistory(root);
  await stat(baseline);
  assert.ok((history.experiments[0]?.sizeBytes ?? 0) >= 4096);
});

test('local history classifies a crashed run from committed events and ignores the writer lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-crash-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const experiment = join(root, 'experiments', 'exp-crash');
  await mkdir(experiment, { recursive: true });
  await writeFile(join(experiment, 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 1, experimentId: 'exp-crash', taskCaseId: 'case-crash', candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }], controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } }, runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experiment }, runIds: ['run-1'] }));
  await writeFile(join(experiment, 'writer.lock'), JSON.stringify({ experimentId: 'exp-crash', pid: process.pid, nonce: 'live', startedAt: new Date().toISOString(), host: 'other-host' }));
  const occurredAt = '2026-09-08T00:00:00.000Z';
  const line = (sequence: number, type: string, payload: Record<string, unknown>) => {
    const body = { schemaVersion: 1, sequence, eventId: `event${sequence}`, occurredAt, type, payload };
    return `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`;
  };
  await writeFile(join(experiment, 'events.jsonl'), `${line(1, 'run.attempt_created', { runId: 'run-1' })}${line(2, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] })}${line(3, 'agent.message_appended', { sessionId: 'session-1', invocationId: 'inv-1', requestIndex: 1, repair: false, byteLength: 4 })}`);
  const history = await readLocalHistory(root);
  const item = history.experiments[0];
  assert.ok(item);
  assert.equal(item.outcome, 'interrupted');
  assert.equal(item.incompleteModelInput, true);
  const lock = JSON.parse(await readFile(join(experiment, 'writer.lock'), 'utf8')) as unknown;
  assert.equal(isRecord(lock) && lock.pid === process.pid, true);
  const zh = renderHistoryDetail(createTheme(120, false), 120, item, 'zh').join('\n');
  assert.match(zh, /该记录未保存完整内容/);
  assert.match(zh, /已中断/);
  assert.equal(uiText('zh', 'incompleteModelInput'), '该记录未保存完整内容');
});
