import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { RecoveryResult } from "../../agents/recovery-agent.js";
import { RecoveryExplanationSchema, type RecoveryExplanation } from "../../core/schema.js";
import { persistRecoveryValidationArtifacts } from "./writes.js";
import { recoveryPreflightDiagnostic } from "./staging-diagnostic.js";
import {
  diagnosisReasonCode,
  persistRecoveryAttemptDiagnosis,
  recoveryAttemptDiagnosis,
} from "./user-status.js";
import type { EnvironmentBaseline, LocalWorkspaceProvider, RecoveryStaging } from "../../environment/local-workspace-provider.js";
import { RecoveryValidationError } from "../../environment/local-workspace-provider.js";
import { RecoveryEvidenceValidationError } from "../../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../../infrastructure/agent/host.js";
import { ExperimentStore, writeImmutableJson } from "../../infrastructure/store/experiment-store.js";
import type { RecoveryOrchestrator, RecoveryLifecycleState } from "./orchestrator.js";
import type { RecoveryReadinessResult } from "./readiness.js";
import type { RecoveryAttempt } from "./types.js";
import type { RecoveryAttemptInput } from "./input.js";

export type FailRecoverExperimentInput = {
  error: unknown;
  attemptInput: RecoveryAttemptInput;
  store: ExperimentStore;
  provider: LocalWorkspaceProvider;
  experimentRoot: string;
  staging: RecoveryStaging | undefined;
  recovery: StructuredAgentResult<RecoveryResult> | undefined;
  recoveryOrchestrator: RecoveryOrchestrator;
  lifecycleState: () => RecoveryLifecycleState;
  moveRecoveryState: (next: RecoveryLifecycleState) => void;
  failureStage: NonNullable<EnvironmentBaseline["recovery"]>["failureStage"];
  preflightOperation: string;
  writerAcquired: boolean;
  candidateCreated: boolean;
  recoveredPaths: string[];
  verification: "verified" | "pending_user_review" | "rejected" | "insufficient_evidence";
  forensicsCompleted: boolean;
  evidenceSourcesAttempted: number | undefined;
  evidenceSourcesAvailable: number | undefined;
  hypothesisCount: number | undefined;
  candidateCount: number | undefined;
  verifierRejectionReasons: string[] | undefined;
  providerFailureRetryable: boolean | undefined;
  pathBoundaryRejected: boolean | undefined;
  readinessResult: RecoveryReadinessResult | undefined;
  taskOutcome: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"] | undefined;
  modelAttempts: number;
  toolFailureByTool: Map<string, number>;
  lastToolFailureCategory: string | undefined;
};


export type RecoveryExplanationKey =
  | "recoveryReportMissing"
  | "recoverySourceChanged"
  | "recoveryStagingInvalid"
  | "recoveryPreflightFailed"
  | "harnessTransient"
  | "harnessAuthentication"
  | "harnessProtocol"
  | "harnessFailure";

export function failureExplanationKey(
  stage: string,
  failure?: { kind?: string; code?: string; message?: string },
): { key: RecoveryExplanationKey; params?: Record<string, string | number> } {
  if (stage === "source_tripwire_failed" || failure?.code === "source_tripwire_failed") {
    return { key: "recoverySourceChanged" };
  }
  if (stage === "provider_validation_failed" || failure?.code === "provider_validation_failed") {
    if (failure?.message && /recovery\.md is missing/i.test(failure.message)) return { key: "recoveryReportMissing" };
    return { key: "recoveryStagingInvalid" };
  }
  if (stage === "preflight_failed") return { key: "recoveryPreflightFailed" };
  if (stage === "agent_invalid_output") return { key: "harnessProtocol" };
  if (stage === "runner_crashed") return { key: "harnessFailure" };
  const kind = failure?.kind;
  if (kind === "authentication") return { key: "harnessAuthentication" };
  if (kind === "transient_network" || kind === "transient_upstream" || kind === "timeout" || kind === "rate_limited") {
    return { key: "harnessTransient" };
  }
  if (kind === "protocol") return { key: "harnessProtocol" };
  return { key: "harnessFailure" };
}

