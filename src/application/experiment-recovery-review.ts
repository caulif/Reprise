import { Value } from "@sinclair/typebox/value";
import { join } from "node:path";
import { verifyRecoveryCandidate } from "./recovery-verifier.js";
import {
  RecoveryReviewFeedbackSchema,
  RecoveryExternalEffectSchema,
  RecoveryCompensationRequestSchema,
  RecoveryCompensationResultSchema,
  type RecoveryReviewFeedback,
  type RecoveryExternalEffect,
  type RecoveryCompensationRequest,
  type RecoveryCompensationResult,
  type RecoveryCandidateGraph,
  type RecoveryControlledWrite,
} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import { replayControlledRecoveryDeltaBytes } from "../infrastructure/recovery-write-journal.js";
import { RecoveryValidationError } from "../environment/local-workspace-provider.js";
import {
  recoveryTools,
  validateRecoveryEvidence,
  resolvedRecoveryFacts,
} from "../infrastructure/recovery-tools.js";
import { OBSERVATIONS_MOUNT, recoveryObservationsRoot, writeFrozenObservationTree } from "./observation-files.js";
import {
  ExperimentStore,
  writeImmutableJson,
} from "../infrastructure/store/experiment-store.js";
import {
  recoveryModelInputAudit,
  persistRecoveryControlledWriteBlob,
  recoveryReviewSummary,
  recoveryCandidateDiff,
} from "./experiment-recovery-support.js";
import type { RecoveryAttempt, RecoveryAttemptInput } from "./experiment-recovery-types.js";
import type { RecoveryResult } from "../agents/recovery-agent.js";
import type { RecoveryContext } from "../agents/recovery-agent.js";
import { recoveryWorkingSet } from "../agents/recovery-working-set.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import type {
  EnvironmentBaseline,
  LocalWorkspaceProvider,
  RecoveryCandidateStaging,
  RecoveryPreview,
  RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import type { RecoveryOrchestrator, RecoveryLifecycleState } from "./recovery-orchestrator.js";
import type { RecoveryReadinessResult } from "./recovery-readiness.js";
import type { RecoveryCandidate } from "../core/schema.js";

export type CompleteRecoveryReviewArgs = {
  input: RecoveryAttemptInput;
  executionCandidate: RecoveryCandidateStaging;
  graphCandidates: RecoveryCandidate[];
  candidateStagings: RecoveryCandidateStaging[];
  staging: RecoveryStaging;
  experimentRoot: string;
  recovery: StructuredAgentResult<RecoveryResult>;
  candidateGraphArtifactId: string;
  context: RecoveryContext;
  activeStaging: RecoveryStaging;
  investigation: RecoveryCandidateGraph["investigation"];
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>;
  provider: LocalWorkspaceProvider;
  candidateReviews: { candidateId: string; artifactId: string }[];
  activeProviderPreview: RecoveryPreview;
  automaticallyAcceptedBaseline: EnvironmentBaseline | undefined;
  readinessResult: RecoveryReadinessResult | undefined;
  lifecycleState: () => RecoveryLifecycleState;
  moveRecoveryState: (next: RecoveryLifecycleState) => void;
  recoveryOrchestrator: RecoveryOrchestrator;
};


export type RecoveryReviewSession = CompleteRecoveryReviewArgs & {
  selectedCandidateId: string;
  validatedCandidateId: string;
};

