import {
  closeRecoveryRunSession,
  createRecoveryRunSession,
  failRecoveryRunSession,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";
import { beginRecoveryStaging, tryHostCheckpointRecovery } from "./experiment-recovery-run-preflight.js";
import { runRecoveryForensics } from "./experiment-recovery-run-forensics.js";
import { enforceRecoveryReadiness, invokeRecoveryAgent } from "./experiment-recovery-run-model.js";
import { finalizeRecoveredCandidate } from "./experiment-recovery-run-finalize.js";
import { classifyRecoveryFailureStage } from "./experiment-recovery-support.js";
import { finishExperimentActivity, registerActivity, activityControlReady } from "./experiment-activity.js";
import type { RecoveryAttempt, RecoveryAttemptInput } from "./experiment-recovery-types.js";

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt, RecoveryAttemptInput, RecoveryAttemptMode } from "./experiment-recovery-types.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverCodexExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  const localAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, localAbort.signal]) : localAbort.signal;
  const activity = registerActivity({
    kind: "prepare",
    experimentId: input.experimentId,
    runId: input.runId,
    dataDir: input.dataDir,
    cancel: async () => {
      localAbort.abort();
    },
  });
  await activityControlReady(activity);
  let session: RecoveryRunSession | undefined;
  try {
    session = await createRecoveryRunSession({ ...input, signal });
    return await runRecoverCodexExperiment(session);
  } catch (error) {
    if (!session) throw error;
    if (signal.aborted) {
      session.failureStage = 'cancelled';
      session.recovery = { status: 'cancelled' };
      return await failRecoveryRunSession(session, error);
    }
    if (session.lastCompletedRecovery?.status === "completed") {
      session.recovery = session.lastCompletedRecovery;
      try {
        return await finalizeRecoveredCandidate(session);
      } catch (finalizeError) {
        // The completed envelope could not be published; keep the original failure as the terminal record.
        void finalizeError;
        return await failRecoveryRunSession(session, error);
      }
    }
    if (session.recovery?.status === "completed") {
      try {
        return await finalizeRecoveredCandidate(session);
      } catch (finalizeError) {
        void finalizeError;
        return await failRecoveryRunSession(session, error);
      }
    }
    return await failRecoveryRunSession(session, error);
  } finally {
    if (session) await closeRecoveryRunSession(session);
    finishExperimentActivity(input.experimentId);
  }
}

async function runRecoverCodexExperiment(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  session.input.signal?.throwIfAborted();
  await beginRecoveryStaging(session);
  session.input.signal?.throwIfAborted();
  const checkpoint = await tryHostCheckpointRecovery(session);
  session.input.signal?.throwIfAborted();
  if (checkpoint) return checkpoint;
  await runRecoveryForensics(session);
  session.input.signal?.throwIfAborted();
  await invokeRecoveryAgent(session);
  session.input.signal?.throwIfAborted();
  await enforceRecoveryReadiness(session);
  session.input.signal?.throwIfAborted();
  return finalizeRecoveredCandidate(session);
}
