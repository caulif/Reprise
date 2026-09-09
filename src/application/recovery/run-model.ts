import { sha256 } from "../../core/identity.js";
import type { RecoveryContext } from "../../agents/recovery-agent.js";
import { recoveryWorkingSet } from "../../agents/recovery-working-set.js";
import { OBSERVATIONS_MOUNT, recoveryObservationsRoot, writeFrozenObservationTree } from "../observation-files.js";
import { recoveryTools } from "../../infrastructure/recovery-tools.js";
import { persistRecoveryControlledWriteBlob } from "./writes.js";
import { recoveryClues } from "./investigation.js";
import {
  recoveryFailedFromThrown,
  recoveryInvocationFailureStage,
  retryableRecoveryFailure,
} from "./fail.js";
import { recoveryModelInputAudit } from "./audit.js";
import { invocationFact } from "../experiment-helpers.js";
import {
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./session.js";
import { writeImmutableJson } from "../../infrastructure/store/experiment-store.js";
import { join } from "node:path";
import { recoveryAttemptRecord } from "./orchestrator.js";
import { packRuntime } from "../../products/pack-access.js";
import type { AgentToolDefinition } from "../../infrastructure/agent/host.js";
import { RecoveryValidationError } from "../../environment/local-workspace-provider.js";

export function buildRecoveryAgentContext(session: RecoveryRunSession): RecoveryContext {
  const { input, facts, pack, playbook, staging } = session;
  if (!facts || !pack || !playbook || !staging)
    throw new Error("Recovery agent context was not prepared.");
  return {
    task: {
      caseId: input.taskCase.caseId,
      initialInput: input.taskCase.initialInput,
    },
    evidenceLevel: input.taskCase.evidenceLevel ?? "transcript",
    session: {
      transcriptLength: input.taskCase.transcript.length,
      historicalEventCount: input.taskCase.historicalEvents.length,
    },
    clues: recoveryClues(input.taskCase),
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
  };
}

export function buildRecoveryAgentTools(session: RecoveryRunSession): void {
  const { input, store, staging, activeStaging } = session;
  if (!staging) throw new Error("Recovery staging was not prepared.");
  const workspaceRoot = staging.root;
  session.tools = recoveryTools(workspaceRoot, {
    allowBinary: input.taskCase.privacy.allowBinary,
    mounts: { [OBSERVATIONS_MOUNT]: recoveryObservationsRoot(session.experimentRoot, input.runId) },
    denyDestructiveOnPrefix: [OBSERVATIONS_MOUNT],
    ...(input.allowShell ? { allowShell: true } : {}),
    ...(activeStaging?.temporaryRoot ? { homeRoot: activeStaging.temporaryRoot } : {}),
    onControlledWrite: async (entry) => {
      const persistedEntry = await persistRecoveryControlledWriteBlob(store, workspaceRoot, entry, {
        ...(activeStaging?.checkpointId ? { checkpointId: activeStaging.checkpointId } : {}),
        baseDigest: staging.sourceFingerprint.digest,
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
  });
}

export async function runRecoveryModelAttempts(session: RecoveryRunSession): Promise<void> {
  const { input, store, audit, maxModelAttempts, experimentRoot, staging } = session;
  if (!session.context || !session.tools || !audit || !staging)
    throw new Error("Recovery model invocation was not prepared.");
  session.failureStage = "agent_tool_failed";
  session.preflightOperation = "recovery_agent_invoke";
  let retryModel = true;
  while (retryModel) {
    input.signal?.throwIfAborted();
    session.modelAttempts += 1;
    const context = session.context;
    const tools = session.tools;
    if (!context || !tools) throw new Error("Recovery retry context was not prepared.");
    await persistRecoveryModelInput(session, context, tools);
    await recordRecoveryAttempt(
      session,
      recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${session.modelAttempts}-started`,
        phase: "candidate",
        operation: "invoke_model",
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
  const toolNames = tools.map((tool) => tool.name);
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
    type: "recovery.model_input",
    runId: input.runId,
    operationId: `recovery-model-input-${attempt}`,
    payload: { caseId: input.caseId, attempt, artifactId: artifact.artifactId, contentHash: artifact.contentHash, byteLength: artifact.byteLength },
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
  const { input, context, tools, audit, staging } = session;
  if (!context || !tools || !audit || !staging)
    throw new Error("Recovery mechanical check was not prepared.");
  session.failureStage = "provider_validation_failed";
  let attempts = 0;
  while (attempts < (session.maxModelAttempts ?? 2)) {
    try {
      await session.provider.probeRecovery(staging, requireCompletedEnvelope(session));
      return;
    } catch (error) {
      if (error instanceof RecoveryValidationError && error.code === "source_tripwire_failed") throw error;
      attempts += 1;
      if (attempts >= (session.maxModelAttempts ?? 2)) throw error;
      const facts = error instanceof Error ? error.message : "mechanical check failed";
      session.context = {
        ...context,
        mechanicalFeedback: {
          facts,
          missingReport: /recovery\.md/i.test(facts),
        },
      };
      await persistMechanicalFeedbackInput(session, session.modelAttempts + 1, facts);
      session.modelAttempts += 1;
      const previousCompleted = session.lastCompletedRecovery ?? (session.recovery?.status === "completed" ? session.recovery : undefined);
      try {
        input.signal?.throwIfAborted();
        session.recovery = await input.recovery.recover(session.context, tools, audit, input.signal);
      } catch (feedbackError) {
        session.recovery = recoveryFailedFromThrown(
          feedbackError,
          previousCompleted?.status === "completed" ? previousCompleted.sessionId : "recovery-feedback",
        );
      }
      if (session.recovery.status === "completed") session.lastCompletedRecovery = session.recovery;
      if (session.recovery.status !== "completed") {
        if (previousCompleted?.status === "completed") {
          session.recovery = previousCompleted;
          return;
        }
        session.failureStage = recoveryInvocationFailureStage(session.recovery);
        throw new Error(`Recovery mechanical feedback did not complete: ${session.recovery.status}.`, { cause: error });
      }
    }
  }
}

function requireCompletedEnvelope(session: RecoveryRunSession) {
  if (session.recovery?.status !== "completed") throw new Error("Recovery envelope was not completed.");
  return session.recovery.value;
}

async function persistMechanicalFeedbackInput(session: RecoveryRunSession, nextAttempt: number, facts: string): Promise<void> {
  const { input, store, context, tools } = session;
  if (!context || !tools) throw new Error("Recovery mechanical feedback was not prepared.");
  const feedbackBytes = Buffer.from(JSON.stringify({
    ...recoveryModelInputAudit(context, tools.map((tool) => tool.name)),
    workingSetDigest: sha256(JSON.stringify(recoveryWorkingSet(context))),
    attempt: nextAttempt,
    mechanicalFeedback: facts,
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
    operationId: `recovery-mechanical-feedback-${nextAttempt}`,
    payload: {
      artifactId: feedbackArtifact.artifactId,
      facts,
    },
  });
}