async function review_selectCandidate(session: RecoveryReviewSession, candidateId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId))
    throw new Error("Recovery candidate selection is invalid.");
  const graphCandidate = session.graphCandidates.find((candidate: RecoveryCandidate) => candidate.candidateId === candidateId);
  const candidate = session.candidateStagings.find((item: RecoveryCandidateStaging) => item.candidateId === candidateId);
  if (!graphCandidate || !candidate)
    throw new Error(`Recovery candidate is not in the review graph: ${candidateId}.`);
  if (graphCandidate.status !== "pending_user_review")
    throw new Error("Only a pending Recovery candidate can be selected for review.");
  // Selection is recorded without publishing or mutating staging. An unexecuted
  // branch must be re-run through the Agent and Provider verifier first.
  // The attempt returns after its main writer is closed. Reopen a short-lived
  // Host-owned writer so post-return selection remains durable and observable.
  const selectionStore = await ExperimentStore.open(session.experimentRoot, session.input.experimentId);
  const unsubscribeSelection = session.input.onEvent
    ? selectionStore.subscribe(session.input.onEvent)
    : undefined;
  try {
    await selectionStore.acquireWriter();
    await selectionStore.append({
      type: "recovery.candidate_selected_by_user",
      runId: session.input.runId,
      operationId: `recovery-candidate-selected-by-user-${candidateId}`,
      payload: {
        candidateId,
        hypothesisId: candidate.hypothesisId,
        graphArtifactId: session.candidateGraphArtifactId,
        requiresReexecution: candidateId !== session.executionCandidate.candidateId,
      },
    });
  } finally {
    unsubscribeSelection?.();
    await selectionStore.close();
  }
  session.selectedCandidateId = candidateId;
}

function review_reexecutionTools(
  session: RecoveryReviewSession,
  candidate: RecoveryCandidateStaging,
  candidateId: string,
  executionStore: ExperimentStore,
  executionWrites: RecoveryControlledWrite[],
) {
  const alternateContext = {
    ...session.context,
    executionCandidate: {
      candidateId: candidate.candidateId,
      hypothesisId: candidate.hypothesisId,
    },
  };
  const alternateAudit = {
    append: async (event: import("../infrastructure/pi-agent-host.js").AgentAuditEvent): Promise<void> => {
      await executionStore.append({
        type: event.type,
        runId: session.input.runId,
        payload: { role: event.role, sessionId: event.sessionId, candidateId, ...event.payload },
      });
    },
  };
  const alternateTools = [
    ...recoveryTools(candidate.root, {
      allowBinary: session.input.taskCase.privacy.allowBinary,
      mounts: { [OBSERVATIONS_MOUNT]: recoveryObservationsRoot(session.experimentRoot, session.input.runId) },
      denyDestructiveOnPrefix: [OBSERVATIONS_MOUNT],
      ...(session.input.allowShell ? { allowShell: true } : {}),
      ...(session.activeStaging.temporaryRoot ? { homeRoot: session.activeStaging.temporaryRoot } : {}),
      onControlledWrite: async (entry) => {
        const persistedEntry = await persistRecoveryControlledWriteBlob(
          executionStore,
          candidate.root,
          entry,
          {
            ...(session.activeStaging.checkpointId ? { checkpointId: session.activeStaging.checkpointId } : {}),
            baseDigest: candidate.beforeFingerprint.digest,
          },
        );
        executionWrites.push(persistedEntry);
        await executionStore.append({
          type: "recovery.controlled_write",
          runId: session.input.runId,
          operationId: `recovery-${candidateId}-controlled-write-${persistedEntry.tool}-${persistedEntry.phase}-${sha256(JSON.stringify(persistedEntry)).slice(0, 12)}`,
          payload: { candidateId, ...persistedEntry },
        });
      },
      onOperation: async (operation) => {
        await executionStore.append({
          type: "recovery.workspace_read",
          runId: session.input.runId,
          operationId: `recovery-${candidateId}-workspace-read-${operation.operation}-${operation.attempts}-${sha256(JSON.stringify(operation)).slice(0, 12)}`,
          payload: { candidateId, ...operation },
        });
      },
    }),
  ];
  return { alternateContext, alternateAudit, alternateTools };
}

