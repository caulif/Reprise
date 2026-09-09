import {
  closeRecoveryRunSession,
  createRecoveryRunSession,
  failRecoveryRunSession,
  type RecoveryRunSession,
} from "./session.js";
import { beginRecoveryStaging, tryHostCheckpointRecovery } from "./run-preflight.js";
import { runRecoveryForensics } from "./run-forensics.js";
import { enforceRecoveryReadiness, invokeRecoveryAgent } from "./run-model.js";
import { finalizeRecoveredCandidate } from "./run-finalize.js";
import { classifyRecoveryFailureStage } from "./fail.js";
import { finishExperimentActivity, registerActivity, activityControlReady } from "../experiment-activity.js";
import type { RecoveryAttempt, RecoveryAttemptInput } from "./types.js";

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt, RecoveryAttemptInput, RecoveryAttemptMode } from "./types.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  const localAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, localAbort.signal]) : localAbort.signal;
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

async function runRecoverExperiment(session: RecoveryRunSession): Promise<RecoveryAttempt> {
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
