import { Value } from "@sinclair/typebox/value";
import { sha256 } from "../core/identity.js";
import {
  RecoveryCandidateGraphSchema,
  type RecoveryCandidateGraph,
  type RecoveryInvestigation,
} from "../core/schema.js";
import { RecoveryValidationError } from "../environment/local-workspace-provider.js";
import { replayControlledRecoveryDeltaBytes } from "../infrastructure/recovery-write-journal.js";
import { persistRecoveryEvaluation } from "./recovery-evaluation.js";
import {
  persistRecoveryAttemptDiagnosis,
  recoveryAttemptDiagnosis,
} from "./recovery-user-status.js";
import { verifyRecoveryCandidate } from "./recovery-verifier.js";
import { validateRecoveryEvidence } from "../infrastructure/recovery-tools.js";
import {
  recoveryCandidateDiff,
  recoveryEvaluationCase,
  recoveryReviewSummary,
  recoveryTimingSummary,
  verdictToEvaluationStatus,
} from "./experiment-recovery-support.js";
import { completeRecoveryReview } from "./experiment-recovery-review.js";
import { recoveryAttemptRecord } from "./recovery-orchestrator.js";
import {
  lifecycleState,
  moveRecoveryState,
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";
import type { RecoveryAttempt } from "./experiment-recovery-types.js";

async function replayAndDiffCandidate(session: RecoveryRunSession): Promise<void> {
  const { input, store, provider, executionCandidate, investigation, recovery, controlledWriteEntries } =
    session;
  if (!executionCandidate || !investigation || !recovery || recovery.status !== "completed")
    throw new Error("Recovery candidate scoring was not prepared.");
  session.failureStage = "provider_validation_failed";
  const replayedControlledDelta = await replayControlledRecoveryDeltaBytes(controlledWriteEntries, (artifactId) =>
    store.readArtifact({ artifactId, experimentId: input.experimentId }),
  );
  await store.append({
    type: "recovery.controlled_write_replayed",
    runId: input.runId,
    operationId: "recovery-controlled-write-replayed",
    payload: { entryCount: controlledWriteEntries.length, fileCount: replayedControlledDelta.size },
  });
  const afterFingerprint = await provider.fingerprintRecoveryCandidate(executionCandidate);
  const selectedCandidate = investigation.candidates.find(
    (candidate) => candidate.candidateId === executionCandidate.candidateId,
  );
  if (!selectedCandidate)
    throw new Error("Selected Recovery candidate is missing from the investigation.");
  const diffArtifactId = `recovery-candidate-diff-${sha256(executionCandidate.candidateId).slice(0, 16)}`;
  const candidateDiff = recoveryCandidateDiff(
    executionCandidate,
    selectedCandidate.factRefs,
    executionCandidate.beforeFingerprint,
    afterFingerprint,
    controlledWriteEntries,
  );
  const recoveryValue = recovery.value;
  const verdict = verifyRecoveryCandidate(
    selectedCandidate,
    investigation.facts,
    candidateDiff.taskPathOutcomes.map((outcome) => outcome.path),
    recoveryValue.status,
  );
  session.recoveredPaths = candidateDiff.taskPathOutcomes.map((outcome) => outcome.path);
  session.verification = verdictToEvaluationStatus(verdict.status, recoveryValue.status);
  const reviewArtifactId = `recovery-review-${sha256(executionCandidate.candidateId).slice(0, 16)}`;
  const finalizedCandidate: RecoveryInvestigation["candidates"][number] = {
    ...selectedCandidate,
    status: verdict.status,
    afterDigest: afterFingerprint.digest,
    diffArtifactId,
    reviewArtifactId,
  };
  await store.commitArtifact({
    artifactId: diffArtifactId,
    kind: "recovery_candidate_diff",
    mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(candidateDiff), "utf8"),
    operationId: `recovery-candidate-diff-${sha256(executionCandidate.candidateId).slice(0, 16)}`,
  });
  const reviewSummary = recoveryReviewSummary(
    finalizedCandidate,
    investigation.facts,
    candidateDiff.taskPathOutcomes.map((outcome) => outcome.path),
    candidateDiff.taskPathOutcomes,
    verdict.status,
    verdict.reasonCodes,
  );
  await store.commitArtifact({
    artifactId: reviewArtifactId,
    kind: "recovery_review_summary",
    mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(reviewSummary), "utf8"),
    operationId: `recovery-review-${sha256(executionCandidate.candidateId).slice(0, 16)}`,
  });
  await store.append({
    type: "recovery.candidate_finalized",
    runId: input.runId,
    operationId: `recovery-candidate-finalized-${executionCandidate.candidateId}`,
    payload: {
      candidateId: finalizedCandidate.candidateId,
      hypothesisId: finalizedCandidate.hypothesisId,
      status: finalizedCandidate.status,
      reasonCodes: verdict.reasonCodes,
      beforeDigest: finalizedCandidate.beforeDigest,
      afterDigest: finalizedCandidate.afterDigest,
      diffArtifactId,
      reviewArtifactId,
      recommendedAction: reviewSummary.recommendedAction,
      factRefs: finalizedCandidate.factRefs,
    },
  });
  if (verdict.status === "rejected") {
    session.verifierRejectionReasons = [...verdict.reasonCodes];
    throw new RecoveryValidationError(
      "provider_validation_failed",
      `Recovery candidate was rejected: ${verdict.reasonCodes.join(", ")}.`,
    );
  }
  session.graphCandidates = investigation.candidates.map((candidate) =>
    candidate.candidateId === finalizedCandidate.candidateId
      ? finalizedCandidate
      : { ...candidate, status: "pending_user_review" as const },
  );
  session.candidateReviews = [{ candidateId: finalizedCandidate.candidateId, artifactId: reviewArtifactId }];
}

