import { sha256 } from "../core/identity.js";
import type { RecoveryContext } from "../agents/recovery-agent.js";
import { recoveryWorkingSet } from "../agents/recovery-working-set.js";
import { buildRecoveryInvestigationPacket } from "./recovery-investigation-packet.js";
import { OBSERVATIONS_MOUNT, recoveryObservationsRoot, writeFrozenObservationTree } from "./observation-files.js";
import { recoveryTools, validateRecoveryEvidence } from "../infrastructure/recovery-tools.js";
import {
  persistRecoveryControlledWriteBlob,
  recoveryClues,
  recoveryFailedFromThrown,
  recoveryModelInputAudit,
  recoveryInvocationFailureStage,
  retryableRecoveryFailure,
} from "./experiment-recovery-support.js";
import { invocationFact } from "./experiment-helpers.js";
import {
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import { join } from "node:path";
import { recoveryAttemptRecord } from "./recovery-orchestrator.js";
import { deriveRecoveryReadinessContext, checkRecoveryReadiness } from "./recovery-readiness.js";
import { historicalCwdOf } from "./replay-conditions.js";
import { RecoveryValidationError } from "../environment/local-workspace-provider.js";
import { Type } from "@sinclair/typebox";
import { packRuntime } from "../products/pack-access.js";
import type { AgentToolDefinition } from "../infrastructure/pi-agent-host.js";

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
    investigationPacket: buildRecoveryInvestigationPacket(input.taskCase, facts),
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
    ...(session.candidateStagings
      ? { recoveryCandidates: session.candidateStagings.map((candidate) => ({
          candidateId: candidate.candidateId,
          hypothesisId: candidate.hypothesisId,
          beforeDigest: candidate.beforeFingerprint.digest,
        })) }
      : {}),
    runtimeCapabilities: packRuntime(pack).recoveryCapabilities(),
    playbook,
    staging: {
      fileCount: staging.sourceBudget.fileCount,
      totalBytes: staging.sourceBudget.totalBytes,
      ...(staging.sourceBudget.excludedEntries?.length
        ? { excludedEntries: staging.sourceBudget.excludedEntries }
        : {}),
    },
    budget: { timeoutMs: input.recovery.timeoutMs ?? 600_000 },
    allowModelText: input.taskCase.privacy.allowModelText,
    continuityKey: input.experimentId,
    readiness: deriveRecoveryReadinessContext(input.taskCase, historicalCwdOf(input.taskCase)),
  };
}

export function buildRecoveryAgentTools(session: RecoveryRunSession): void {
  const { input, store, executionCandidate, activeStaging } = session;
  if (!executionCandidate) throw new Error("Recovery execution candidate was not prepared.");
  session.tools = [
    {
      name: "select_recovery_candidate",
      description: "Select one Host-materialized recovery candidate before making further changes.",
      parameters: Type.Object({ candidateId: Type.String({ minLength: 1 }) }),
      execute: async (params) => {
        const candidateId = (params as { candidateId?: unknown }).candidateId;
        if (typeof candidateId !== "string") throw new Error("candidateId is required.");
        const candidate = session.candidateStagings?.find((item) => item.candidateId === candidateId);
        if (!candidate || !session.activeStaging || !session.executionCandidate)
          throw new Error(`Recovery candidate is unavailable: ${candidateId}`);
        await session.provider.copyRecoveryCandidateTo(candidate, session.executionCandidate.root);
        session.executionCandidate = { ...session.executionCandidate, hypothesisId: candidate.hypothesisId, beforeFingerprint: candidate.beforeFingerprint };
        await store.append({
          type: "recovery.candidate_selected_by_agent",
          runId: input.runId,
          operationId: `recovery-candidate-selected-by-agent-${candidateId}`,
          payload: { candidateId, hypothesisId: candidate.hypothesisId },
        });
        return { content: `Selected recovery candidate ${candidateId}.` };
      },
    },
    ...recoveryTools(executionCandidate.root, {
      allowBinary: input.taskCase.privacy.allowBinary,
      mounts: { [OBSERVATIONS_MOUNT]: recoveryObservationsRoot(session.experimentRoot, input.runId) },
      denyDestructiveOnPrefix: [OBSERVATIONS_MOUNT],
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
    }),
  ];
}