function recoveryExplanation(input: FailRecoverExperimentInput, stage: string): RecoveryExplanation {
  const status = stage === "runner_crashed" ? "failed" : "blocked";
  const workspaceStage = stage === "preflight_failed" ? "workspace" : "agent";
  if (input.recovery?.status === "completed") {
    return {
      schemaVersion: 1,
      status,
      stage: workspaceStage,
      reason: stage,
      summary: input.recovery.value.summary,
    };
  }
  const failed = input.recovery?.status === "failed" ? input.recovery.failure : undefined;
  const validation = input.error instanceof RecoveryValidationError ? input.error : undefined;
  const mapped = failureExplanationKey(stage, {
    ...(failed?.kind ? { kind: failed.kind } : {}),
    ...(validation?.code ? { code: validation.code } : {}),
    ...(input.error instanceof Error ? { message: input.error.message } : failed?.message ? { message: failed.message } : {}),
  });
  return {
    schemaVersion: 1,
    status,
    stage: workspaceStage,
    reason: stage,
    summary: mapped.key,
    ...(mapped.params ? { summaryParams: mapped.params } : {}),
    diagnosis: "host",
  };
}

export async function failRecoverExperiment(input: FailRecoverExperimentInput): Promise<RecoveryAttempt> {
  const settled = await settleFailedRecovery(input);
  const explanation = recoveryExplanation(input, settled.failureStage);
  if (!Value.Check(RecoveryExplanationSchema, explanation)) {
    throw new Error("Recovery explanation does not match RecoveryExplanationSchema.");
  }
  await writeImmutableJson(join(input.experimentRoot, "recovery-explanation.json"), explanation);
  const failed = input.recovery ?? {
    status: "failed" as const,
    failure: {
      code: "agent_failure" as const,
      message: settled.failureMessage,
      attempts: 1,
    },
  };
  const baseline = settled.baseline.recovery
    ? {
        ...settled.baseline,
        recovery: { ...settled.baseline.recovery, summary: explanation.summary },
      }
    : settled.baseline;
  await persistFailedRecoveryArtifacts({
    experimentRoot: input.experimentRoot,
    store: input.store,
    attemptInput: input.attemptInput,
    failed,
    failureStage: settled.failureStage,
    failureMessage: settled.failureMessage,
    error: input.error,
    preflightOperation: input.preflightOperation,
    verifierRejectionReasons: input.verifierRejectionReasons,
  });
  await persistRecoveryAttemptDiagnosis(
    input.experimentRoot,
    recoveryAttemptDiagnosis({
      taskCase: input.attemptInput.taskCase,
      baseline: settled.baseline,
      transcriptOk: Boolean(input.attemptInput.taskCase.initialInput?.text),
      recoveryAgentStarted: input.modelAttempts > 0,
      retryable: Boolean(settled.providerFailureRetryable),
      reasonCode: diagnosisReasonCode({
        baseline: settled.baseline,
        transcriptOk: Boolean(input.attemptInput.taskCase.initialInput?.text),
        failureStage: settled.failureStage,
      }),
      hasAccept: false,
    }),
  );
  return {
    baseline,
    ...(settled.cleanupFailure ? { cleanupFailed: true, ...(input.staging ? { staging: input.staging } : {}) } : {}),
    recovery: failed,
    experimentRoot: input.experimentRoot,
    experimentId: input.attemptInput.experimentId,
    provider: input.provider,
  };
}

