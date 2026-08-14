import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { readLocalHistory } from '../src/tui/local-history.js';

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
});

test('local history reclaims released baseline copies before reporting size', async (t) => {
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
  await assert.rejects(stat(baseline), { code: 'ENOENT' });
  assert.ok((history.experiments[0]?.sizeBytes ?? 0) < 4096);
});