export async function runRecoveryModelAttempts(session: RecoveryRunSession): Promise<void> {
  const { input, store, audit, maxModelAttempts, experimentRoot } = session;
  if (!session.context || !session.tools || !audit || !session.executionCandidate)
    throw new Error("Recovery model invocation was not prepared.");
  session.failureStage = "agent_tool_failed";
  session.preflightOperation = "recovery_agent_invoke";
  let retryModel = true;
  while (retryModel) {
    input.signal?.throwIfAborted();
    if (session.modelAttempts > 0 && session.recovery?.status === "failed") {
      await refreshRecoveryCandidateForRetry(session);
    }
    session.modelAttempts += 1;
    const context = session.context;
    const tools = session.tools;
    const executionCandidate = session.executionCandidate;
    if (!context || !tools || !executionCandidate) throw new Error("Recovery retry context was not prepared.");
    await persistRecoveryModelInput(session, context, tools);
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
    session.recovery = await input.recovery.recover(context, tools, audit, input.signal);
    if (session.recovery.status === "completed") session.lastCompletedRecovery = session.recovery;
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
    session.failureStage = recoveryInvocationFailureStage(session.recovery);
    throw new Error(`Recovery did not complete: ${session.recovery.status}.`);
  }
}

async function persistRecoveryModelInput(
  session: RecoveryRunSession,
  context: RecoveryContext,
  tools: readonly AgentToolDefinition[],
): Promise<void> {
  const { input, store } = session;
  const attempt = session.modelAttempts;
  const toolNames = tools.map((tool) => (tool as { name: string }).name);
  const bytes = Buffer.from(JSON.stringify({
    ...recoveryModelInputAudit(context, toolNames),
    workingSetDigest: sha256(JSON.stringify(recoveryWorkingSet(context))),
    attempt,
  }), "utf8");
  const artifact = await store.commitArtifact({
    artifactId: `recovery-model-input-${attempt}-${sha256(bytes).slice(0, 16)}`,
    runId: input.runId,
    kind: "recovery_model_input",
    mediaType: "application/json",
    bytes,
    operationId: `recovery-model-input-${attempt}-created`,
  });
  await store.append({
    type: "recovery.investigation_packet",
    runId: input.runId,
    operationId: `recovery-investigation-packet-${attempt}`,
    payload: {
      caseId: input.caseId,
      attempt,
      truncated: context.investigationPacket?.truncated === true,
      pathCount: context.investigationPacket?.candidatePaths.length ?? 0,
      laterUserTurnCount: context.investigationPacket?.laterUserTurns.length ?? 0,
      digest: sha256(JSON.stringify(context.investigationPacket ?? {})),
    },
  });
  await store.append({
    type: "recovery.model_input",
    runId: input.runId,
    operationId: `recovery-model-input-${attempt}`,
    payload: { caseId: input.caseId, attempt, artifactId: artifact.artifactId, contentHash: artifact.contentHash, byteLength: artifact.byteLength },
  });
}

