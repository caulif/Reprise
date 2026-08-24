import { sha256 } from "../core/identity.js";
import type { RecoveryContext } from "../agents/recovery-agent.js";
import type { RecoveryPlan } from "../core/schema.js";
import { historicalCwdOf } from "./replay-conditions.js";
import { recoveryObservationTools, recoveryTools } from "../infrastructure/recovery-tools.js";
import {
  persistRecoveryControlledWriteBlob,
  recoveryClues,
  recoveryModelInputAudit,
  RecoveryPlanPathBoundaryError,
  retryableRecoveryFailure,
  validateSubmittedRecoveryPlan,
} from "./experiment-recovery-support.js";
import { invocationFact } from "./experiment-helpers.js";
import {
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import { join } from "node:path";
import { decideRecoverySearch } from "./recovery-selection.js";
import { materializeRecoveryCandidates } from "./recovery-candidate-materialization.js";
import { recoveryAttemptRecord } from "./recovery-orchestrator.js";
import { deriveRecoveryReadinessContext } from "./recovery-readiness.js";

export function buildRecoveryAgentContext(session: RecoveryRunSession): RecoveryContext {
  const { input, attemptMode, facts, investigation, executionCandidate, pack, playbook, staging } = session;
  if (!facts || !investigation || !executionCandidate || !pack || !playbook || !staging)
    throw new Error("Recovery agent context was not prepared.");
  return {
    task: {
      caseId: input.taskCase.caseId,
      initialInput: input.taskCase.initialInput,
    },
    evidenceLevel: input.taskCase.evidenceLevel ?? "transcript",
    attemptMode,
    session: {
      transcriptLength: input.taskCase.transcript.length,
      historicalEventCount: input.taskCase.historicalEvents.length,
    },
    clues: recoveryClues(input.taskCase),
    resolved: facts,
    investigation: {
      planId: investigation.plan.planId,
      factRefs: investigation.facts.map((fact) => `fact:${fact.factId}`),
      hypotheses: investigation.plan.hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        confidence: hypothesis.confidence,
        paths: hypothesis.paths,
      })),
    },
    executionCandidate: {
      candidateId: executionCandidate.candidateId,
      hypothesisId: executionCandidate.hypothesisId,
    },
    runtimeCapabilities: pack.runtime.recoveryCapabilities(),
    playbook,
    staging: {
      fileCount: staging.sourceBudget.fileCount,
      totalBytes: staging.sourceBudget.totalBytes,
    },
    budget: { maxToolCalls: input.maxToolCalls, timeoutMs: 600_000 },
    allowModelText: input.taskCase.privacy.allowModelText,
    readiness: deriveRecoveryReadinessContext(input.taskCase, historicalCwdOf(input.taskCase)),
  };
}