async function settleFailedRecovery(input: FailRecoverExperimentInput) {
  const failureStage = classifyRecoveryFailureStage(
    input.failureStage ?? "preflight_failed",
    input.error,
    input.verifierRejectionReasons,
    input.recovery?.status === "completed" && input.candidateCreated,
  );
  let providerFailureRetryable = input.providerFailureRetryable;
  let taskOutcome = input.taskOutcome;
  if (!taskOutcome) taskOutcome = failureStage === "provider_validation_failed" ? "unrecoverable" : failureStage === "source_tripwire_failed" ? "blocked_by_safety" : "runner_failed";
  if (failureStage === "preflight_failed") {
    const diagnostic = recoveryPreflightDiagnostic(input.error, input.preflightOperation);
    providerFailureRetryable = diagnostic.retryable;
    await input.store.append({
      type: "recovery.preflight_failed",
      runId: input.attemptInput.runId,
      operationId: "recovery-preflight-failed",
      payload: diagnostic,
    });
  }
  let cleanupFailure: string | undefined;
  if (input.staging && failureStage === "provider_validation_failed") {
    try {
      await persistRecoveryValidationArtifacts(input.store, input.staging);
    } catch (artifactError) {
      await input.store.append({ type: "recovery.validation_artifact_failed", runId: input.attemptInput.runId, operationId: "recovery-validation-artifact-failed", payload: { reasonCode: artifactError instanceof Error ? artifactError.name : "unknown" } });
    }
  }
  if (input.staging) {
    try {
      await input.provider.discardRecovery(input.staging);
    } catch (cleanupError) {
      cleanupFailure = safeRecoveryFailureSummary(cleanupError, "runner_crashed");
      await input.store.append({ type: "recovery.cleanup_failed", runId: input.attemptInput.runId, operationId: "recovery-cleanup-failed", payload: { summary: cleanupFailure } });
    }
  }
  const fallback = await input.provider.resolveBaseline(
    { caseId: input.attemptInput.caseId, sourceRoot: resolve(input.attemptInput.sourceRoot) },
    [],
    {},
  );
  const stateAtFailure = input.lifecycleState();
  if (stateAtFailure === "candidate_verified")
    input.moveRecoveryState("review_required");
  else if (stateAtFailure !== "accepted" && stateAtFailure !== "review_required" && stateAtFailure !== "exhausted")
    input.moveRecoveryState("exhausted");
  const failedAttemptsArtifact = Buffer.from(JSON.stringify({ schemaVersion: 1, state: input.lifecycleState(), terminalReason: failureStage, attempts: input.recoveryOrchestrator.attempts }), "utf8");
  await input.store.commitArtifact({ artifactId: "recovery-attempts", kind: "recovery_attempts", mediaType: "application/json", bytes: failedAttemptsArtifact, operationId: "recovery-attempts-failed-created" });
  if (failureStage === "agent_model_failed" && input.forensicsCompleted) {
    await input.store.append({
      type: "recovery.model_fallback",
      runId: input.attemptInput.runId,
      operationId: "recovery-model-fallback",
      payload: {
        forensicsCompleted: true,
        hypothesisCount: input.hypothesisCount ?? 0,
        candidateCount: input.candidateCount ?? 0,
        modelAttempts: input.modelAttempts,
        ...([...input.toolFailureByTool.values()].reduce((total, count) => total + count, 0) > 0
          ? { toolFailureCount: [...input.toolFailureByTool.values()].reduce((total, count) => total + count, 0) }
          : {}),
        ...(input.lastToolFailureCategory ? { lastToolFailureCategory: input.lastToolFailureCategory } : {}),
      },
    });
  }
  const failureMessage = safeRecoveryFailureSummary(input.error, failureStage);
  const fallbackWarning =
    failureStage === "agent_model_failed" && input.forensicsCompleted
      ? "Recovery model failed after Host forensics; the persisted investigation diagnostics require review."
      : `Recovery failed; replay uses the current source state: ${failureMessage}`;
  const baseline: EnvironmentBaseline = {
    ...fallback,
    match: "observational",
    warnings: [...fallback.warnings, fallbackWarning, ...(cleanupFailure ? ["Recovery cleanup requires review."] : [])],
    recovery: {
      status: "failed",
      unresolved: ["Recovery was not verified."],
      sourceDigest: fallback.fingerprint.digest,
      recoveredDigest: fallback.fingerprint.digest,
      failureStage,
      ...(failureStage === "preflight_failed"
        ? {
            failureDetail: recoveryPreflightDiagnostic(
              input.error,
              input.preflightOperation,
            ),
          }
        : {}),
      taskOutcome,
      accepted: false,
    },
  };
  return { failureStage, providerFailureRetryable, taskOutcome, failureMessage, baseline, cleanupFailure };
}

type PersistFailedRecoveryArtifactsInput = {
  experimentRoot: string;
  store: ExperimentStore;
  attemptInput: RecoveryAttemptInput;
  failed: StructuredAgentResult<RecoveryResult> | { status: "failed"; failure: { code: "agent_failure"; message: string; attempts: number } };
  failureStage: string;
  failureMessage: string;
  error: unknown;
  preflightOperation: string;
  verifierRejectionReasons: string[] | undefined;
};

