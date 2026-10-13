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
import { finishExperimentActivity, registerActivity, activityControlReady } from "../experiment-activity.js";
import type { RecoveryAttemptInput } from "./input.js";
import type { RecoveryAttempt } from "./types.js";

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt } from "./types.js";
export type { RecoveryAttemptInput, RecoveryAttemptMode } from "./input.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  const localAbort = new AbortController();
  const deadline = AbortSignal.timeout(30 * 60_000);
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), localAbort.signal, deadline]);
  const activity = input.activity ?? registerActivity({
    kind: "prepare",
    experimentId: input.experimentId,
    runId: input.runId,
    dataDir: input.dataDir,
    cancel: async () => {
      localAbort.abort();
    },
  });
  if (input.activity) activity.cancel = async () => { localAbort.abort(); };
  await activityControlReady(activity);
  let session: RecoveryRunSession | undefined;
  try {
    session = await createRecoveryRunSession({ ...input, signal });
    return await runRecoverExperiment(session);
  } catch (error) {
    if (!session) throw error;
    if (signal.aborted) {
      session.failureStage = deadline.aborted ? "agent_timeout" : "cancelled";
      session.recovery = { status: 'cancelled' };
      return await failRecoveryRunSession(session, error);
    }
    const completed = session.lastCompletedRecovery ?? session.recovery;
    if (session.finalizationStarted && session.activeProviderPreview && completed?.status === "completed"
      && !(error instanceof Error && (error as Error & { code?: string }).code === "source_tripwire_failed"))
      return completedDecisionWithFinalizationFailure(session, error);
    return await failRecoveryRunSession(session, error);
  } finally {
    if (session) await closeRecoveryRunSession(session);
    await finishExperimentActivity(input.experimentId);
  }
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