export async function handleSubmittedRecoveryPlan(
  session: RecoveryRunSession,
  plan: RecoveryPlan,
): Promise<void> {
  const { input, store, provider, investigation, activeStaging, candidateRecipeDigests, candidateStagings } =
    session;
  if (!investigation || !activeStaging || !candidateRecipeDigests || !candidateStagings)
    throw new Error("Recovery plan expansion was not prepared.");
  try {
    validateSubmittedRecoveryPlan(plan, investigation);
  } catch (error) {
    if (error instanceof RecoveryPlanPathBoundaryError) session.pathBoundaryRejected = true;
    throw error;
  }
  const knownHypothesisIds = new Set(investigation.plan.hypotheses.map((hypothesis) => hypothesis.hypothesisId));
  const expandedHypotheses = plan.hypotheses.filter((hypothesis) => !knownHypothesisIds.has(hypothesis.hypothesisId));
  const expandedCandidates = plan.candidates.filter(
    (candidate) =>
      expandedHypotheses.some((hypothesis) => hypothesis.hypothesisId === candidate.hypothesisId) &&
      candidate.operations.length > 0,
  );
  for (const proposal of expandedCandidates) {
    const decision = decideRecoverySearch({
      newEvidenceRefs:
        plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId)?.supportingFactRefs ??
        [],
      knownEvidenceRefs: investigation.plan.factsUsed,
      estimatedCost: 1,
      risk: 0.3,
      remainingBudget: session.remainingSearchBudget ?? 0,
    });
    await store.append({
      type: "recovery.search_decision",
      runId: input.runId,
      operationId: `recovery-search-decision-${proposal.hypothesisId}-${sha256(JSON.stringify(proposal.operations)).slice(0, 12)}`,
      payload: {
        hypothesisId: proposal.hypothesisId,
        mechanism: proposal.operations.map((operation) => operation.operation).join(","),
        ...decision,
      },
    });
    if (decision.action !== "investigate" && decision.reason !== "no_new_evidence") continue;
    const candidateMaterializationStartedAt = Date.now();
    const createdCandidates = await materializeRecoveryCandidates(
      [
        {
          candidateId: `candidate-${proposal.hypothesisId}`,
          hypothesisId: proposal.hypothesisId,
          operations: proposal.operations,
          baseDigest: activeStaging.checkpointFingerprint?.digest ?? activeStaging.sourceFingerprint.digest,
        },
      ],
      {
        seenRecipeDigests: candidateRecipeDigests,
        create: (candidate) => provider.createRecoveryCandidate(activeStaging, candidate),
        onRetry: async ({ candidateId, attempt, reasonCode }) => {
          await store.append({
            type: "recovery.candidate_materialization_retry",
            runId: input.runId,
            operationId: `recovery-candidate-retry-${candidateId}-${attempt}`,
            payload: { candidateId, attempt, reasonCode },
          });
        },
      },
    );
    const candidate = createdCandidates[0];
    if (!candidate) continue;
    candidateStagings.push(candidate);
    investigation.plan.hypotheses.push(
      ...expandedHypotheses.filter((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId),
    );
    investigation.plan.candidates.push(proposal);
    investigation.candidates.push({
      candidateId: candidate.candidateId,
      hypothesisId: candidate.hypothesisId,
      status: "created",
      factRefs:
        plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId)?.supportingFactRefs ??
        [],
      beforeDigest: candidate.beforeFingerprint.digest,
      createdAt: candidate.createdAt,
    });
    session.candidateCount = (session.candidateCount ?? 0) + 1;
    session.remainingSearchBudget = Math.max(0, (session.remainingSearchBudget ?? 0) - 1);
    await recordRecoveryAttempt(
      session,
      recoveryAttemptRecord({
        attemptId: `recovery-attempt-dynamic-candidate-${candidate.candidateId}`,
        phase: "candidate",
        operation: "create_candidate",
        candidateId: candidate.candidateId,
        attemptNumber: session.candidateCount,
        result: "succeeded",
        durationMs: Math.max(0, Date.now() - candidateMaterializationStartedAt),
        recordedAt: new Date().toISOString(),
      }),
    );
    await store.append({
      type: "recovery.candidate_created",
      runId: input.runId,
      operationId: `recovery-candidate-created-${candidate.candidateId}`,
      payload: {
        caseId: input.caseId,
        candidateId: candidate.candidateId,
        hypothesisId: candidate.hypothesisId,
        origin: "agent_submitted_plan",
      },
    });
  }
  await store.append({
    type: "recovery.plan_submitted",
    runId: input.runId,
    operationId: `recovery-plan-submitted-${sha256(JSON.stringify(plan)).slice(0, 16)}`,
    payload: { plan, ...(expandedCandidates.length ? { expandedCandidateCount: expandedCandidates.length } : {}) },
  });
}

export function buildRecoveryAgentTools(session: RecoveryRunSession): void {
  const { input, store, executionCandidate, activeStaging } = session;
  if (!executionCandidate) throw new Error("Recovery execution candidate was not prepared.");
  session.tools = [
    ...recoveryObservationTools(input.taskCase, {
      onOperation: async (operation) => {
        await store.append({
          type: "recovery.frozen_observation_read",
          runId: input.runId,
          operationId: `recovery-frozen-observation-${operation.operation}-${operation.attempts}-${sha256(JSON.stringify(operation)).slice(0, 16)}`,
          payload: operation,
        });
      },
    }),
    ...recoveryTools(executionCandidate.root, input.maxToolCalls, {
      ...(input.allowShell ? { allowShell: true } : {}),
      ...(activeStaging?.temporaryRoot ? { homeRoot: activeStaging.temporaryRoot } : {}),
      onControlledWrite: async (entry) => {
        const persistedEntry = await persistRecoveryControlledWriteBlob(store, executionCandidate.root, entry, {
          ...(activeStaging?.checkpointId ? { checkpointId: activeStaging.checkpointId } : {}),
          baseDigest: executionCandidate.beforeFingerprint.digest,
        });
        session.controlledWriteEntries.push(persistedEntry);
        await store.append({
          type: "recovery.controlled_write",
          runId: input.runId,
          operationId: `recovery-controlled-write-${persistedEntry.tool}-${persistedEntry.phase}-${sha256(JSON.stringify(persistedEntry)).slice(0, 16)}`,
          payload: persistedEntry,
        });
      },
      onOperation: async (operation) => {
        await store.append({
          type: "recovery.workspace_read",
          runId: input.runId,
          operationId: `recovery-workspace-read-${operation.operation}-${operation.attempts}-${sha256(JSON.stringify(operation)).slice(0, 16)}`,
          payload: operation,
        });
      },
      onPlan: async (plan) => {
        await handleSubmittedRecoveryPlan(session, plan);
      },
    }),
  ];
}

