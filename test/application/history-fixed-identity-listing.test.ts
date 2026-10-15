import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sealTaskCase } from '../../src/core/task-case-identity.js';
import { sha256 } from '../../src/core/identity.js';
import { publishFrozenCase } from '../../src/products/shared/freeze.js';
import { readTaskCase } from '../../src/products/shared/task-case-reader.js';
import { startExperiment } from '../../src/application/experiment.js';
import { comparePersistedExperiment } from '../../src/application/experiment-compare-persisted.js';
import { readLocalHistoryListing, readLocalHistoryExperiment } from '../../src/application/experiment-history-list.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

test('fixed identity listing defers file verification while details and comparison reject tampered bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-fixed-listing-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const content = Buffer.from('alpha');
  const task = sealTaskCase({ ...base.taskCase, initialInput: { ...base.taskCase.initialInput, role: 'user' },
    transcript: [{ ...base.taskCase.initialInput, role: 'user' }] },
  [{ relativePath: 'evidence.txt', byteLength: content.length, contentHash: sha256(content) }]);
  await publishFrozenCase({ casesRoot: join(base.dataDir, 'cases'), taskCase: task,
    files: [{ relativePath: 'evidence.txt', content }] });
  const casePath = join(base.dataDir, 'cases', task.caseId, 'case.json');
  const taskCase = await readTaskCase(casePath, { requireComplete: true });
  const runInput = { ...base, caseId: task.caseId, taskCase, compare: false };
  const first = await startExperiment(runInput).result;
  await startExperiment({ ...runInput, runId: 'second-run' }).result;
  assert.equal((await readLocalHistoryExperiment(base.dataDir, base.experimentId)).taskCaseFilesVerified, true);

  const evidencePath = join(base.dataDir, 'cases', task.caseId, 'evidence.txt');
  await writeFile(evidencePath, 'omega');
  const listing = await readLocalHistoryListing(base.dataDir);
  assert.equal(listing.cases[0]!.filesVerified, false);
  const experiment = listing.experiments[0]!;
  assert.equal(experiment.taskIdentity, 'fixed-v2');
  assert.equal(experiment.taskCaseFilesVerified, false);
  assert.equal(experiment.modelInputAudit, 'not_checked');
  assert.equal(experiment.formatError, undefined);
  assert.equal(experiment.runId, 'second-run');
  assert.equal(experiment.taskTitle, task.initialInput.text.replace(/\s+/g, ' ').trim());
  assert.equal((await readLocalHistoryExperiment(base.dataDir, base.experimentId)).formatError, 'fixed_task_identity_mismatch');
  await assert.rejects(readTaskCase(casePath, { requireComplete: true }));
  let initialized = 0;
  await assert.rejects(comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId,
    runId: first.record.attempt.runId, policy: base.policy, now: base.now,
    resolveAgents: async () => { initialized++; throw new Error('must not initialize'); } }));
  assert.equal(initialized, 0);
  assert.equal(await readFile(evidencePath, 'utf8'), 'omega');

  await writeFile(casePath, JSON.stringify({ ...task, initialInput: { ...task.initialInput, text: 'Untrusted replacement title' } }));
  const changed = (await readLocalHistoryListing(base.dataDir)).experiments[0]!;
  assert.equal(changed.formatError, 'fixed_task_identity_mismatch');
  assert.equal(changed.taskTitle, undefined);
  assert.equal(changed.runId, 'second-run');
});