async function review_reexecuteCandidate(session: RecoveryReviewSession, candidateId = session.selectedCandidateId): Promise<void> {
  const graphCandidate = session.graphCandidates.find((candidate: RecoveryCandidate) => candidate.candidateId === candidateId);
  const candidate = session.candidateStagings.find((item: RecoveryCandidateStaging) => item.candidateId === candidateId);
  if (!graphCandidate || !candidate)
    throw new Error(`Recovery candidate is not in the review graph: ${candidateId}.`);
  if (graphCandidate.status !== "pending_user_review")
    throw new Error("Only a pending Recovery candidate can be re-executed.");
  if (candidateId !== session.selectedCandidateId)
    throw new Error("Select the Recovery candidate before re-executing it.");
  if (candidateId === session.executionCandidate.candidateId)
    throw new Error("The initially executed Recovery candidate is already validated.");

  const executionStore = await ExperimentStore.open(session.experimentRoot, session.input.experimentId);
  const unsubscribeExecution = session.input.onEvent
    ? executionStore.subscribe(session.input.onEvent)
    : undefined;
  const executionWrites: RecoveryControlledWrite[] = [];
  try {
    await executionStore.acquireWriter();
    await writeFrozenObservationTree({
      root: recoveryObservationsRoot(session.experimentRoot, session.input.runId),
      taskCase: session.input.taskCase,
      ...(session.context.playbook.text ? { playbookText: session.context.playbook.text } : {}),
    });
    const { alternateContext, alternateAudit, alternateTools } = review_reexecutionTools(
      session,
      candidate,
      candidateId,
      executionStore,
      executionWrites,
    );
    const modelInput = {
      ...recoveryModelInputAudit(alternateContext, alternateTools.map((tool) => tool.name)),
      workingSetDigest: sha256(JSON.stringify(recoveryWorkingSet(alternateContext))),
      attempt: 1,
      candidateId,
    };
    const modelInputBytes = Buffer.from(JSON.stringify(modelInput), "utf8");
    const inputArtifact = await executionStore.commitArtifact({
      artifactId: `recovery-model-input-${candidateId}-${sha256(modelInputBytes).slice(0, 16)}`,
      runId: session.input.runId,
      kind: "recovery_model_input",
      mediaType: "application/json",
      bytes: modelInputBytes,
      operationId: `recovery-${candidateId}-model-input-created`,
    });
    await executionStore.append({
      type: "recovery.model_input",
      runId: session.input.runId,
      operationId: `recovery-${candidateId}-model-input`,
      payload: { caseId: session.input.caseId, candidateId, attempt: 1, artifactId: inputArtifact.artifactId, contentHash: inputArtifact.contentHash, byteLength: inputArtifact.byteLength },
    });
    const alternateRecovery = await session.input.recovery.recover(
      alternateContext,
      alternateTools,
      alternateAudit,
      session.input.signal,
    );
    await writeImmutableJson(
      join(session.experimentRoot, `recovery-${candidateId}.json`),
      alternateRecovery,
    );
    await executionStore.append({
      type: "recovery.candidate_reexecution_completed",
      runId: session.input.runId,
      operationId: `recovery-${candidateId}-reexecution-completed`,
      payload: { candidateId, status: alternateRecovery.status },
    });
    if (alternateRecovery.status !== "completed")
      throw new Error(`Recovery candidate re-execution did not complete: ${alternateRecovery.status}.`);
    await review_finalizeReexecution(
      session,
      candidate,
      graphCandidate,
      candidateId,
      executionStore,
      executionWrites,
      alternateRecovery,
    );
  } finally {
    unsubscribeExecution?.();
    await executionStore.close();
  }
}

