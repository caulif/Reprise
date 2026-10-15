import { DEFAULT_AGENT_DEADLINE_MS } from '../../core/agent-defaults.js';
import { segmentedTimeout } from '../../infrastructure/segmented-timeout.js';
import {
  closeRecoveryRunSession,
  createRecoveryRunSession,
  failRecoveryRunSession,
  type RecoveryRunSession,
} from "./session.js";
import { beginRecoveryStaging } from "./staging.js";
import { runRecoveryForensics } from "./run-forensics.js";
import { enforceRecoveryReadiness, invokeRecoveryAgent } from "./run-model.js";
import { finalizeRecoveredCandidate } from "./run-finalize.js";
import { restoreConfirmedGitStart } from './git-start.js';
import { classifyRecoveryFailureStage } from "./fail.js";
import { finishActivity, registerActivity, activityControlReady } from "../experiment-activity.js";
import { cleanupOperation, throwFailures, type CleanupFailure } from '../experiment-startup.js';
import { recordRecoveryAttempt } from './session.js';
import { recoveryAttemptRecord } from './orchestrator.js';
import type { RecoveryAttemptInput } from "./input.js";
import type { RecoveryAttempt } from "./types.js";
import { harnessConfigurationScope } from '../harness-configuration.js';
import type { HarnessConfigurationReference } from '../../core/schema.js';

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt } from "./types.js";
export type { RecoveryAttemptInput, RecoveryAttemptMode } from "./input.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  const localAbort = new AbortController();
  const deadline = new AbortController();
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), localAbort.signal, deadline.signal]);
  const deadlineStartedAt = performance.now();
  let cancelDeadline = segmentedTimeout(() => deadline.abort(), input.timeoutMs ?? DEFAULT_AGENT_DEADLINE_MS);
  let activity = input.activity;
  let session: RecoveryRunSession | undefined;
  let result: RecoveryAttempt | undefined;
  let initializing = false;
  let effectiveReference: HarnessConfigurationReference | undefined;
  const initializationStartedAt = Date.now();
  const failures: unknown[] = [];
  const cleanup: CleanupFailure[] = [];
  try {
    session = await createRecoveryRunSession({ ...input, signal });
    await session.store.acquireWriter();
    session.writerAcquired = true;
    initializing = true;
    await recordRecoveryAttempt(session, recoveryAttemptRecord({ attemptId: 'recovery-attempt-initialization-started', phase: 'staging',
      operation: 'initialize', attemptNumber: 1, result: 'started', durationMs: 0, recordedAt: input.now }));
    activity ??= registerActivity({ kind: 'prepare', experimentId: input.experimentId, runId: input.runId,
      dataDir: input.dataDir, cancel: async () => { localAbort.abort(); } });
    activity.cancel = async () => { localAbort.abort(); };
    session.preflightOperation = 'publish_activity_control';
    input.onActivity?.(activity);
    await activityControlReady(activity);
    session.preflightOperation = 'initialize_recovery_agent';
    if (input.resolveRecovery) session.input = { ...session.input, recovery: await input.resolveRecovery(signal,
      harnessConfigurationScope(session.store, { experimentId: input.experimentId, runId: input.runId, operation: 'recovery' },
        (reference, configuration) => {
          effectiveReference = reference;
          if (input.timeoutMs !== undefined && input.timeoutMs !== configuration.recovery.operationTotal.milliseconds)
            throw new Error('Explicit Recovery timeout conflicts with the bound effective operation budget.');
          cancelDeadline();
          const remaining = configuration.recovery.operationTotal.milliseconds - (performance.now() - deadlineStartedAt);
          if (remaining <= 0) deadline.abort();
          else cancelDeadline = segmentedTimeout(() => deadline.abort(), remaining);
          signal.throwIfAborted();
        })) };
    signal.throwIfAborted();
    await recordRecoveryAttempt(session, recoveryAttemptRecord({ attemptId: 'recovery-attempt-initialization-completed', phase: 'staging',
      operation: 'initialize', attemptNumber: 1, result: 'succeeded', durationMs: Date.now() - initializationStartedAt, recordedAt: new Date().toISOString(),
      ...(effectiveReference ? { effectiveReference } : {}) }));
    initializing = false;
    session.preflightOperation = 'begin_recovery_staging';
    result = await runRecoverExperiment(session);
  } catch (error) {
    if (!session?.writerAcquired) failures.push(error);
    else try {
      if (initializing) await recordRecoveryAttempt(session, recoveryAttemptRecord({ attemptId: 'recovery-attempt-initialization-failed', phase: 'staging',
        operation: 'initialize', attemptNumber: 1, result: 'failed', failureCode: 'initialization_failed',
        durationMs: Date.now() - initializationStartedAt, recordedAt: new Date().toISOString(), ...(effectiveReference ? { effectiveReference } : {}) }));
      if (signal.aborted) {
        session.failureStage = deadline.signal.aborted ? 'agent_timeout' : 'cancelled';
        session.recovery = { status: 'cancelled' };
      }
      const completed = session.lastCompletedRecovery ?? session.recovery;
      result = session.finalizationStarted && session.activeProviderPreview && completed?.status === 'completed'
        && !(error instanceof Error && (error as Error & { code?: string }).code === 'source_tripwire_failed')
        ? completedDecisionWithFinalizationFailure(session, error) : await failRecoveryRunSession(session, error);
      if (initializing) failures.push(error);
    } catch (persistenceError) {
      failures.push(error, persistenceError);
    }
  } finally {
    cancelDeadline();
  }
  if (activity) await cleanupOperation(cleanup, 'activity', () => finishActivity(activity));
  if (session) await cleanupOperation(cleanup, 'recovery_session', () => closeRecoveryRunSession(session));
  throwFailures([...failures, ...cleanup.map(item => item.error)], 'Recovery and cleanup failed.');
  if (!result) throw new Error('Recovery finished without a result.');
  return result;
}

function completedDecisionWithFinalizationFailure(
  session: RecoveryRunSession,
  error: unknown,
): RecoveryAttempt {
  const recovery = session.lastCompletedRecovery ?? session.recovery;
  const preview = session.activeProviderPreview;
  if (!recovery || recovery.status !== 'completed' || !preview)
    throw error;
  return {
    baseline: preview.baseline,
    providerPreview: preview,
    ...(session.staging ? { staging: session.staging } : {}),
    recovery,
    finalizationFailure: {
      stage: session.failureStage,
      message: error instanceof Error ? error.message : String(error),
    },
    experimentRoot: session.experimentRoot,
    experimentId: session.input.experimentId,
    provider: session.provider,
  };
}

async function runRecoverExperiment(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  session.input.signal?.throwIfAborted();
  await beginRecoveryStaging(session);
  session.input.signal?.throwIfAborted();
  if (session.input.gitStart) {
    await restoreConfirmedGitStart(session);
    session.finalizationStarted = true;
    return finalizeRecoveredCandidate(session);
  }
  await runRecoveryForensics(session);
  session.input.signal?.throwIfAborted();
  await invokeRecoveryAgent(session);
  session.input.signal?.throwIfAborted();
  await enforceRecoveryReadiness(session);
  session.input.signal?.throwIfAborted();
  session.finalizationStarted = true;
  return finalizeRecoveredCandidate(session);
}
