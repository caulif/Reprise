import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { recoverExperiment } from '../../src/application/recovery/recover.js';
import { compactRecoveryProviderRoot } from '../../src/application/recovery-provider-layout.js';
import { loadSealedScene, persistPreparedScene } from '../../src/application/experiment-scene.js';
import { replicaWorkspaceLocation } from '../../src/application/result-paths.js';
import { candidateGateFromAttempt, candidateStartBlocked } from '../../src/application/candidate-start.js';
import { LocalWorkspaceProvider, type RecoveryStaging } from '../../src/environment/local-workspace-provider.js';
import type { RecoveryAttemptDiagnosis, RecoveryExplanation } from '../../src/core/schema.js';
import { GitPathLimitError } from '../../src/environment/git-sink.js';
import { recoveryPreflightDiagnostic } from '../../src/application/recovery/staging-diagnostic.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { now, VerifiedRuntime, input } from '../codex-experiment-support.js';

const exec = promisify(execFile);

test('ordinary Recovery uses compact paths with real Git and UUIDs, reloads its scene and prepares a candidate', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r-path-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(root, 'source');
  await mkdir(source);
  const git = async (...args: string[]) => (await exec('git', args, { cwd: source, windowsHide: true })).stdout.trim();
  await git('init');
  await writeFile(join(source, 'README.md'), 'before\n');
  await git('add', '.');
  await git('-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '-m', 'before');
  const commit = await git('rev-parse', 'HEAD');
  await writeFile(join(source, 'README.md'), 'historical answer\n');
  const base = input(root, new VerifiedRuntime());
  const taskCase = { ...base.taskCase, taskContext: { historicalCommit: commit } };
  const experimentId = `recovery-${randomUUID()}`;
  const runId = `recovery-run-${randomUUID()}`;
  let modelCalls = 0;
  const attempt = await recoverExperiment({
    dataDir: base.dataDir, caseId: base.caseId, experimentId, runId, sourceRoot: source, taskCase, now,
    recovery: { recover: async (_context, tools) => {
      modelCalls++;
      const writer = tools.find(tool => tool.name === 'write');
      assert.ok(writer);
      await writer.execute({ path: 'README.md', content: 'before\n' }, new AbortController().signal);
      return { status: 'completed', sessionId: 'scripted-recovery', value: {
        status: 'ready', summary: 'Restored the task-start file.', reportPath: 'recovery.md', unresolved: [],
      } };
    } },
  });
  assert.equal(modelCalls, 1);
  assert.equal(attempt.acceptedAutomatically, true, JSON.stringify(attempt.recovery));
  const providerRoot = compactRecoveryProviderRoot(attempt.experimentRoot, runId);
  assert.equal(attempt.baseline.root, join(providerRoot, 'baselines', base.caseId));
  const descriptor = await persistPreparedScene(attempt, source, taskCase);
  assert.equal(descriptor.recoveryProviderLayout, 'compact-v1');
  const reopened = await loadSealedScene(base.dataDir, experimentId);
  assert.equal(reopened.attempt.baseline.root, attempt.baseline.root);
  const candidateId = `candidate-${randomUUID()}`;
  const candidate = await reopened.attempt.provider.prepareRun(reopened.attempt.baseline, candidateId);
  try {
    assert.deepEqual(replicaWorkspaceLocation(attempt.experimentRoot, candidateId, candidate.root), { providerRoot, workspaceRoot: candidate.root });
    assert.equal(replicaWorkspaceLocation(join(base.dataDir, 'experiments', 'another-experiment'), candidateId, candidate.root), undefined);
    assert.match(await readFile(join(candidate.root, 'README.md'), 'utf8'), /^before\r?\n$/);
  } finally {
    await reopened.attempt.provider.release(candidate);
  }
  assert.equal(await readFile(join(source, 'README.md'), 'utf8'), 'historical answer\n');
  assert.equal(await git('rev-parse', 'HEAD'), commit);
});

