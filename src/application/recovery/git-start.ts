import { Value } from '@sinclair/typebox/value';
import { runOperationId } from '../../core/identity.js';
import { RecoveryGitStartSchema } from '../../core/schema.js';
import { recordRecoveryAttempt, type RecoveryRunSession } from './session.js';
import { recoveryAttemptRecord } from './orchestrator.js';

export async function restoreConfirmedGitStart(session: RecoveryRunSession): Promise<void> {
  const { input, staging, store, provider } = session;
  if (!staging || !input.gitStart || !Value.Check(RecoveryGitStartSchema, input.gitStart))
    throw new Error('Confirmed Git start was not prepared.');
  const started = Date.now();
  await store.append({
    type: 'recovery.git_start_requested', runId: input.runId,
    operationId: runOperationId(input.runId, 'git-start-requested'), payload: input.gitStart,
  });
  session.preflightOperation = 'recovery_git_start';
  await provider.restoreGitStart(staging, input.gitStart, input.signal);
  input.signal?.throwIfAborted();
  const fingerprint = await provider.fingerprintRecoveryStaging(staging);
  await store.append({
    type: 'recovery.git_start_restored', runId: input.runId,
    operationId: runOperationId(input.runId, 'git-start-restored'),
    payload: { commit: input.gitStart.commit, inputs: input.gitStart.inputs, digest: fingerprint.digest, durationMs: Date.now() - started },
  });
  await recordRecoveryAttempt(session, recoveryAttemptRecord({
    attemptId: 'recovery-attempt-git-start', phase: 'staging', operation: 'restore_confirmed_git_start',
    attemptNumber: 1, result: 'succeeded', durationMs: Date.now() - started, recordedAt: new Date().toISOString(),
  }));
  session.recovery = {
    status: 'completed', sessionId: `provider-${input.runId}`,
    value: { status: 'ready', summary: 'Confirmed task-before Git commit and hashed inputs restored; dependencies and build were not checked.', reportPath: 'recovery.md', unresolved: [] },
  };
}
