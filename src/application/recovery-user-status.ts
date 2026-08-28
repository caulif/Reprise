import { Value } from "@sinclair/typebox/value";
import { join } from "node:path";
import {
  RecoveryAttemptDiagnosisSchema,
  type RecoveryAttemptDiagnosis,
  type TaskCase,
} from "../core/schema.js";
import type { EnvironmentBaseline } from "../environment/local-workspace-provider.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";

export type UserRecoveryStatus = RecoveryAttemptDiagnosis["finalStatus"];

export function userRecoveryStatus(input: {
  baseline: EnvironmentBaseline;
  transcriptOk: boolean;
}): UserRecoveryStatus {
  if (!input.transcriptOk) return "failed";
  if (input.baseline.mode === "unsupported") return "failed";
  const excluded = input.baseline.budget?.excludedEntries?.length ?? 0;
  const recovery = input.baseline.recovery?.status;
  const match = input.baseline.match;
  if (excluded > 0 || recovery === "partial" || match === "recovered_partial") return "partial";
  if (recovery === "failed" || match === "current_state_fallback") return "partial";
  if (recovery === "recovered" || match === "recovered") return "recovered";
  return "partial";
}

export function recoveryAttemptDiagnosis(input: {
  taskCase: TaskCase;
  baseline: EnvironmentBaseline;
  transcriptOk: boolean;
  recoveryAgentStarted: boolean;
  retryable: boolean;
  reasonCode: string;
}): RecoveryAttemptDiagnosis {
  const excludedEntries = [...(input.baseline.budget?.excludedEntries ?? [])];
  const finalStatus = userRecoveryStatus({
    baseline: input.baseline,
    transcriptOk: input.transcriptOk,
  });
  const diagnosis: RecoveryAttemptDiagnosis = {
    schemaVersion: 1,
    sessionId: input.taskCase.source.sessionId,
    sourcePath: input.taskCase.source.sourcePath ?? input.taskCase.source.sessionId,
    transcriptStatus: input.transcriptOk
      ? input.taskCase.evidenceLevel === "history"
        ? "partial"
        : "ok"
      : "invalid",
    workspaceStatus:
      input.baseline.mode === "unsupported"
        ? "unavailable"
        : excludedEntries.length || input.baseline.readiness?.runnable === "blocked"
          ? "partial"
          : "complete",
    excludedEntries,
    recoveryAgentStarted: input.recoveryAgentStarted,
    finalStatus,
    retryable: input.retryable,
    reasonCode: input.reasonCode,
  };
  if (!Value.Check(RecoveryAttemptDiagnosisSchema, diagnosis)) {
    throw new Error("Recovery attempt diagnosis does not match RecoveryAttemptDiagnosisSchema.");
  }
  return diagnosis;
}

export async function persistRecoveryAttemptDiagnosis(
  experimentRoot: string,
  diagnosis: RecoveryAttemptDiagnosis,
): Promise<void> {
  await writeImmutableJson(join(experimentRoot, "recovery-diagnosis.json"), diagnosis);
}
