import type { RecoveryAttempt } from "./experiment.js";
import { userRecoveryStatus } from "./recovery-user-status.js";

export type CandidateStartGate = {
  sourceBaseline?: string;
  blockedReasons: readonly string[];
  recovery?: {
    hasAccept: boolean;
    hasStaging: boolean;
    baselineMode: string;
    runnable?: string;
    userStatus?: "recovered" | "partial" | "failed";
  };
};

/** Candidate start is an application rule: no runnable sealed scene, no CandidateRun. */
export function candidateStartBlocked(input: CandidateStartGate): string | undefined {
  if (input.recovery) {
    if (input.recovery.baselineMode === "unsupported" || input.recovery.runnable === "unsupported" || input.recovery.runnable === "blocked") {
      return "Candidate was not started because recovery did not produce a runnable workspace.";
    }
    if (!input.recovery.hasAccept || input.recovery.userStatus === "failed") {
      return "Candidate was not started because recovery did not produce a runnable workspace.";
    }
    return undefined;
  }
  if (input.sourceBaseline === "unavailable" || input.blockedReasons.length) {
    return input.blockedReasons.length
      ? input.blockedReasons.join(" | ")
      : "Candidate was not started because the source baseline is unavailable.";
  }
  return undefined;
}

export function candidateGateFromAttempt(attempt: RecoveryAttempt, transcriptOk: boolean): CandidateStartGate {
  return {
    blockedReasons: [],
    recovery: {
      hasAccept: attempt.accept !== undefined,
      hasStaging: Boolean(attempt.staging),
      baselineMode: attempt.baseline.mode,
      ...(attempt.baseline.readiness?.runnable ? { runnable: attempt.baseline.readiness.runnable } : {}),
      userStatus: userRecoveryStatus({
        baseline: attempt.baseline,
        transcriptOk,
        hasAccept: attempt.accept !== undefined,
      }),
    },
  };
}

export function assertCandidateStartAllowed(gate: CandidateStartGate): void {
  const blocked = candidateStartBlocked(gate);
  if (blocked) throw new Error(blocked);
}
