import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { RecoveryContext, RecoveryPlaybook, RecoveryResult } from "../agents/recovery-agent.js";
import type {
  RecoveryCandidate,
  RecoveryControlledWrite,
  RecoveryInvestigation,
} from "../core/schema.js";
import {
  LocalWorkspaceProvider,
  type EnvironmentBaseline,
  type RecoveryCandidateStaging,
  type RecoveryPreview,
  type RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import type {
  AgentAuditSink,
  AgentToolDefinition,
  StructuredAgentResult,
} from "../infrastructure/pi-agent-host.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { resolvedRecoveryFacts } from "../infrastructure/recovery-tools.js";
import type { ProductPack } from "../products/contract.js";
import { assertIds, assertPaths } from "./experiment-helpers.js";
import { failRecoverCodexExperiment } from "./experiment-recovery-fail.js";
import type { RecoveryAttempt, RecoveryAttemptInput, RecoveryAttemptMode } from "./experiment-recovery-types.js";
import {
  RecoveryOrchestrator,
  recoveryAttemptRecord,
  type RecoveryLifecycleState,
} from "./recovery-orchestrator.js";
import type { RecoveryReadinessResult } from "./recovery-readiness.js";

export type RecoveryFacts = Awaited<ReturnType<typeof resolvedRecoveryFacts>>;

export type RecoveryRunSession = {
  input: RecoveryAttemptInput;
  maxModelAttempts: number;
  experimentRoot: string;
  provider: LocalWorkspaceProvider;
  store: ExperimentStore;
  unsubscribe?: () => void;
  staging?: RecoveryStaging;
  recovery?: StructuredAgentResult<RecoveryResult>;
  candidateCreated: boolean;
  recoveredPaths: string[];
  verification: "verified" | "pending_user_review" | "rejected" | "insufficient_evidence";
  forensicsCompleted: boolean;
  evidenceSourcesAttempted?: number;
  evidenceSourcesAvailable?: number;
  hypothesisCount?: number;
  candidateCount?: number;
  verifierRejectionReasons?: string[];
  providerFailureRetryable: boolean | undefined;
  pathBoundaryRejected?: boolean;
  readinessResult?: RecoveryReadinessResult;
  taskOutcome?: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"];
  automaticallyAcceptedBaseline?: EnvironmentBaseline;
  writerAcquired: boolean;
  toolFailureByTool: Map<string, number>;
  lastToolFailureCategory?: string;
  controlledWriteEntries: RecoveryControlledWrite[];
  recoveryOrchestrator: RecoveryOrchestrator;
  modelAttempts: number;
  attemptMode: RecoveryAttemptMode;
  preflightOperation: string;
  failureStage: NonNullable<EnvironmentBaseline["recovery"]>["failureStage"];
  pack?: ProductPack;
  playbook?: RecoveryPlaybook;
  activeStaging?: RecoveryStaging;
  audit?: AgentAuditSink;
  facts?: RecoveryFacts;
  investigation?: RecoveryInvestigation;
  candidateRecipeDigests?: Set<string>;
  candidateStagings?: RecoveryCandidateStaging[];
  remainingSearchBudget?: number;
  executionCandidate?: RecoveryCandidateStaging;
  context?: RecoveryContext;
  tools?: AgentToolDefinition[];
  graphCandidates?: RecoveryCandidate[];
  candidateReviews?: { candidateId: string; artifactId: string }[];
  candidateGraphArtifactId?: string;
  activeProviderPreview?: RecoveryPreview;
};

export function lifecycleState(session: RecoveryRunSession): RecoveryLifecycleState {
  return session.recoveryOrchestrator.state;
}

export function moveRecoveryState(
  session: RecoveryRunSession,
  next: Parameters<RecoveryOrchestrator["transition"]>[0],
): void {
  session.recoveryOrchestrator.transition(next);
}

export async function recordRecoveryAttempt(
  session: RecoveryRunSession,
  record: ReturnType<typeof recoveryAttemptRecord>,
): Promise<void> {
  await session.recoveryOrchestrator.recordAttempt(record);
}

export async function createRecoveryRunSession(
  input: RecoveryAttemptInput,
): Promise<RecoveryRunSession> {
  assertPaths(input.dataDir, input.sourceRoot);
  if (input.checkpointRoot && !isAbsolute(input.checkpointRoot))
    throw new Error("Recovery checkpoint path must be absolute.");
  assertIds(input);
  const maxModelAttempts = input.maxModelAttempts ?? 2;
  if (!Number.isSafeInteger(maxModelAttempts) || maxModelAttempts < 1)
    throw new Error("Recovery maxModelAttempts must be a positive integer.");
  const experimentRoot = join(resolve(input.dataDir), "experiments", input.experimentId);
  const provider =
    input.environmentProvider ??
    new LocalWorkspaceProvider(
      input.checkpointRoot
        ? dirname(dirname(resolve(input.checkpointRoot)))
        : join(experimentRoot, "environment"),
    );
  await mkdir(experimentRoot, { recursive: true });
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  return {
    input,
    maxModelAttempts,
    experimentRoot,
    provider,
    store,
    ...(input.onEvent ? { unsubscribe: store.subscribe(input.onEvent) } : {}),
    candidateCreated: false,
    recoveredPaths: [],
    verification: "insufficient_evidence",
    forensicsCompleted: false,
    providerFailureRetryable: undefined,
    writerAcquired: false,
    toolFailureByTool: new Map(),
    controlledWriteEntries: [],
    recoveryOrchestrator: new RecoveryOrchestrator({
      onAttempt: async (record) => {
        await store.append({
          type: "recovery.attempt",
          runId: input.runId,
          operationId: record.attemptId,
          payload: { caseId: input.caseId, ...record },
        });
      },
    }),
    modelAttempts: 0,
    attemptMode: input.attemptMode ?? "maximum-effort-safe",
    preflightOperation: "begin_recovery_staging",
    failureStage: "preflight_failed",
  };
}

export async function failRecoveryRunSession(
  session: RecoveryRunSession,
  error: unknown,
): Promise<RecoveryAttempt> {
  return failRecoverCodexExperiment({
    error,
    attemptInput: session.input,
    store: session.store,
    provider: session.provider,
    experimentRoot: session.experimentRoot,
    staging: session.staging,
    recovery: session.recovery,
    recoveryOrchestrator: session.recoveryOrchestrator,
    lifecycleState: () => lifecycleState(session),
    moveRecoveryState: (next) => moveRecoveryState(session, next),
    failureStage: session.failureStage,
    preflightOperation: session.preflightOperation,
    writerAcquired: session.writerAcquired,
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
    readinessResult: session.readinessResult,
    taskOutcome: session.taskOutcome,
    modelAttempts: session.modelAttempts,
    toolFailureByTool: session.toolFailureByTool,
    lastToolFailureCategory: session.lastToolFailureCategory,
  });
}

export async function closeRecoveryRunSession(session: RecoveryRunSession): Promise<void> {
  if (session.writerAcquired) {
    const terminalStatus = session.failureStage === "preflight_failed" ? "failed" : "completed";
    try {
      await session.store.cleanupRecoveryArtifacts({
        runId: session.input.runId,
        terminalStatus,
      });
    } catch (error: unknown) {
      // Cleanup is best effort after the terminal record; a cleanup failure must not rewrite the Recovery outcome.
      try {
        await session.store.append({
          type: "recovery.artifact_cleanup_failed",
          runId: session.input.runId,
          operationId: "recovery-artifact-cleanup-terminal-failed",
          payload: { terminalStatus, reasonCode: error instanceof Error ? error.name : "unknown" },
        });
      } catch {
        // The writer may already be unusable; the terminal record remains authoritative.
      }
    }
  }
  session.unsubscribe?.();
  await session.store.close();
}