async function persistFailedRecoveryArtifacts(input: PersistFailedRecoveryArtifactsInput): Promise<void> {
  const {
    experimentRoot,
    store,
    attemptInput,
    failed,
    failureStage,
    failureMessage,
    error,
    preflightOperation,
    verifierRejectionReasons,
  } = input;
  await writeImmutableJson(join(experimentRoot, "recovery-validation.json"), {
    status: "failed",
    message: failureMessage,
    agentInvocation: failed,
    ...(failureStage === "provider_validation_failed"
      ? {
          validationFailureReason:
            verifierRejectionReasons?.length
              ? [...verifierRejectionReasons]
              : ["provider_validation_failed"],
        }
      : {}),
    ...(failureStage === "preflight_failed"
      ? {
          failureDetail: recoveryPreflightDiagnostic(
            error,
            preflightOperation,
          ),
        }
      : {}),
  });
  await store.append({
    type: "recovery.warning",
    runId: attemptInput.runId,
    operationId: "recovery-warning",
    payload: {
      failureStage,
      summary: failureMessage,
      fallback: "current_state",
      ...(failureStage === "preflight_failed"
        ? {
            preflight: recoveryPreflightDiagnostic(error, preflightOperation),
          }
        : {}),
    },
  });
}

export function recoveryInvocationFailureStage(
  recovery: StructuredAgentResult<RecoveryResult>,
): NonNullable<NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]> {
  if (recovery.status === "cancelled") return "cancelled";
  if (recovery.status === "failed" && recovery.failure.code === "agent_timeout") return "agent_timeout";
  if (recovery.status === "failed" && recovery.failure.code === "invalid_output") return "agent_invalid_output";
  if (recovery.status === "failed" && recovery.failure.kind === "tool") return "agent_tool_failed";
  return "agent_model_failed";
}

export function retryableRecoveryFailure(
  result: StructuredAgentResult<RecoveryResult>,
): "agent_failure" | "agent_timeout" | undefined {
  if (result.status !== "failed") return undefined;
  if (result.failure.code === "agent_timeout") return result.failure.code;
  if (result.failure.code !== "agent_failure") return undefined;
  // Legacy injected ports omit kind and retain the historical bounded retry;
  // real Host failures are classified, so auth/protocol/tool/unknown errors do not loop.
  return result.failure.kind === undefined ||
    result.failure.kind === "rate_limited" ||
    result.failure.kind === "transient_network" ||
    result.failure.kind === "transient_upstream" ||
    result.failure.kind === "timeout"
    ? result.failure.code
    : undefined;
}
export function classifyRecoveryFailureStage(
  stage: NonNullable<
    NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]
  >,
  error: unknown,
  verifierRejectionReasons?: readonly string[],
  agentCompletedWithCandidate = false,
): NonNullable<NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]> {
  if (recoveryModelRequestError(error)) return "agent_model_failed";
  if (
    stage === "provider_validation_failed" &&
    verifierRejectionReasons?.length
  )
    return "provider_validation_failed";
  if (
    error instanceof RecoveryValidationError &&
    error.code === "source_tripwire_failed"
  )
    return "source_tripwire_failed";
  if (stage === "provider_validation_failed" && agentCompletedWithCandidate)
    return "provider_validation_failed";
  if (
    stage === "provider_validation_failed" &&
    !(error instanceof RecoveryValidationError) &&
    !(error instanceof RecoveryEvidenceValidationError)
  )
    return "runner_crashed";
  return stage;
}

function recoveryModelRequestError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\b(context_length_exceeded|maximum context length|prompt is too long|context window)\b/i.test(text);
}

export function recoveryFailedFromThrown(
  error: unknown,
  sessionId: string,
): StructuredAgentResult<RecoveryResult> {
  return {
    status: "failed",
    sessionId,
    failure: {
      code: "agent_failure",
      kind: recoveryModelRequestError(error) ? "protocol" : "unknown",
      message: error instanceof Error ? error.message : String(error),
      attempts: 1,
    },
  };
}

function safeRecoveryFailureSummary(
  error: unknown,
  stage: NonNullable<EnvironmentBaseline["recovery"]>["failureStage"],
): string {
  if (stage === "source_tripwire_failed")
    return "Recovery source tripwire detected a source change.";
  if (stage === "agent_model_failed") return "Recovery model request failed.";
  if (stage === "agent_timeout") return "Recovery agent timed out.";
  if (stage === "agent_invalid_output")
    return "Recovery agent returned an invalid completion envelope.";
  if (stage === "provider_validation_failed")
    return "Provider validation rejected the recovery result.";
  if (stage === "preflight_failed") return "Recovery preflight failed.";
  if (stage === "cancelled") return "Recovery agent was cancelled.";
  if (stage === "runner_crashed") return "Recovery runner crashed.";
  return error instanceof Error && error.name === "AbortError"
    ? "Recovery agent was cancelled."
    : "Recovery agent or tool execution failed.";
}





