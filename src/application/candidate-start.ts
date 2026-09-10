import type { RecoveryAttempt } from "./recovery/types.js";
import type { RecoveryView } from "./recovery/view.js";
import { userRecoveryStatus } from "./recovery/user-status.js";

export type CandidateStartGate = {
  sourceBaseline?: string;
  blockedReasons: readonly string[];
  recovery?: {
    hasAccept: boolean;
    hasStaging: boolean;
    baselineMode: string;
    runnable?: string;
    envelopeStatus?: string;
    userStatus?: "recovered" | "partial" | "failed";
  };
};

/** Candidate start is an application rule: no runnable sealed scene, no CandidateRun. */
export function candidateStartBlocked(input: CandidateStartGate): string | undefined {
  if (input.recovery) {
    if (input.recovery.envelopeStatus === "blocked" || input.recovery.envelopeStatus === "insufficient_evidence") {
      return "Candidate was not started because recovery did not produce a runnable workspace.";
    }
    if (input.recovery.baselineMode === "unsupported" || input.recovery.runnable === "unsupported" || input.recovery.runnable === "blocked") {
      return "Candidate was not started because recovery did not produce a runnable workspace.";
    }
    if (!input.recovery.hasStaging) {
      return "Candidate was not started because recovery staging is incomplete.";
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
  return candidateGateFromView(
    {
      baseline: attempt.baseline,
      hasAccept: attempt.accept !== undefined,
      recovery: attempt.recovery,
      ...(attempt.staging ? { staging: attempt.staging } : {}),
    },
    transcriptOk,
  );
}

export function candidateGateFromView(view: Pick<RecoveryView, "baseline" | "hasAccept" | "staging"> & { recovery?: RecoveryView["recovery"] }, transcriptOk: boolean): CandidateStartGate {
  return {
    blockedReasons: [],
    recovery: {
      hasAccept: view.hasAccept,
      hasStaging: Boolean(view.staging),
      baselineMode: view.baseline.mode,
      ...(view.baseline.readiness?.runnable ? { runnable: view.baseline.readiness.runnable } : {}),
      ...(view.recovery?.status === "completed" ? { envelopeStatus: view.recovery.value.status } : {}),
      userStatus: userRecoveryStatus({
        baseline: view.baseline,
        transcriptOk,
        hasAccept: view.hasAccept,
      }),
    },
  };
}

export function assertCandidateStartAllowed(gate: CandidateStartGate): void {
  const blocked = candidateStartBlocked(gate);
  if (blocked) throw new Error(blocked);
}
