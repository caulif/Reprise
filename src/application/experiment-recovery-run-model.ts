import { sha256 } from "../core/identity.js";
import type { RecoveryContext } from "../agents/recovery-agent.js";
import { buildRecoveryInvestigationPacket } from "./recovery-investigation-packet.js";
import { recoveryObservationTools, recoveryTools, validateRecoveryEvidence } from "../infrastructure/recovery-tools.js";
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
    runtimeCapabilities: pack.runtime.recoveryCapabilities(),
    playbook,
    staging: {
      fileCount: staging.sourceBudget.fileCount,
      totalBytes: staging.sourceBudget.totalBytes,
      ...(staging.sourceBudget.excludedEntries?.length
        ? { excludedEntries: staging.sourceBudget.excludedEntries }
        : {}),
    },
    budget: { timeoutMs: 600_000 },
    allowModelText: input.taskCase.privacy.allowModelText,
    readiness: deriveRecoveryReadinessContext(input.taskCase, historicalCwdOf(input.taskCase)),
  };
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
    ...recoveryTools(executionCandidate.root, {
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
  const { input, store, context, tools, audit, executionCandidate, maxModelAttempts, experimentRoot } = session;
  if (!context || !tools || !audit || !executionCandidate)
    throw new Error("Recovery model invocation was not prepared.");
  session.failureStage = "agent_tool_failed";
  session.preflightOperation = "recovery_agent_invoke";
  const modelInputBase = recoveryModelInputAudit(context, tools.map((tool) => tool.name));
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
      type: "recovery.investigation_packet",
      runId: input.runId,
      operationId: `recovery-investigation-packet-${session.modelAttempts}`,
      payload: {
        caseId: input.caseId,
        attempt: session.modelAttempts,
        truncated: context.investigationPacket?.truncated === true,
        pathCount: context.investigationPacket?.candidatePaths.length ?? 0,
        laterUserTurnCount: context.investigationPacket?.laterUserTurns.length ?? 0,
        digest: sha256(JSON.stringify(context.investigationPacket ?? {})),
      },
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

export async function invokeRecoveryAgent(session: RecoveryRunSession): Promise<void> {
  session.context = buildRecoveryAgentContext(session);
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
    session.haltReadinessFeedback !== true
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
  const { input, store, context, tools, audit, executionCandidate } = session;
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
  const feedbackInput = recoveryModelInputAudit(
    session.context,
    tools.map((tool) => tool.name),
  );
  const feedbackBytes = Buffer.from(
    JSON.stringify({ ...feedbackInput, attempt: nextAttempt, feedbackTurn: true }),
    "utf8",
  );
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
  session.modelAttempts = nextAttempt;
  const feedbackStartedAt = Date.now();
  const previousCompleted = session.lastCompletedRecovery ?? (session.recovery?.status === "completed" ? session.recovery : undefined);
  try {
    session.recovery = await input.recovery.recover(session.context, tools, audit);
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