test('persistent staging failure saves a non-retryable diagnosis without reentering Provider baseline operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r-fail-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const original = new GitPathLimitError(new Error("fatal: '$GIT_DIR' too big at private-source"));
  const staging = t.mock.method(provider, 'beginRecovery', async () => { throw original; });
  const baseline = t.mock.method(provider, 'resolveBaseline', async () => { throw new Error('must not create fallback'); });
  const inspection = t.mock.method(provider, 'inspectBaseline', async () => { throw new Error('must not reinspect source'); });
  const attempt = await recoverExperiment({
    dataDir: base.dataDir, caseId: base.caseId, experimentId: 'persistent-failure', runId: 'failed-run',
    sourceRoot: base.sourceRoot, taskCase: base.taskCase, now, environmentProvider: provider,
    recovery: { recover: async () => { throw new Error('must not start the model'); } },
  });
  assert.equal(staging.mock.callCount(), 1);
  assert.equal(baseline.mock.callCount(), 0);
  assert.equal(inspection.mock.callCount(), 0);
  assert.equal(attempt.baseline.mode, 'unsupported');
  assert.equal(attempt.baseline.root, undefined);
  assert.equal(attempt.baseline.capabilities.canFork, false);
  assert.equal(attempt.baseline.recovery?.sourceDigest, '');
  assert.equal(attempt.baseline.recovery?.recoveredDigest, '');
  assert.ok(candidateStartBlocked(candidateGateFromAttempt(attempt, true)));
  const runRoot = join(attempt.experimentRoot, 'runs', 'failed-run');
  const validation = await readFile(join(runRoot, 'recovery-validation.json'), 'utf8');
  assert.match(validation, /git_path_too_long/);
  assert.doesNotMatch(validation, /private-source|must not/);
  const diagnosis = JSON.parse(await readFile(join(runRoot, 'recovery-diagnosis.json'), 'utf8')) as RecoveryAttemptDiagnosis;
  assert.equal(diagnosis.finalStatus, 'failed');
  assert.equal(diagnosis.retryable, false);
  assert.equal(diagnosis.recoveryAgentStarted, false);
  const explanation = JSON.parse(await readFile(join(runRoot, 'recovery-explanation.json'), 'utf8')) as RecoveryExplanation;
  assert.equal(explanation.summary, 'errorGitSinkPathTooLong');
  const events = await readFile(join(attempt.experimentRoot, 'events.jsonl'), 'utf8');
  assert.match(events, /"fallback":"none"/);
  assert.doesNotMatch(events, /private-source|recovery\.preflight_retry/);
  await assert.rejects(stat(join(attempt.experimentRoot, 'writer.lock')), { code: 'ENOENT' });
  assert.equal(recoveryPreflightDiagnostic(original.cause, 'begin_recovery_staging').reasonCode, 'git_path_too_long');
  assert.equal(recoveryPreflightDiagnostic(Object.assign(new Error('path limit'), { code: 'ENAMETOOLONG' }), 'begin_recovery_staging').retryable, false);
});

