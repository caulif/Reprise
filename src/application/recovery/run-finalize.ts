import { persistRecoveryEvaluation, recoveryEvaluationCase, recoveryTimingSummary } from "./evaluation.js";
import {
  diagnosisReasonCode,
  persistRecoveryAttemptDiagnosis,
  recoveryAcceptIsExposed,
  recoveryAttemptDiagnosis,
} from "./user-status.js";
import { recoveryAttemptRecord } from "./orchestrator.js";
import {
  lifecycleState,
  moveRecoveryState,
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./session.js";
import type { RecoveryAttempt } from "./types.js";

export async function finalizeRecoveredCandidate(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  const { input, store, provider, staging, recovery, facts } = session;
  if (!staging || !recovery || recovery.status !== "completed" || !facts)
    throw new Error("Recovery finalize was not prepared.");
  session.failureStage = "provider_validation_failed";
  const providerVerificationStartedAt = Date.now();
  session.activeProviderPreview = await provider.validateRecovery(staging, recovery.value);
  await recordRecoveryAttempt(
    session,
    recoveryAttemptRecord({
      attemptId: "recovery-attempt-provider-verification",
      phase: "verification",
      operation: "validate_candidate",
      attemptNumber: 1,
      result: "succeeded",
      durationMs: Math.max(0, Date.now() - providerVerificationStartedAt),
      recordedAt: new Date().toISOString(),
    }),
  );
  moveRecoveryState(session, recovery.value.status === "ready" ? "candidate_verified" : "candidate_pending_review");
  session.verification = recovery.value.status === "ready" ? "verified" : "rejected";
  session.taskOutcome = recovery.value.status === "ready" ? "ready_for_task" : "unrecoverable";
  const preview = session.activeProviderPreview;
  if (preview.baseline.recovery && session.taskOutcome) {
    const baseline = {
      ...preview.baseline,
      recovery: { ...preview.baseline.recovery, taskOutcome: session.taskOutcome },
    };
    session.activeProviderPreview = { ...preview, baseline };
  }
  if (recovery.value.status === "ready") {
    moveRecoveryState(session, "selected_checkpoint");
    moveRecoveryState(session, "ready_for_task");
    session.automaticallyAcceptedBaseline = await provider.acceptRecovery(session.activeProviderPreview);
    if (session.automaticallyAcceptedBaseline.recovery && session.taskOutcome) {
      session.automaticallyAcceptedBaseline = {
        ...session.automaticallyAcceptedBaseline,
        recovery: { ...session.automaticallyAcceptedBaseline.recovery, taskOutcome: session.taskOutcome },
      };
    }
    moveRecoveryState(session, "accepted");
    await store.append({
      type: "recovery.lifecycle_completed",
      runId: input.runId,
      operationId: "recovery-lifecycle-accepted-automatically",
      payload: { state: lifecycleState(session), automatic: true, taskOutcome: session.taskOutcome },
    });
    session.activeProviderPreview = { ...session.activeProviderPreview, baseline: session.automaticallyAcceptedBaseline, accepted: true };
  }
  await persistRecoveryCompletionArtifacts(session, session.activeProviderPreview);
  return completeRecoveryAttempt(session);
}

async function persistRecoveryCompletionArtifacts(
  session: RecoveryRunSession,
  activeProviderPreview: NonNullable<RecoveryRunSession["activeProviderPreview"]>,
): Promise<void> {
  const { input, store, staging, recovery } = session;
  const attemptsArtifact = Buffer.from(
    JSON.stringify({ schemaVersion: 1, state: lifecycleState(session), attempts: session.recoveryOrchestrator.attempts }),
    "utf8",
  );
  await store.commitArtifact({
    artifactId: "recovery-attempts",
    kind: "recovery_attempts",
    mediaType: "application/json",
    bytes: attemptsArtifact,
    operationId: "recovery-attempts-created",
  });
  if (activeProviderPreview.reportText) {
    await store.commitArtifact({
      artifactId: "recovery-md",
      kind: "recovery_report",
      mediaType: "text/markdown",
      bytes: Buffer.from(activeProviderPreview.reportText, "utf8"),
    });
  }
  const hasAccept = recoveryAcceptIsExposed({
    automaticallyAccepted: Boolean(session.automaticallyAcceptedBaseline),
    envelopeStatus: recovery?.status === "completed" ? recovery.value.status : undefined,
    match: activeProviderPreview.baseline.match,
    runnable: activeProviderPreview.baseline.readiness?.runnable,
  });
  await persistRecoveryAttemptDiagnosis(
    session.experimentRoot,
    recoveryAttemptDiagnosis({
      taskCase: input.taskCase,
      baseline: activeProviderPreview.baseline,
      transcriptOk: Boolean(input.taskCase.initialInput?.text),
      recoveryAgentStarted: true,
      retryable: false,
      reasonCode: diagnosisReasonCode({
        baseline: activeProviderPreview.baseline,
        transcriptOk: Boolean(input.taskCase.initialInput?.text),
        hasAccept,
        ...(activeProviderPreview.baseline.recovery?.failureStage
          ? { failureStage: activeProviderPreview.baseline.recovery.failureStage }
          : {}),
      }),
      hasAccept,
    }),
  );
  if (session.writerAcquired)
    await persistRecoveryEvaluation(
      store,
      [
        recoveryEvaluationCase({
          caseId: input.caseId,
          staging,
          candidateCreated: session.candidateCreated,
          recoveredPaths: session.recoveredPaths,
          verification: session.verification,
          forensicsCompleted: session.forensicsCompleted,
          evidenceSourcesAttempted: session.evidenceSourcesAttempted,
          evidenceSourcesAvailable: session.evidenceSourcesAvailable,
          hypothesisCount: session.hypothesisCount,
          candidateCount: session.candidateCount,
          verifierRejectionReasons: session.verifierRejectionReasons,
          providerFailureRetryable: session.providerFailureRetryable,
          pathBoundaryRejected: session.pathBoundaryRejected,
          ...(session.readinessResult ? { readiness: session.readinessResult } : {}),
          ...(session.taskOutcome ? { taskOutcome: session.taskOutcome } : {}),
          modelCalls: session.modelAttempts,
          startedAt: input.now,
          timings: recoveryTimingSummary(session.recoveryOrchestrator.attempts),
        }),
      ],
      undefined,
      store.events(input.runId),
    );
}

function completeRecoveryAttempt(session: RecoveryRunSession): RecoveryAttempt {
  const input = session.input;
  const staging = session.staging;
  const recovery = session.recovery;
  const automaticallyAcceptedBaseline = session.automaticallyAcceptedBaseline;
  const activeProviderPreview = session.activeProviderPreview;
  if (!staging || !recovery || !activeProviderPreview) throw new Error("Recovery attempt was not prepared.");
  const exposeAccept = recoveryAcceptIsExposed({
    automaticallyAccepted: Boolean(automaticallyAcceptedBaseline),
    envelopeStatus: recovery.status === "completed" ? recovery.value.status : undefined,
    match: activeProviderPreview.baseline.match,
    runnable: activeProviderPreview.baseline.readiness?.runnable,
  });
  return {
    get baseline() {
      return automaticallyAcceptedBaseline ?? activeProviderPreview.baseline;
    },
    get providerPreview() {
      return activeProviderPreview;
    },
    staging,
    ...(session.readinessResult ? { taskReadiness: session.readinessResult } : {}),
    ...(automaticallyAcceptedBaseline ? { acceptedAutomatically: true } : {}),
    recovery,
    experimentRoot: session.experimentRoot,
    experimentId: input.experimentId,
    provider: session.provider,
    ...(exposeAccept
      ? {
          accept: async () => {
            if (automaticallyAcceptedBaseline) return automaticallyAcceptedBaseline;
            return session.provider.acceptRecovery(activeProviderPreview);
          },
        }
      : {}),
  };
}
