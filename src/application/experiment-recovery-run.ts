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
import type { RecoveryAttempt, RecoveryAttemptInput } from "./experiment-recovery-types.js";

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt, RecoveryAttemptInput, RecoveryAttemptMode } from "./experiment-recovery-types.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverCodexExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  const session = await createRecoveryRunSession(input);
  try {
    return await runRecoverCodexExperiment(session);
  } catch (error) {
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
    await closeRecoveryRunSession(session);
  }
}

async function runRecoverCodexExperiment(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  await beginRecoveryStaging(session);
  const checkpoint = await tryHostCheckpointRecovery(session);
  if (checkpoint) return checkpoint;
  await runRecoveryForensics(session);
  await invokeRecoveryAgent(session);
  await enforceRecoveryReadiness(session);
  return finalizeRecoveredCandidate(session);
}