async function review_finalizeReexecution(
  session: RecoveryReviewSession,
  candidate: RecoveryCandidateStaging,
  graphCandidate: RecoveryCandidate,
  candidateId: string,
  executionStore: ExperimentStore,
  executionWrites: RecoveryControlledWrite[],
  alternateRecovery: StructuredAgentResult<RecoveryResult>,
): Promise<void> {
    if (alternateRecovery.status !== "completed") {
      throw new Error("Recovery candidate re-execution did not complete.");
    }
    validateRecoveryEvidence(session.facts.evidenceRefs, alternateRecovery.value);
    await replayControlledRecoveryDeltaBytes(
      executionWrites,
      (artifactId) => executionStore.readArtifact({ artifactId, experimentId: session.input.experimentId }),
    );
    await session.provider.selectRecoveryCandidate(session.activeStaging, candidate);
    const alternatePreview = await session.provider.validateRecovery(
      session.activeStaging,
      alternateRecovery.value,
      session.facts.verifiedEvidence,
    );
    const afterFingerprint = await session.provider.fingerprintRecoveryStaging(session.activeStaging);
    const candidateDiff = recoveryCandidateDiff(
      candidate,
      graphCandidate.factRefs,
      candidate.beforeFingerprint,
      afterFingerprint,
      executionWrites,
    );
    const verdict = verifyRecoveryCandidate(
      graphCandidate,
      session.investigation.facts,
      candidateDiff.changedPaths.map((change) => change.path),
      alternateRecovery.value.status,
    );
    if (verdict.status === "rejected")
      throw new RecoveryValidationError(
        "provider_validation_failed",
        `Recovery candidate was rejected: ${verdict.reasonCodes.join(", ")}.`,
      );
    const diffArtifactId = `recovery-candidate-diff-${candidateId}-${sha256(JSON.stringify(candidateDiff)).slice(0, 16)}`;
    const reviewArtifactId = `recovery-review-${candidateId}-${sha256(JSON.stringify(candidateDiff)).slice(0, 16)}`;
    const review = recoveryReviewSummary(
      { ...graphCandidate, afterDigest: afterFingerprint.digest, diffArtifactId, reviewArtifactId },
      session.investigation.facts,
      candidateDiff.taskPathOutcomes.map((outcome) => outcome.path),
      candidateDiff.taskPathOutcomes,
      verdict.status,
      verdict.reasonCodes,
    );
    await executionStore.commitArtifact({
      artifactId: diffArtifactId,
      kind: "recovery_candidate_diff",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(candidateDiff), "utf8"),
      operationId: `recovery-${candidateId}-diff-created`,
    });
    await executionStore.commitArtifact({
      artifactId: reviewArtifactId,
      kind: "recovery_review_summary",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(review), "utf8"),
      operationId: `recovery-${candidateId}-review-created`,
    });
    graphCandidate.status = verdict.status;
    graphCandidate.afterDigest = afterFingerprint.digest;
    graphCandidate.diffArtifactId = diffArtifactId;
    graphCandidate.reviewArtifactId = reviewArtifactId;
    const updatedGraph: RecoveryCandidateGraph = {
      schemaVersion: 1,
      investigation: { ...session.investigation, candidates: session.graphCandidates },
      reviews: session.candidateReviews,
    };
    session.candidateGraphArtifactId = `recovery-candidate-graph-${candidateId}`;
    await executionStore.commitArtifact({
      artifactId: session.candidateGraphArtifactId,
      kind: "recovery_candidate_graph",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(updatedGraph), "utf8"),
      operationId: `recovery-${candidateId}-graph-created`,
    });
    await executionStore.append({
      type: "recovery.candidate_reexecuted_and_validated",
      runId: session.input.runId,
      operationId: `recovery-${candidateId}-validated`,
      payload: { candidateId, status: verdict.status, diffArtifactId, reviewArtifactId, graphArtifactId: session.candidateGraphArtifactId },
    });
    session.activeProviderPreview = alternatePreview;
    session.validatedCandidateId = candidateId;
}

async function review_recordExternalEffect(session: RecoveryReviewSession, effect: Omit<RecoveryExternalEffect, "schemaVersion" | "recordedAt">): Promise<string> {
  const payload: RecoveryExternalEffect = { ...effect, schemaVersion: 1, recordedAt: session.input.now };
  if (!Value.Check(RecoveryExternalEffectSchema, payload)) throw new Error("External effect failed schema validation.");
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const artifactId = `recovery-external-effect-${effect.effectId}-${sha256(bytes).slice(0, 16)}`;
  const effectStore = await ExperimentStore.open(session.experimentRoot, session.input.experimentId);
  try {
    await effectStore.acquireWriter();
    await effectStore.commitArtifact({ artifactId, kind: "recovery_external_effect", mediaType: "application/json", bytes, operationId: `${artifactId}-created` });
    await effectStore.append({ type: "recovery.external_effect_recorded", runId: session.input.runId, operationId: `${artifactId}-event`, payload: { artifactId, effectId: effect.effectId, observability: effect.observability, kind: effect.kind } });
  } finally { await effectStore.close(); }
  return artifactId;
}

