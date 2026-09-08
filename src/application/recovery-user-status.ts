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
  hasAccept?: boolean;
}): UserRecoveryStatus {
  if (!input.transcriptOk) return "failed";
  if (input.baseline.mode === "unsupported") return "failed";
  if (input.baseline.recovery?.status === "insufficient_evidence") return "failed";
  if (input.baseline.readiness?.runnable === "blocked") return "failed";
  const excluded = input.baseline.budget?.excludedEntries?.length ?? 0;
  const recovery = input.baseline.recovery?.status;
  const match = input.baseline.match;
  const hasAccept = input.hasAccept === true;
  if ((recovery === "failed" || match === "current_state_fallback") && !hasAccept) return "failed";
  if (excluded > 0 || recovery === "partial" || match === "recovered_partial") return "partial";
  if (recovery === "recovered" || match === "recovered") return "recovered";
  return hasAccept ? "partial" : "failed";
}

/** Operator accept/start is never offered for insufficient evidence or a blocked workspace. */
export function recoveryAcceptIsExposed(input: {
  automaticallyAccepted?: boolean;
  envelopeStatus?: string | undefined;
  match?: string | undefined;
  runnable?: string | undefined;
}): boolean {
  if (input.automaticallyAccepted === true) return true;
  if (input.envelopeStatus === "insufficient_evidence") return false;
  if (input.match === "current_state_fallback") return false;
  if (input.runnable === "blocked" || input.runnable === "unsupported") return false;
  return input.envelopeStatus === "recovered" || input.envelopeStatus === "partial";
}

export function diagnosisReasonCode(input: {
  baseline: EnvironmentBaseline;
  transcriptOk: boolean;
  failureStage?: string;
  hasAccept?: boolean;
}): string {
  if (!input.transcriptOk) return "transcript.invalid";
  const status = userRecoveryStatus({
    baseline: input.baseline,
    transcriptOk: input.transcriptOk,
    ...(input.hasAccept !== undefined ? { hasAccept: input.hasAccept } : {}),
  });
  if (status === "recovered") return "recovered";
  if (status === "partial") {
    const excluded = input.baseline.budget?.excludedEntries?.[0]?.reasonCode;
    if (input.baseline.recovery?.status === "partial" || input.baseline.match === "recovered_partial") {
      return "weak_or_incomplete_evidence";
    }
    return excluded ?? "weak_or_incomplete_evidence";
  }
  const stage = input.failureStage ?? input.baseline.recovery?.failureStage;
  if (stage) return stage;
  const excluded = input.baseline.budget?.excludedEntries?.[0]?.reasonCode;
  if (excluded) return excluded;
  return "recovery_agent.failed";
}

export function recoveryAttemptDiagnosis(input: {
  taskCase: TaskCase;
  baseline: EnvironmentBaseline;
  transcriptOk: boolean;
  recoveryAgentStarted: boolean;
  retryable: boolean;
  reasonCode: string;
  hasAccept?: boolean;
}): RecoveryAttemptDiagnosis {
  const excludedEntries = [...(input.baseline.budget?.excludedEntries ?? [])];
  const finalStatus = userRecoveryStatus({
    baseline: input.baseline,
    transcriptOk: input.transcriptOk,
    ...(input.hasAccept !== undefined ? { hasAccept: input.hasAccept } : {}),
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
