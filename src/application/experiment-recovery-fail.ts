import { join, resolve } from "node:path";
import type { RecoveryResult } from "../agents/recovery-agent.js";
import { persistRecoveryEvaluation } from "./recovery-evaluation.js";
import type { EnvironmentBaseline, LocalWorkspaceProvider, RecoveryStaging } from "../environment/local-workspace-provider.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import { ExperimentStore, writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import type { RecoveryOrchestrator, RecoveryLifecycleState } from "./recovery-orchestrator.js";
import type { RecoveryReadinessResult } from "./recovery-readiness.js";
import {
  recoveryTimingSummary,
  recoveryEvaluationCase,
  recoveryPreflightDiagnostic,
  persistRecoveryValidationArtifacts,
  classifyRecoveryFailureStage,
  safeRecoveryFailureSummary,
} from "./experiment-recovery-support.js";
import type { RecoveryAttempt, RecoveryAttemptInput } from "./experiment-recovery-types.js";

export type FailRecoverCodexExperimentInput = {
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

export async function failRecoverCodexExperiment(input: FailRecoverCodexExperimentInput): Promise<RecoveryAttempt> {
  const settled = await settleFailedRecovery(input);
  const failed = input.recovery ?? {
    status: "failed" as const,
    failure: {
      code: "agent_failure" as const,
      message: settled.failureMessage,
      attempts: 1,
    },
  };
  await persistFailedRecoveryArtifacts({
    experimentRoot: input.experimentRoot,
    store: input.store,
    attemptInput: input.attemptInput,
    failed,
    failureStage: settled.failureStage,
    failureMessage: settled.failureMessage,
    error: input.error,
    preflightOperation: input.preflightOperation,
    writerAcquired: input.writerAcquired,
    staging: input.staging,
    candidateCreated: input.candidateCreated,
    recoveredPaths: input.recoveredPaths,
    verification: input.verification,
    forensicsCompleted: input.forensicsCompleted,
    evidenceSourcesAttempted: input.evidenceSourcesAttempted,
    evidenceSourcesAvailable: input.evidenceSourcesAvailable,
    hypothesisCount: input.hypothesisCount,
    candidateCount: input.candidateCount,
    verifierRejectionReasons: input.verifierRejectionReasons,
    providerFailureRetryable: settled.providerFailureRetryable,
    pathBoundaryRejected: input.pathBoundaryRejected,
    readinessResult: input.readinessResult,
    taskOutcome: settled.taskOutcome,
    modelAttempts: input.modelAttempts,
    recoveryOrchestrator: input.recoveryOrchestrator,
  });
  return {
    baseline: settled.baseline,
    recovery: failed,
    experimentRoot: input.experimentRoot,
    experimentId: input.attemptInput.experimentId,
    provider: input.provider,
  };
}

async function settleFailedRecovery(input: FailRecoverCodexExperimentInput) {
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
      ? "Recovery model failed after Host forensics; the persisted investigation and candidate diagnostics require review."
      : `Recovery failed; replay uses the current source state: ${failureMessage}`;
  const baseline: EnvironmentBaseline = {
    ...fallback,
    match: "current_state_fallback",
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
  return { failureStage, providerFailureRetryable, taskOutcome, failureMessage, baseline };
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
  writerAcquired: boolean;
  staging: RecoveryStaging | undefined;
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
  recoveryOrchestrator: RecoveryOrchestrator;
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
    writerAcquired,
    staging,
    candidateCreated,
    recoveredPaths,
    verification,
    forensicsCompleted,
    evidenceSourcesAttempted,
    evidenceSourcesAvailable,
    hypothesisCount,
    candidateCount,
    verifierRejectionReasons,
    providerFailureRetryable,
    pathBoundaryRejected,
    readinessResult,
    taskOutcome,
    modelAttempts,
    recoveryOrchestrator,
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
  if (writerAcquired)
    await persistRecoveryEvaluation(store, [
      recoveryEvaluationCase({
        caseId: attemptInput.caseId,
        staging,
        candidateCreated,
        recoveredPaths,
        verification,
        forensicsCompleted,
        evidenceSourcesAttempted,
        evidenceSourcesAvailable,
        hypothesisCount,
        candidateCount,
        verifierRejectionReasons,
        providerFailureRetryable,
        pathBoundaryRejected,
        ...(readinessResult ? { readiness: readinessResult } : {}),
        ...(taskOutcome ? { taskOutcome } : {}),
        modelCalls: modelAttempts,
        startedAt: attemptInput.now,
        timings: recoveryTimingSummary(recoveryOrchestrator.attempts),
      }),
    ],
    undefined,
    store.events(attemptInput.runId),
  );
}