async function refreshRecoveryCandidateForRetry(session: RecoveryRunSession): Promise<void> {
  const { executionCandidate, activeStaging, provider, input } = session;
  if (!executionCandidate || !activeStaging) throw new Error("Recovery retry candidate was not prepared.");
  const previousCandidateId = executionCandidate.candidateId;
  await provider.discardRecoveryCandidate(executionCandidate);
  const retryCandidate = await provider.createRecoveryCandidate(activeStaging, {
    candidateId: `candidate-${executionCandidate.hypothesisId}-retry-${session.modelAttempts + 1}`,
    hypothesisId: executionCandidate.hypothesisId,
  });
  session.executionCandidate = retryCandidate;
  session.modelAttemptCandidate = retryCandidate;
  if (session.candidateStagings) {
    session.candidateStagings = [
      ...session.candidateStagings.filter((candidate) => candidate.candidateId !== previousCandidateId),
      retryCandidate,
    ];
  }
  if (session.investigation) {
    session.investigation = {
      ...session.investigation,
      candidates: session.investigation.candidates
        .filter((candidate) => candidate.candidateId !== previousCandidateId)
        .concat({
          candidateId: retryCandidate.candidateId,
          hypothesisId: retryCandidate.hypothesisId,
          status: "created",
          factRefs: session.investigation.plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === retryCandidate.hypothesisId)?.supportingFactRefs ?? [],
          beforeDigest: retryCandidate.beforeFingerprint.digest,
          createdAt: retryCandidate.createdAt,
        }),
    };
  }
  session.context = buildRecoveryAgentContext(session);
  buildRecoveryAgentTools(session);
  await session.store.append({
    type: "recovery.model_retry_candidate_created",
    runId: input.runId,
    operationId: `recovery-model-retry-candidate-${session.modelAttempts + 1}`,
    payload: { previousCandidateId, candidateId: retryCandidate.candidateId },
  });
}

export async function invokeRecoveryAgent(session: RecoveryRunSession): Promise<void> {
  session.context = buildRecoveryAgentContext(session);
  await writeFrozenObservationTree({
    root: recoveryObservationsRoot(session.experimentRoot, session.input.runId),
    taskCase: session.input.taskCase,
    ...(session.playbook?.text ? { playbookText: session.playbook.text } : {}),
  });
  buildRecoveryAgentTools(session);
  await runRecoveryModelAttempts(session);
}

export async function enforceRecoveryReadiness(session: RecoveryRunSession): Promise<void> {
  const { input, context, tools, audit, executionCandidate, maxModelAttempts } = session;
  if (!context?.readiness || !tools || !audit || !executionCandidate)
    throw new Error("Recovery readiness context was not prepared.");
  const readinessContext = context.readiness;
  if (readinessContext.relevantPaths.length > 0 || readinessContext.observedWorkspaces.length > 0) {
    session.readinessResult = await checkRecoveryReadiness(
      executionCandidate.root,
      readinessContext,
      input.executeReadinessCommands === true ? { executeCommands: true } : {},
    );
  }
  await recordRecoveryReadiness(session, session.readinessResult, session.modelAttempts);
  if (session.readinessResult?.status === "blocked") {
    session.failureStage = "provider_validation_failed";
    session.taskOutcome = "blocked_by_safety";
    throw new RecoveryValidationError("provider_validation_failed", session.readinessResult.feedback);
  }
  while (
    session.readinessResult &&
    session.readinessResult.status !== "ready" &&
    session.modelAttempts < maxModelAttempts &&
    session.lastToolFailureCategory !== "budget_exhausted" &&
    session.haltReadinessFeedback !== true &&
    session.recovery?.status === "completed" &&
    session.recovery.value.status !== "insufficient_evidence"
  )
    await runReadinessFeedbackTurn(session, readinessContext);
  if (session.readinessResult && session.readinessResult.status !== "ready" && session.lastCompletedRecovery?.status !== "completed" && session.recovery?.status !== "completed") {
    session.failureStage = "provider_validation_failed";
    throw new RecoveryValidationError(
      "provider_validation_failed",
      `Recovery did not reach task readiness: ${session.readinessResult.feedback}`,
    );
  }
}

