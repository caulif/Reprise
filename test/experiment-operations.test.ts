import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RUN_POLICY, createExperimentWorkflow } from '../src/application/experiment-workflow.js';
import { candidateStartBlocked } from '../src/application/candidate-start.js';
import { prepareExperiment, runFullExperiment, runPreparedExperiment } from '../src/application/experiment-operations.js';
import type { RecoveryAttempt } from '../src/application/recovery/types.js';

async function runnableAttempt(t: { after: (fn: () => Promise<void>) => void }): Promise<RecoveryAttempt> {
  const experimentRoot = await mkdtemp(join(tmpdir(), 'reprise-ops-'));
  t.after(async () => rm(experimentRoot, { recursive: true, force: true }));
  return {
    baseline: { mode: 'canonical', fingerprint: { digest: 'a', fileCount: 0, totalBytes: 0 }, match: 'recovered', readiness: { runnable: 'isolated' } },
    recovery: { status: 'completed', sessionId: 'recovery-1', value: { status: 'recovered', reportPath: 'recovery.md', unresolved: [], evidenceRefs: ['event:e1'] } },
    experimentRoot,
    experimentId: 'experiment-step',
    provider: {} as RecoveryAttempt['provider'],
    accept: async () => ({ mode: 'canonical', fingerprint: { digest: 'a', fileCount: 0, totalBytes: 0 }, match: 'recovered' }),
    staging: {} as RecoveryAttempt['staging'],
  } as unknown as RecoveryAttempt;
}

test('default run policy is a last-resort safety valve owned by the experiment workflow', () => {
  assert.equal(DEFAULT_RUN_POLICY.maxTargetTurns, 256);
  assert.equal(typeof createExperimentWorkflow, 'function');
});

test('full run is prepare then the same scene-run function', async (t) => {
  const calls: string[] = [];
  const attempt = await runnableAttempt(t);
  const handle = { result: Promise.resolve({ record: { state: 'finished' } }) };
  const workflow = {
    recover: async () => {
      calls.push('prepare');
      return attempt;
    },
    start: async (request: { recoveryAttempt?: RecoveryAttempt }) => {
      calls.push('run');
      assert.equal(request.recoveryAttempt, attempt);
      return handle as never;
    },
  };
  const taskCase = { caseId: 'case-step', initialInput: { text: 'Fix the report.' } } as never;
  const stepwisePrepare = await prepareExperiment(workflow, { taskCase, sourceRoot: '/src' });
  const stepwise = await runPreparedExperiment(workflow, { taskCase, sourceRoot: '/src', onEvent: () => {}, recoveryAttempt: stepwisePrepare });
  assert.deepEqual(calls, ['prepare', 'run']);
  assert.equal(stepwise, handle);
  calls.length = 0;
  const full = await runFullExperiment(workflow, { taskCase, sourceRoot: '/src', onEvent: () => {} });
  assert.deepEqual(calls, ['prepare', 'run']);
  assert.equal(full, handle);
});

test('scene run refuses a candidate before prepare completes', async () => {
  await assert.rejects(
    runPreparedExperiment({ recover: async () => { throw new Error('unused'); }, start: async () => { throw new Error('must not start'); } }, {
      taskCase: { caseId: 'case-step', initialInput: { text: 'Fix the report.' } } as never,
      sourceRoot: '/src',
      onEvent: () => {},
    }),
    /before scene prepare completes/,
  );
});

test('scene run refuses a failed recovery without accept', async (t) => {
  const attempt = {
    ...(await runnableAttempt(t)),
    accept: undefined,
    baseline: { mode: 'canonical', fingerprint: { digest: 'a', fileCount: 0, totalBytes: 0 }, match: 'current_state_fallback' },
  } as unknown as RecoveryAttempt;
  await assert.rejects(
    runPreparedExperiment({ recover: async () => attempt, start: async () => { throw new Error('must not start'); } }, {
      taskCase: { caseId: 'case-step', initialInput: { text: 'Fix the report.' } } as never,
      sourceRoot: '/src',
      onEvent: () => {},
      recoveryAttempt: attempt,
    }),
    /did not produce a runnable workspace/,
  );
});

test('candidate start gate stays on application owners', () => {
  assert.equal(
    candidateStartBlocked({
      sourceBaseline: 'unavailable',
      blockedReasons: ['symlink outside root'],
      recovery: { hasAccept: true, hasStaging: true, baselineMode: 'canonical', runnable: 'isolated' },
    }),
    undefined,
  );
  assert.match(
    candidateStartBlocked({
      blockedReasons: [],
      recovery: { hasAccept: false, hasStaging: false, baselineMode: 'canonical', userStatus: 'failed' },
    }) ?? '',
    /runnable workspace/,
  );
});
