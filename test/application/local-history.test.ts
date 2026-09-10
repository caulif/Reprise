import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { readLocalHistory } from '../../src/tui/local-history.js';
import { renderHistoryDetail } from '../../src/tui/pages/history.js';
import { t as uiText } from '../../src/tui/i18n.js';
import { createTheme } from '../../src/tui/theme.js';
import { sha256 } from '../../src/core/identity.js';
import { isRecord } from '../../src/core/json.js';

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
  assert.equal(failed.reportKind, 'Previous report');
  assert.equal(failed.reportPath, join(experiment, 'report.html'));
  await writeFile(join(experiment, 'comparison-failure.html'), 'failure diagnosis');
  const diagnostic = (await readLocalHistory(root)).experiments[0]!;
  assert.equal(diagnostic.reportKind, 'Diagnostic');
  assert.equal(diagnostic.reportPath, join(experiment, 'comparison-failure.html'));
  assert.equal(await readFile(join(experiment, 'report.html'), 'utf8'), 'report bytes');
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