export async function runRecoveryModelAttempts(session: RecoveryRunSession): Promise<void> {
  const { input, store, context, tools, audit, executionCandidate, maxModelAttempts, experimentRoot } = session;
  if (!context || !tools || !audit || !executionCandidate)
    throw new Error("Recovery model invocation was not prepared.");
  session.failureStage = "agent_tool_failed";
  session.preflightOperation = "recovery_agent_invoke";
  const modelInputBase = recoveryModelInputAudit(
    context,
    tools.map((tool) => tool.name),
  );
  let retryModel = true;
  while (retryModel) {
    session.modelAttempts += 1;
    const modelInput = { ...modelInputBase, attempt: session.modelAttempts };
    const modelInputBytes = Buffer.from(JSON.stringify(modelInput), "utf8");
    const modelInputArtifact = await store.commitArtifact({
      artifactId: `recovery-model-input-${session.modelAttempts}-${sha256(modelInputBytes).slice(0, 16)}`,
      runId: input.runId,
      kind: "recovery_model_input",
      mediaType: "application/json",
      bytes: modelInputBytes,
      operationId: `recovery-model-input-${session.modelAttempts}-created`,
    });
    await store.append({
      type: "recovery.model_input",
      runId: input.runId,
      operationId: `recovery-model-input-${session.modelAttempts}`,
      payload: {
        caseId: input.caseId,
        attempt: session.modelAttempts,
        artifactId: modelInputArtifact.artifactId,
        contentHash: modelInputArtifact.contentHash,
        byteLength: modelInputArtifact.byteLength,
      },
    });
    await recordRecoveryAttempt(
      session,
      recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${session.modelAttempts}-started`,
        phase: "candidate",
        operation: "invoke_model",
        candidateId: executionCandidate.candidateId,
        attemptNumber: session.modelAttempts,
        result: "started",
        durationMs: 0,
        recordedAt: input.now,
      }),
    );
    const modelStartedAt = Date.now();
    session.recovery = await input.recovery.recover(context, tools, audit);
    await recordRecoveryAttempt(
      session,
      recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${session.modelAttempts}-completed`,
        phase: "candidate",
        operation: "invoke_model",
        candidateId: executionCandidate.candidateId,
        attemptNumber: session.modelAttempts,
        result: session.recovery.status === "completed" ? "succeeded" : "failed",
        ...(session.recovery.status === "failed" ? { failureCode: session.recovery.failure.code } : {}),
        durationMs: Math.max(0, Date.now() - modelStartedAt),
        recordedAt: new Date().toISOString(),
      }),
    );
    const retryFailure = retryableRecoveryFailure(session.recovery);
    retryModel = retryFailure !== undefined && session.modelAttempts < maxModelAttempts;
    if (!retryModel) continue;
    await store.append({
      type: "recovery.model_retry",
      runId: input.runId,
      operationId: `recovery-model-retry-${session.modelAttempts + 1}`,
      payload: { caseId: input.caseId, attempt: session.modelAttempts + 1, previousFailure: retryFailure },
    });
  }
  if (!session.recovery) throw new Error("Recovery model did not return an invocation result.");
  await writeImmutableJson(join(experimentRoot, "recovery.json"), session.recovery);
  await store.append({
    type: "recovery.completed",
    runId: input.runId,
    operationId: "recovery-completed",
    payload: invocationFact(session.recovery),
  });
  if (session.recovery.status !== "completed") {
    session.failureStage =
      session.recovery.status === "cancelled"
        ? "cancelled"
        : session.recovery.status === "failed" && session.recovery.failure.code === "agent_timeout"
          ? "agent_timeout"
          : session.recovery.status === "failed" && session.recovery.failure.code === "invalid_output"
            ? "agent_invalid_output"
            : session.recovery.status === "failed" && session.recovery.failure.kind === "tool"
              ? "agent_tool_failed"
              : "agent_model_failed";
    throw new Error(`Recovery did not complete: ${session.recovery.status}.`);
  }
}

export async function invokeRecoveryAgent(session: RecoveryRunSession): Promise<void> {
  session.context = buildRecoveryAgentContext(session);
  buildRecoveryAgentTools(session);
  await runRecoveryModelAttempts(session);
}