async function persistAlternateCandidateReviews(session: RecoveryRunSession): Promise<void> {
  const { input, store, executionCandidate, investigation, candidateStagings, graphCandidates, candidateReviews } =
    session;
  if (!executionCandidate || !investigation || !candidateStagings || !graphCandidates || !candidateReviews)
    throw new Error("Recovery alternate reviews were not prepared.");
  for (const candidate of candidateStagings) {
    if (candidate.candidateId === executionCandidate.candidateId) continue;
    const reviewId = `recovery-review-${sha256(candidate.candidateId).slice(0, 16)}`;
    const candidateRecord = graphCandidates.find((item) => item.candidateId === candidate.candidateId);
    if (!candidateRecord) throw new Error(`Recovery candidate graph is missing ${candidate.candidateId}.`);
    const review = recoveryReviewSummary(
      candidateRecord,
      investigation.facts,
      [],
      [],
      "pending_user_review",
      ["candidate_not_executed", "alternate_hypothesis_available"],
    );
    await store.commitArtifact({
      artifactId: reviewId,
      kind: "recovery_review_summary",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(review), "utf8"),
      operationId: `recovery-review-${sha256(candidate.candidateId).slice(0, 16)}`,
    });
    candidateRecord.reviewArtifactId = reviewId;
    candidateReviews.push({ candidateId: candidate.candidateId, artifactId: reviewId });
    await store.append({
      type: "recovery.candidate_review_available",
      runId: input.runId,
      operationId: `recovery-candidate-review-${candidate.candidateId}`,
      payload: {
        caseId: input.caseId,
        candidateId: candidate.candidateId,
        hypothesisId: candidate.hypothesisId,
        status: "pending_user_review",
        reviewArtifactId: reviewId,
        reasonCodes: review.reasonCodes,
      },
    });
  }
}

async function persistCandidateGraphAndValidate(session: RecoveryRunSession): Promise<void> {
  const { input, store, investigation, graphCandidates, candidateReviews, executionCandidate, activeStaging, recovery, facts } =
    session;
  if (
    !investigation ||
    !graphCandidates ||
    !candidateReviews ||
    !executionCandidate ||
    !activeStaging ||
    !recovery ||
    recovery.status !== "completed" ||
    !facts
  )
    throw new Error("Recovery graph validation was not prepared.");
  const candidateGraph: RecoveryCandidateGraph = {
    schemaVersion: 1,
    investigation: { ...investigation, candidates: graphCandidates },
    reviews: candidateReviews,
  };
  if (!Value.Check(RecoveryCandidateGraphSchema, candidateGraph))
    throw new Error("Recovery candidate graph failed schema validation.");
  const candidateGraphArtifactId = "recovery-candidate-graph";
  session.candidateGraphArtifactId = candidateGraphArtifactId;
  await store.commitArtifact({
    artifactId: candidateGraphArtifactId,
    kind: "recovery_candidate_graph",
    mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(candidateGraph), "utf8"),
    operationId: "recovery-candidate-graph-artifact-created",
  });
  await store.append({
    type: "recovery.candidate_graph_created",
    runId: input.runId,
    operationId: "recovery-candidate-graph-created",
    payload: {
      artifactId: candidateGraphArtifactId,
      candidateCount: graphCandidates.length,
      reviewableCount: candidateReviews.length,
    },
  });
  const finalized = graphCandidates.find((candidate) => candidate.candidateId === executionCandidate.candidateId);
  moveRecoveryState(session, finalized?.status === "verified" ? "candidate_verified" : "candidate_pending_review");
  await session.provider.selectRecoveryCandidate(activeStaging, executionCandidate);
  validateRecoveryEvidence(facts.evidenceRefs, recovery.value);
  const providerVerificationStartedAt = Date.now();
  session.activeProviderPreview = await session.provider.validateRecovery(
    activeStaging,
    recovery.value,
    facts.verifiedEvidence,
  );
  await recordRecoveryAttempt(
    session,
    recoveryAttemptRecord({
      attemptId: `recovery-attempt-provider-verification-${executionCandidate.candidateId}`,
      phase: "verification",
      operation: "validate_candidate",
      candidateId: executionCandidate.candidateId,
      attemptNumber: 1,
      result: "succeeded",
      durationMs: Math.max(0, Date.now() - providerVerificationStartedAt),
      recordedAt: new Date().toISOString(),
    }),
  );
}

