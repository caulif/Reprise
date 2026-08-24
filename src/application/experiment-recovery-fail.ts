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

export async function failRecoverCodexExperiment(input: {
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
}): Promise<RecoveryAttempt> {
  const error = input.error;
  const store = input.store;
  const provider = input.provider;
  const experimentRoot = input.experimentRoot;
  const staging = input.staging;
  const recovery = input.recovery;
  const recoveryOrchestrator = input.recoveryOrchestrator;
  const lifecycleState = input.lifecycleState;
  const moveRecoveryState = input.moveRecoveryState;
  const preflightOperation = input.preflightOperation;
  const writerAcquired = input.writerAcquired;
  const candidateCreated = input.candidateCreated;
  const recoveredPaths = input.recoveredPaths;
  const verification = input.verification;
  const forensicsCompleted = input.forensicsCompleted;
  const evidenceSourcesAttempted = input.evidenceSourcesAttempted;
  const evidenceSourcesAvailable = input.evidenceSourcesAvailable;
  const hypothesisCount = input.hypothesisCount;
  const candidateCount = input.candidateCount;
  const verifierRejectionReasons = input.verifierRejectionReasons;
  const pathBoundaryRejected = input.pathBoundaryRejected;
  const readinessResult = input.readinessResult;
  const modelAttempts = input.modelAttempts;
  const toolFailureByTool = input.toolFailureByTool;
  const lastToolFailureCategory = input.lastToolFailureCategory;
  const attemptInput = input.attemptInput;
  let failureStage = input.failureStage ?? "preflight_failed";
  let providerFailureRetryable = input.providerFailureRetryable;
  let taskOutcome = input.taskOutcome;

  failureStage = classifyRecoveryFailureStage(
    failureStage,
    error,
    verifierRejectionReasons,
    recovery?.status === "completed" && candidateCreated,
  );
  if (!taskOutcome) taskOutcome = failureStage === "provider_validation_failed" ? "unrecoverable" : failureStage === "source_tripwire_failed" ? "blocked_by_safety" : "runner_failed";
  if (failureStage === "preflight_failed") {
    const diagnostic = recoveryPreflightDiagnostic(error, preflightOperation);
    providerFailureRetryable = diagnostic.retryable;
    await store.append({
      type: "recovery.preflight_failed",
      runId: attemptInput.runId,
      operationId: "recovery-preflight-failed",
      payload: diagnostic,
    });
  }
  let cleanupFailure: string | undefined;
  if (staging && failureStage === "provider_validation_failed") {
    try {
      await persistRecoveryValidationArtifacts(store, staging);
    } catch (artifactError) {
      await store.append({ type: "recovery.validation_artifact_failed", runId: attemptInput.runId, operationId: "recovery-validation-artifact-failed", payload: { reasonCode: artifactError instanceof Error ? artifactError.name : "unknown" } });
    }
  }
  if (staging) {
    try {
      await provider.discardRecovery(staging);
    } catch (cleanupError) {
      cleanupFailure = safeRecoveryFailureSummary(cleanupError, "runner_crashed");
      await store.append({ type: "recovery.cleanup_failed", runId: attemptInput.runId, operationId: "recovery-cleanup-failed", payload: { summary: cleanupFailure } });
    }
  }
  const fallback = await provider.resolveBaseline(
    { caseId: attemptInput.caseId, sourceRoot: resolve(attemptInput.sourceRoot) },
    [],
    {},
  );
  const stateAtFailure = lifecycleState();
  if (stateAtFailure === "candidate_verified")
    moveRecoveryState("review_required");
  else if (stateAtFailure !== "accepted" && stateAtFailure !== "review_required" && stateAtFailure !== "exhausted")
    moveRecoveryState("exhausted");
  const failedAttemptsArtifact = Buffer.from(JSON.stringify({ schemaVersion: 1, state: lifecycleState(), terminalReason: failureStage, attempts: recoveryOrchestrator.attempts }), "utf8");
  await store.commitArtifact({ artifactId: "recovery-attempts", kind: "recovery_attempts", mediaType: "application/json", bytes: failedAttemptsArtifact, operationId: "recovery-attempts-failed-created" });
  if (failureStage === "agent_model_failed" && forensicsCompleted) {
    await store.append({
      type: "recovery.model_fallback",
      runId: attemptInput.runId,
      operationId: "recovery-model-fallback",
      payload: {
        forensicsCompleted: true,
        hypothesisCount: hypothesisCount ?? 0,
        candidateCount: candidateCount ?? 0,
        modelAttempts,
        ...([...toolFailureByTool.values()].reduce((total, count) => total + count, 0) > 0
          ? { toolFailureCount: [...toolFailureByTool.values()].reduce((total, count) => total + count, 0) }
          : {}),
        ...(lastToolFailureCategory ? { lastToolFailureCategory } : {}),
      },
    });
  }
  const failureMessage = safeRecoveryFailureSummary(error, failureStage);
  const fallbackWarning =
    failureStage === "agent_model_failed" && forensicsCompleted
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
              error,
              preflightOperation,
            ),
          }
        : {}),
      taskOutcome,
      accepted: false,
    },
  };
  const failed = recovery ?? {
    status: "failed" as const,
    failure: {
      code: "agent_failure" as const,
      message: failureMessage,
      attempts: 1,
    },
  };
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
  return {
    baseline,
    recovery: failed,
    experimentRoot,
    experimentId: attemptInput.experimentId,
    provider,
  };
}