async function review_requestCompensation(session: RecoveryReviewSession, request: Omit<RecoveryCompensationRequest, "schemaVersion" | "requestedAt">): Promise<RecoveryCompensationResult> {
  const payload: RecoveryCompensationRequest = { ...request, schemaVersion: 1, requestedAt: session.input.now };
  if (!Value.Check(RecoveryCompensationRequestSchema, payload)) throw new Error("Compensation request failed schema validation.");
  const result: RecoveryCompensationResult = { schemaVersion: 1, requestId: request.requestId, effectId: request.effectId, status: "requires_review", summary: "External effect is not observed or compensatable by this Runtime.", evidenceRefs: request.evidenceRefs, completedAt: session.input.now };
  if (!Value.Check(RecoveryCompensationResultSchema, result)) throw new Error("Compensation result failed schema validation.");
  const requestArtifactId = `recovery-compensation-request-${request.requestId}`;
  const resultArtifactId = `recovery-compensation-result-${request.requestId}`;
  const compensationStore = await ExperimentStore.open(session.experimentRoot, session.input.experimentId);
  try {
    await compensationStore.acquireWriter();
    await compensationStore.commitArtifact({ artifactId: requestArtifactId, kind: "recovery_compensation_request", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(payload), "utf8"), operationId: `${requestArtifactId}-created` });
    await compensationStore.commitArtifact({ artifactId: resultArtifactId, kind: "recovery_compensation_result", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(result), "utf8"), operationId: `${resultArtifactId}-created` });
    await compensationStore.append({ type: "recovery.compensation_requested", runId: session.input.runId, operationId: `${requestArtifactId}-event`, payload: { requestArtifactId, resultArtifactId, requestId: request.requestId, effectId: request.effectId, status: result.status } });
  } finally { await compensationStore.close(); }
  return result;
}

async function review_recordReviewFeedback(session: RecoveryReviewSession, feedback: {
  candidateId: string;
  decision: RecoveryReviewFeedback["decision"];
  evidenceRefs?: readonly string[];
}): Promise<string> {
  const candidate = session.graphCandidates.find((item: RecoveryCandidate) => item.candidateId === feedback.candidateId);
  if (!candidate) throw new Error(`Recovery candidate is not in the review graph: ${feedback.candidateId}.`);
  const stagingDigest = await session.provider.fingerprintRecoveryStaging(session.activeStaging);
  const evidenceRefs = [...new Set(feedback.evidenceRefs ?? [])];
  const feedbackCheckpoint = feedback.decision === "accept"
    ? await session.provider.captureRecoveryCheckpointFromStaging(session.activeStaging)
    : undefined;
  const payload: RecoveryReviewFeedback = {
    schemaVersion: 1,
    candidateId: feedback.candidateId,
    decision: feedback.decision,
    evidenceRefs,
    stagingDigest: stagingDigest.digest,
    ...(feedbackCheckpoint ? { checkpointId: feedbackCheckpoint.checkpointId } : {}),
    recordedAt: session.input.now,
  };
  if (!Value.Check(RecoveryReviewFeedbackSchema, payload))
    throw new Error("Recovery review feedback failed schema validation.");
  const feedbackBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const artifactId = `recovery-review-feedback-${feedback.candidateId}-${sha256(feedbackBytes).slice(0, 16)}`;
  const feedbackStore = await ExperimentStore.open(session.experimentRoot, session.input.experimentId);
  const unsubscribeFeedback = session.input.onEvent ? feedbackStore.subscribe(session.input.onEvent) : undefined;
  try {
    await feedbackStore.acquireWriter();
    await feedbackStore.commitArtifact({ artifactId, kind: "recovery_review_feedback", mediaType: "application/json", bytes: feedbackBytes, operationId: `${artifactId}-created` });
    await feedbackStore.append({ type: "recovery.review_feedback_recorded", runId: session.input.runId, operationId: `${artifactId}-event`, payload: { artifactId, candidateId: feedback.candidateId, decision: feedback.decision, stagingDigest: stagingDigest.digest, ...(feedbackCheckpoint ? { checkpointId: feedbackCheckpoint.checkpointId } : {}) } });
  } finally {
    unsubscribeFeedback?.();
    await feedbackStore.close();
  }
  return artifactId;
}

