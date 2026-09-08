import { resolve } from "node:path";
import type { AgentAuditEvent, AgentAuditSink } from "../infrastructure/pi-agent-host.js";
import { findProductPack } from "../products/index.js";
import { packRecoveryPlaybook } from "../products/pack-access.js";
import { completeHostCheckpointRecovery } from "./experiment-recovery-checkpoint.js";
import type { RecoveryAttempt } from "./experiment-recovery-types.js";
import { retryRecoveryPreflight } from "./experiment-recovery-support.js";
import { persistAgentAuditEvent } from "./experiment-helpers.js";
import {
  moveRecoveryState,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";

export function recoveryToolFailureCategory(payload: { category?: unknown; message?: unknown }): string {
  const message = typeof payload.message === "string" ? payload.message : "";
  if (/destructive change budget of 16|delete_file budget of 16|tool-call budget of /.test(message)) return "budget_exhausted";
  if (typeof payload.category === "string") return payload.category;
  return "tool_execution_failed";
}

export function createRecoveryAuditSink(session: RecoveryRunSession): AgentAuditSink {
  const { store, input, toolFailureByTool } = session;
  return {
    append: async (event: AgentAuditEvent): Promise<void> => {
      if (event.type === "agent.tool_failed") {
        const tool = typeof event.payload.tool === "string" ? event.payload.tool : "unknown";
        toolFailureByTool.set(tool, (toolFailureByTool.get(tool) ?? 0) + 1);
        session.lastToolFailureCategory = recoveryToolFailureCategory(event.payload);
      }
      await persistAgentAuditEvent(store, input.runId, event);
    },
  };
}

export async function beginRecoveryStaging(session: RecoveryRunSession): Promise<void> {
  const { input, store, provider } = session;
  await store.acquireWriter();
  session.writerAcquired = true;
  const pack = input.pack ?? findProductPack(input.taskCase.source.productId);
  const descriptor = packRecoveryPlaybook(pack);
  const playbook = {
    productId: pack.manifest.productId,
    ...descriptor,
  };
  session.pack = pack;
  session.playbook = playbook;
  session.staging = await retryRecoveryPreflight(
    "begin_recovery_staging",
    () =>
      provider.beginRecovery({
        caseId: input.caseId,
        sourceRoot: resolve(input.sourceRoot),
        ...(input.checkpointRoot ? { checkpointRoot: resolve(input.checkpointRoot) } : {}),
        playbook,
      }),
    async (diagnostic) => {
      await store.append({
        type: "recovery.preflight_retry",
        runId: input.runId,
        operationId: "recovery-preflight-retry-2",
        payload: { attempt: 2, ...diagnostic },
      });
    },
  );
  session.activeStaging = session.staging;
  moveRecoveryState(session, "staged");
  session.preflightOperation = "recovery_resolve_facts";
  session.audit = createRecoveryAuditSink(session);
  await store.append({
    type: "recovery.started",
    runId: input.runId,
    operationId: "recovery-started",
    payload: {
      sourceDigest: session.staging.sourceFingerprint.digest,
      evidenceLevel: input.taskCase.evidenceLevel ?? "transcript",
      attemptMode: session.attemptMode,
      playbook: { version: playbook.version, sha256: playbook.sha256 },
      sensitiveFileCounts: session.staging.sourceBudget.sensitiveFileCounts ?? {
        env: 0,
        credential: 0,
        private_key: 0,
      },
      excludedEntries: session.staging.sourceBudget.excludedEntries ?? [],
    },
  });
}

export async function tryHostCheckpointRecovery(
  session: RecoveryRunSession,
): Promise<RecoveryAttempt | undefined> {
  const staging = session.staging;
  const activeStaging = session.activeStaging;
  if (!staging || !activeStaging) throw new Error("Recovery staging was not prepared.");
  return completeHostCheckpointRecovery({
    input: session.input,
    staging,
    experimentRoot: session.experimentRoot,
    store: session.store,
    provider: session.provider,
    activeStaging,
    recoveryOrchestrator: session.recoveryOrchestrator,
    readinessResult: session.readinessResult,
    forensicsCompleted: session.forensicsCompleted,
    evidenceSourcesAttempted: session.evidenceSourcesAttempted,
    evidenceSourcesAvailable: session.evidenceSourcesAvailable,
    hypothesisCount: session.hypothesisCount,
    candidateCount: session.candidateCount,
    verifierRejectionReasons: session.verifierRejectionReasons,
    providerFailureRetryable: session.providerFailureRetryable,
    pathBoundaryRejected: session.pathBoundaryRejected,
  });
}