async function runReadinessFeedbackTurn(
  session: RecoveryRunSession,
  readinessContext: NonNullable<RecoveryContext["readiness"]>,
): Promise<void> {
  const { input, context, tools, audit, executionCandidate } = session;
  const readinessResult = session.readinessResult;
  if (!context || !tools || !audit || !executionCandidate || !readinessResult)
    throw new Error("Recovery readiness feedback was not prepared.");
  session.context = {
    ...context,
    readinessFeedback: {
      status: readinessResult.status,
      feedback: readinessResult.feedback,
      missingPaths: readinessResult.missingPaths,
    },
  };
  const nextAttempt = session.modelAttempts + 1;
  await persistReadinessFeedbackInput(session, nextAttempt);
  session.modelAttempts = nextAttempt;
  const feedbackStartedAt = Date.now();
  const previousCompleted = session.lastCompletedRecovery ?? (session.recovery?.status === "completed" ? session.recovery : undefined);
  try {
    input.signal?.throwIfAborted();
    session.recovery = await input.recovery.recover(session.context, tools, audit, input.signal);
  } catch (error) {
    session.recovery = recoveryFailedFromThrown(
      error,
      previousCompleted?.status === "completed" ? previousCompleted.sessionId : "recovery-feedback",
    );
  }
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
      durationMs: Math.max(0, Date.now() - feedbackStartedAt),
      recordedAt: new Date().toISOString(),
    }),
  );
  if (input.signal?.aborted) input.signal.throwIfAborted();
  if (session.recovery.status !== "completed") {
    await keepEnvelopeAfterFailedFeedback(session, previousCompleted);
    return;
  }
  const previousValid = previousCompleted?.status === "completed" ? previousCompleted : undefined;
  const newUsable = await completedEnvelopeUsable(session, session.recovery);
  if (!newUsable && previousValid && (await completedEnvelopeUsable(session, previousValid))) {
    await keepEnvelopeAfterInvalidCompletedFeedback(session, previousValid);
    return;
  }
  session.lastCompletedRecovery = session.recovery;
  session.readinessResult = await checkRecoveryReadiness(
    executionCandidate.root,
    readinessContext,
    input.executeReadinessCommands === true ? { executeCommands: true } : {},
  );
  await recordRecoveryReadiness(session, session.readinessResult, session.modelAttempts);
}

async function persistReadinessFeedbackInput(session: RecoveryRunSession, nextAttempt: number): Promise<void> {
  const { input, store, context, tools, readinessResult } = session;
  if (!context || !tools || !readinessResult) throw new Error("Recovery readiness feedback was not prepared.");
  const feedbackBytes = Buffer.from(JSON.stringify({
    ...recoveryModelInputAudit(context, tools.map((tool) => tool.name)),
    workingSetDigest: sha256(JSON.stringify(recoveryWorkingSet(context))),
    attempt: nextAttempt,
    feedbackTurn: true,
  }), "utf8");
  const feedbackArtifact = await store.commitArtifact({
    artifactId: `recovery-model-input-feedback-${nextAttempt}-${sha256(feedbackBytes).slice(0, 16)}`,
    runId: input.runId,
    kind: "recovery_model_input",
    mediaType: "application/json",
    bytes: feedbackBytes,
    operationId: `recovery-model-input-feedback-${nextAttempt}-created`,
  });
  await store.append({
    type: "recovery.model_input",
    runId: input.runId,
    operationId: `recovery-model-input-feedback-${nextAttempt}`,
    payload: {
      caseId: input.caseId,
      attempt: nextAttempt,
      artifactId: feedbackArtifact.artifactId,
      contentHash: feedbackArtifact.contentHash,
      byteLength: feedbackArtifact.byteLength,
      feedbackTurn: true,
    },
  });
  await store.append({
    type: "recovery.readiness_feedback",
    runId: input.runId,
    operationId: `recovery-readiness-feedback-${nextAttempt}`,
    payload: {
      artifactId: feedbackArtifact.artifactId,
      previousStatus: readinessResult.status,
      missingPaths: readinessResult.missingPaths,
    },
  });
}