export async function completeRecoveryReview(args: CompleteRecoveryReviewArgs): Promise<RecoveryAttempt> {
  const session: RecoveryReviewSession = {
    ...args,
    selectedCandidateId: args.executionCandidate.candidateId,
    validatedCandidateId: args.executionCandidate.candidateId,
  };
  const input = session.input;
  const staging = session.staging;
  const experimentRoot = session.experimentRoot;
  const recovery = session.recovery;
  const provider = session.provider;
  const automaticallyAcceptedBaseline = session.automaticallyAcceptedBaseline;
  const readinessResult = session.readinessResult;
  const lifecycleState = session.lifecycleState;
  const moveRecoveryState = session.moveRecoveryState;
  const recoveryOrchestrator = session.recoveryOrchestrator;
  const selectCandidate = review_selectCandidate.bind(null, session);
  const reexecuteCandidate = review_reexecuteCandidate.bind(null, session);
  const recordExternalEffect = review_recordExternalEffect.bind(null, session);
  const requestCompensation = review_requestCompensation.bind(null, session);
  const recordReviewFeedback = review_recordReviewFeedback.bind(null, session);

  return {
  get baseline() { return automaticallyAcceptedBaseline ?? session.activeProviderPreview.baseline; },
  get providerPreview() { return session.activeProviderPreview; },
  staging,
  ...(readinessResult ? { taskReadiness: readinessResult } : {}),
  ...(automaticallyAcceptedBaseline ? { acceptedAutomatically: true } : {}),
  recovery,
  get candidateGraphArtifactId() { return session.candidateGraphArtifactId; },
  selectCandidate,
  reexecuteCandidate,
  recordReviewFeedback,
  recordExternalEffect,
  requestCompensation,
  experimentRoot,
  experimentId: input.experimentId,
  provider,
  accept: async () => {
    if (automaticallyAcceptedBaseline) return automaticallyAcceptedBaseline;
    if (session.activeProviderPreview.baseline.match === "current_state_fallback" && input.allowCurrentStateFallback !== true)
      throw new Error("Current-state fallback requires explicit allowCurrentStateFallback opt-in.");
    if (session.selectedCandidateId !== session.validatedCandidateId)
      throw new Error("Selected Recovery candidate has not been re-executed and validated.");
    const accepted = await provider.acceptRecovery(session.activeProviderPreview);
    if (lifecycleState() === "candidate_pending_review" || lifecycleState() === "review_required")
      moveRecoveryState("selected_checkpoint");
    moveRecoveryState("accepted");
    const acceptanceStore = await ExperimentStore.open(experimentRoot, input.experimentId);
    try {
      await acceptanceStore.acquireWriter();
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, state: lifecycleState(), attempts: recoveryOrchestrator.attempts }), "utf8");
      await acceptanceStore.commitArtifact({ artifactId: "recovery-attempts-accepted", kind: "recovery_attempts", mediaType: "application/json", bytes, operationId: "recovery-attempts-accepted-created" });
      await acceptanceStore.append({ type: "recovery.lifecycle_completed", runId: input.runId, operationId: "recovery-lifecycle-accepted", payload: { state: lifecycleState() } });
    } finally {
      await acceptanceStore.close();
    }
    return accepted;
  },
};
}