for (const fault of ['cleanup', 'persistence', 'both'] as const) {
  test(`failure diagnostics precede staging cleanup and persistence faults still release source locks (${fault})`, async t => {
    const persistenceFault = fault !== 'cleanup';
    const root = await mkdtemp(join(tmpdir(), 'r-cleanup-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const base = input(root, new VerifiedRuntime());
    await mkdir(base.sourceRoot);
    await writeFile(join(base.sourceRoot, 'README.md'), 'source');
    const provider = new LocalWorkspaceProvider(join(root, 'provider'));
    const discard = provider.discardRecovery.bind(provider);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The fault injector calls the saved method with the actual Store below.
    const commitArtifact = ExperimentStore.prototype.commitArtifact;
    t.mock.method(ExperimentStore.prototype, 'commitArtifact', async function (this: ExperimentStore, artifact: Parameters<typeof commitArtifact>[0]) {
      if (persistenceFault && artifact.operationId === 'recovery-attempts-failed-created') throw new Error('diagnostic disk failure');
      return commitArtifact.call(this, artifact);
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The fault injector calls the saved method with the actual Store below.
    const append = ExperimentStore.prototype.append;
    t.mock.method(ExperimentStore.prototype, 'append', async function (this: ExperimentStore, event: Parameters<typeof append>[0]) {
      if (fault === 'both' && event.type === 'recovery.cleanup_failed') throw new Error('cleanup audit failure');
      return append.call(this, event);
    });
    const experimentId = 'failure-order';
    const runId = 'failure-order-run';
    const discardMock = t.mock.method(provider, 'discardRecovery', async (staging: RecoveryStaging) => {
      if (!persistenceFault) {
        const diagnosis = JSON.parse(await readFile(join(base.dataDir, 'experiments', experimentId, 'runs', runId, 'recovery-diagnosis.json'), 'utf8')) as RecoveryAttemptDiagnosis;
        assert.equal(diagnosis.finalStatus, 'failed');
      }
      await discard(staging);
      if (fault !== 'persistence') throw new Error('cleanup failure after releasing source');
    });
    const operation = recoverExperiment({
      dataDir: base.dataDir, caseId: base.caseId, experimentId, runId, sourceRoot: base.sourceRoot,
      taskCase: base.taskCase, now, environmentProvider: provider, maxModelAttempts: 1,
      recovery: { recover: async () => ({ status: 'failed', failure: {
        code: 'agent_failure', kind: 'protocol', message: 'scripted model failure', attempts: 1,
      } }) },
    });
    if (persistenceFault) {
      await assert.rejects(operation, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        const failures = (error.errors as unknown[]).flatMap(failure => failure instanceof AggregateError ? failure.errors as unknown[] : [failure]);
        assert.ok(failures.some(failure => failure instanceof Error && failure.message === 'diagnostic disk failure'));
        if (fault === 'both') assert.ok(failures.some(failure => failure instanceof Error && failure.message === 'cleanup audit failure'));
        return true;
      });
    } else {
      const attempt = await operation;
      assert.equal(attempt.cleanupFailed, true);
      assert.ok(attempt.staging);
      assert.match(attempt.baseline.warnings.join('\n'), /cleanup requires review/);
    }
    assert.equal(discardMock.mock.callCount(), 1);
    await writeFile(join(base.sourceRoot, 'README.md'), 'source remains writable');
    await assert.rejects(stat(join(base.dataDir, 'experiments', experimentId, 'writer.lock')), { code: 'ENOENT' });
  });
}

test('ordinary finalize errors retain their stage and redacted message in persisted diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'r-finalize-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot); await writeFile(join(base.sourceRoot, 'input.txt'), 'input');
  const provider = new LocalWorkspaceProvider(join(root, 'provider'));
  const secret = 'testcredential'.repeat(3);
  t.mock.method(provider, 'validateRecovery', async () => { throw new Error(`Git fsck failed: dangling remote HEAD; token=${secret}`); });
  const attempt = await recoverExperiment({ dataDir: base.dataDir, caseId: base.caseId, experimentId: 'finalize-error', runId: 'finalize-error-run', sourceRoot: base.sourceRoot, taskCase: base.taskCase, environmentProvider: provider, now,
    recovery: { recover: async () => ({ status: 'completed', sessionId: 'ready', value: { status: 'ready', summary: 'Ready.', reportPath: 'recovery.md', unresolved: [] } }) },
  });
  assert.equal(attempt.baseline.recovery?.failureStage, 'provider_validation_failed');
  for (const path of ['events.jsonl', 'runs/finalize-error-run/recovery-validation.json']) {
    const text = await readFile(join(attempt.experimentRoot, path), 'utf8');
    assert.match(text, /Git fsck failed: dangling remote HEAD/);
    assert.doesNotMatch(text, new RegExp(secret));
  }
});