async function persistRecoveryCompletionArtifacts(
  session: RecoveryRunSession,
  activeProviderPreview: NonNullable<RecoveryRunSession["activeProviderPreview"]>,
): Promise<void> {
  const { input, store, staging } = session;
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
  await persistRecoveryAttemptDiagnosis(
    session.experimentRoot,
    recoveryAttemptDiagnosis({
      taskCase: input.taskCase,
      baseline: activeProviderPreview.baseline,
      transcriptOk: Boolean(input.taskCase.initialInput?.text),
      recoveryAgentStarted: true,
      retryable: false,
      reasonCode:
        activeProviderPreview.baseline.budget.excludedEntries?.[0]?.reasonCode ??
        (activeProviderPreview.baseline.recovery?.status === "recovered"
          ? "recovered"
          : "recovery_agent.failed"),
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

async function acceptReadyBaselineAndComplete(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  const input = session.input;
  const staging = session.staging;
  const recovery = session.recovery;
  const executionCandidate = session.executionCandidate;
  const graphCandidates = session.graphCandidates;
  const candidateStagings = session.candidateStagings;
  const context = session.context;
  const activeStaging = session.activeStaging;
  const investigation = session.investigation;
  const facts = session.facts;
  const candidateReviews = session.candidateReviews;
  let activeProviderPreview = session.activeProviderPreview;
  const candidateGraphArtifactId = session.candidateGraphArtifactId;
  if (
    !staging ||
    !recovery ||
    !executionCandidate ||
    !graphCandidates ||
    !candidateStagings ||
    !context ||
    !activeStaging ||
    !investigation ||
    !facts ||
    !candidateReviews ||
    !activeProviderPreview ||
    !candidateGraphArtifactId
  )
    throw new Error("Recovery completion was not prepared.");
  if (session.verification === "verified" || session.readinessResult?.status === "ready")
    moveRecoveryState(session, "selected_checkpoint");
  activeProviderPreview = await acceptReadyBaseline(session, activeProviderPreview);
  await persistRecoveryCompletionArtifacts(session, activeProviderPreview);
  return completeRecoveryReview({
    input,
    executionCandidate,
    graphCandidates,
    candidateStagings,
    staging,
    experimentRoot: session.experimentRoot,
    recovery,
    candidateGraphArtifactId,
    context,
    activeStaging,
    investigation,
    facts,
    provider: session.provider,
    candidateReviews,
    activeProviderPreview,
    automaticallyAcceptedBaseline: session.automaticallyAcceptedBaseline,
    readinessResult: session.readinessResult,
    lifecycleState: () => lifecycleState(session),
    moveRecoveryState: (next) => moveRecoveryState(session, next),
    recoveryOrchestrator: session.recoveryOrchestrator,
  });
}

async function acceptReadyBaseline(
  session: RecoveryRunSession,
  activeProviderPreview: NonNullable<RecoveryRunSession["activeProviderPreview"]>,
): Promise<NonNullable<RecoveryRunSession["activeProviderPreview"]>> {
  if (session.readinessResult?.status !== "ready") return activeProviderPreview;
  const { input, store, executionCandidate } = session;
  if (!executionCandidate) throw new Error("Recovery acceptance candidate was not prepared.");
  session.taskOutcome = "ready_for_task";
  session.verification = "verified";
  const acceptedPreview = {
    ...activeProviderPreview,
    baseline: {
      ...activeProviderPreview.baseline,
      ...(activeProviderPreview.baseline.recovery
        ? { recovery: { ...activeProviderPreview.baseline.recovery, taskOutcome: session.taskOutcome } }
        : {}),
    },
  };
  session.activeProviderPreview = acceptedPreview;
  moveRecoveryState(session, "ready_for_task");
  await store.append({
    type: "recovery.ready_for_task",
    runId: input.runId,
    operationId: "recovery-ready-for-task",
    payload: {
      caseId: input.caseId,
      candidateId: executionCandidate.candidateId,
      checkedPaths: session.readinessResult.checkedPaths,
    },
  });
  session.automaticallyAcceptedBaseline = await session.provider.acceptRecovery(acceptedPreview);
  moveRecoveryState(session, "accepted");
  await store.append({
    type: "recovery.lifecycle_completed",
    runId: input.runId,
    operationId: "recovery-lifecycle-accepted-automatically",
    payload: { state: lifecycleState(session), automatic: true },
  });
  return acceptedPreview;
}

export async function finalizeRecoveredCandidate(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  await replayAndDiffCandidate(session);
  await persistAlternateCandidateReviews(session);
  await persistCandidateGraphAndValidate(session);
  return acceptReadyBaselineAndComplete(session);
}