async function completedEnvelopeUsable(
  session: RecoveryRunSession,
  recovery: NonNullable<RecoveryRunSession["recovery"]>,
): Promise<boolean> {
  const { facts, activeStaging } = session;
  if (recovery.status !== "completed" || !facts || !activeStaging) return false;
  try {
    validateRecoveryEvidence(facts.evidenceRefs, recovery.value);
    await session.provider.probeRecovery(
      activeStaging,
      recovery.value,
      facts.verifiedEvidence,
      session.executionCandidate,
    );
    return true;
  } catch (error) {
    if (error instanceof RecoveryValidationError && error.code === "source_tripwire_failed") throw error;
    return false;
  }
}

async function keepEnvelopeAfterInvalidCompletedFeedback(
  session: RecoveryRunSession,
  previousCompleted: RecoveryRunSession["lastCompletedRecovery"],
): Promise<void> {
  await session.store.append({
    type: "recovery.warning",
    runId: session.input.runId,
    operationId: `recovery-later-envelope-rejected-${session.modelAttempts}`,
    payload: {
      caseId: session.input.caseId,
      attempt: session.modelAttempts,
      reason: "later_envelope_validation_failed",
      keptCompletedEnvelope: Boolean(previousCompleted),
    },
  });
  if (previousCompleted?.status === "completed") {
    session.recovery = previousCompleted;
    session.lastCompletedRecovery = previousCompleted;
    session.haltReadinessFeedback = true;
    return;
  }
  if (session.recovery?.status === "completed") session.lastCompletedRecovery = session.recovery;
}

async function keepEnvelopeAfterFailedFeedback(
  session: RecoveryRunSession,
  previousCompleted: RecoveryRunSession["lastCompletedRecovery"],
): Promise<void> {
  if (!session.recovery || session.recovery.status === "completed") return;
  await session.store.append({
    type: "recovery.model_retry",
    runId: session.input.runId,
    operationId: `recovery-model-retry-feedback-${session.modelAttempts}`,
    payload: {
      caseId: session.input.caseId,
      attempt: session.modelAttempts,
      previousFailure: session.recovery.status === "failed" ? session.recovery.failure.code : session.recovery.status,
      keptCompletedEnvelope: Boolean(previousCompleted),
    },
  });
  if (previousCompleted) {
    session.recovery = previousCompleted;
    session.lastCompletedRecovery = previousCompleted;
    session.haltReadinessFeedback = true;
    return;
  }
  session.failureStage = recoveryInvocationFailureStage(session.recovery);
  throw new Error(`Recovery feedback turn did not complete: ${session.recovery.status}.`);
}

async function recordRecoveryReadiness(
  session: RecoveryRunSession,
  result: RecoveryRunSession["readinessResult"],
  attempt: number,
): Promise<void> {
  if (!result || !session.executionCandidate) return;
  const fingerprint = await session.provider.fingerprintRecoveryCandidate(session.executionCandidate);
  const signature = sha256(
    JSON.stringify({ status: result.status, missingPaths: result.missingPaths, digest: fingerprint.digest }),
  );
  session.noProgressTurns =
    signature === session.readinessSignature && result.status !== "ready"
      ? (session.noProgressTurns ?? 0) + 1
      : 0;
  session.readinessSignature = signature;
  await session.store.append({
    type: "recovery.readiness_checked",
    runId: session.input.runId,
    operationId: `recovery-readiness-${attempt}`,
    payload: {
      status: result.status,
      checkedPaths: result.checkedPaths,
      missingPaths: result.missingPaths,
      commandChecks: result.commandChecks,
      stagingDigest: fingerprint.digest,
      noProgressTurns: session.noProgressTurns,
    },
  });
  if ((session.noProgressTurns ?? 0) >= 2) {
    await session.store.append({
      type: "recovery.no_progress",
      runId: session.input.runId,
      operationId: `recovery-no-progress-${attempt}`,
      payload: { attempt, stagingDigest: fingerprint.digest, feedback: result.feedback },
    });
    throw new RecoveryValidationError(
      "provider_validation_failed",
      `Recovery made no observable progress: ${result.feedback}`,
    );
  }
}
