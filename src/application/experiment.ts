import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  ComparisonAgentPort,
  ComparisonResult,
} from "../agents/comparison-agent.js";
import {
  historicalUserFollowups,
  type ControllerDecision,
  type ControllerPort,
  type SteeringContext,
} from "../agents/controller-agent.js";
import type {
  RecoveryAgentPort,
  RecoveryResult,
} from "../agents/recovery-agent.js";
import { rewindIsolatedWorkspaceToStart } from "./session-start-workspace.js";
import { verifyRecoveryCandidate } from "./recovery-verifier.js";
import { CandidateRun } from "./candidate-run.js";
import { persistRecoveryEvaluation } from "./recovery-evaluation.js";
import {
  RecoveryCandidateGraphSchema,
  RecoveryInvestigationSchema,
  RecoveryReviewSummarySchema,
  RecoveryControlledWriteSchema,
  RecoveryReviewFeedbackSchema,
  RecoveryExternalEffectSchema,
  RecoveryCompensationRequestSchema,
  RecoveryCompensationResultSchema,
  type RecoveryReviewSummary,
  type RecoveryReviewFeedback,
  type RecoveryExternalEffect,
  type RecoveryCompensationRequest,
  type RecoveryCompensationResult,
} from "../core/schema.js";
import { currentRunEventRefs, observationReadRecord } from "./controller-request.js";
import { sha256 } from "../core/identity.js";
import { replayControlledRecoveryDeltaBytes } from "../infrastructure/recovery-write-journal.js";
import type {
  CandidateSpec,
  EventEnvelope,
  RunManifest,
  RunPolicy,
  RunRecord,
  TaskCase,
  RecoveryCandidateGraph,
  RecoveryInvestigation,
  RecoveryManifest,
  RecoveryPlan,
  RecoveryControlledWrite,
} from "../core/schema.js";
import type {
  ResolvedRuntime,
  RuntimePort,
  TargetEvent,
  TargetEventSink,
} from "../core/runtime.js";
import {
  LocalWorkspaceProvider,
  RecoveryValidationError,
  type EnvironmentBaseline,
  type PreparedEnvironmentRef,
  type RecoveryPreview,
  type RecoveryCheckpoint,
  type RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import type { ContaminationSignals } from "../environment/contamination.js";
import { observationTools } from "../infrastructure/agent-tools.js";
import {
  recoveryObservationTools,
  recoveryTools,
  resolvedRecoveryFacts,
  validateRecoveryEvidence,
  RecoveryEvidenceValidationError,
  type RecoveryEvidenceVerification,
} from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import {
  ExperimentStore,
  writeImmutableJson,
} from "../infrastructure/store/experiment-store.js";
import { findProductPack } from "../products/index.js";
import type { ProductPack } from "../products/contract.js";
import {
  historicalCwdOf,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import {
  assertIds,
  assertPaths,
  invocationFact,
  isCompleted,
  isMissing,
} from "./experiment-helpers.js";
import { captureWorkspaceScope, inspectRun } from "./experiment-inspection.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import { finishExperiment } from "./experiment-report.js";
import { decideRecoverySearch } from "./recovery-selection.js";
import { materializeRecoveryCandidates } from "./recovery-candidate-materialization.js";
import { RecoveryOrchestrator, recoveryAttemptRecord, type RecoveryLifecycleState } from "./recovery-orchestrator.js";
import { checkRecoveryReadiness, deriveRecoveryReadinessContext, type RecoveryReadinessResult } from "./recovery-readiness.js";

export type { SourceRootKind };
export { preflightCodexExperiment } from "./experiment-preflight.js";

export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: { callTimeoutMs: number; maxStructuredRepairAttempts: number };
};

export type CodexExperimentPreflight = {
  sourceBaseline: "available" | "partial" | "unavailable";
  resolved: ResolvedRuntime;
  sourceFingerprint?: string;
  workspace?: EnvironmentBaseline["budget"];
  limitations: readonly string[];
  comparisonClass: "observational" | "recovered" | "recovered_partial";
  contamination?: ContaminationSignals;
};

export type CodexExperimentResult = {
  taskCase: TaskCase;
  experimentRoot: string;
  reportPath: string;
  preflight: CodexExperimentPreflight;
  record: RunRecord;
  decision: StructuredAgentResult<ControllerDecision>;
  comparison: { result: StructuredAgentResult<ComparisonResult> };
  followupSubmission: boolean;
  targetEvents: readonly string[];
  checkpoint?: RecoveryCheckpoint;
  facts: {
    elapsedMs: number;
    turns: number;
    controllerCalls: number;
    wallClockMs?: number;
    tokenCount?: number;
  };
};

export type CodexExperimentInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  sourceRootKind?: SourceRootKind;
  taskCase: TaskCase | ((baseline: EnvironmentBaseline) => TaskCase);
  candidate: CandidateSpec;
  policy: RunPolicy;
  agentConfig: ExperimentAgentConfig;
  /** Comparison may use a different persisted Harness model. */
  comparisonAgentConfig?: ExperimentAgentConfig;
  runtime: RuntimePort;
  pack?: ProductPack;
  environmentProvider?: LocalWorkspaceProvider;
  /** A previously validated Recovery preview selected by the operator. */
  preResolvedBaseline?: EnvironmentBaseline;
  /** Digest captured by preflight; prevents replaying a source that changed while the user reviewed it. */
  expectedSourceFingerprint?: string;
  controller: ControllerPort;
  comparison: ComparisonAgentPort;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  captureArtifacts?: (input: {
    store: ExperimentStore;
    environment: PreparedEnvironmentRef;
    workspaceProvider: LocalWorkspaceProvider;
    sourceRoot: string;
    experimentId: string;
    runId: string;
  }) => Promise<readonly RunRecord["artifactRefs"][number][] | readonly []>;
};

export type ExperimentHandle = {
  result: Promise<CodexExperimentResult>;
  cancel(): Promise<void>;
};

export type RecoveryAttempt = {
  readonly baseline: EnvironmentBaseline;
  readonly providerPreview?: RecoveryPreview;
  readonly staging?: RecoveryStaging;
  /** Host-measured task continuation readiness; candidates are not user-facing success. */
  readonly taskReadiness?: RecoveryReadinessResult;
  /** True when Host promoted the ready staging baseline without operator selection. */
  readonly acceptedAutomatically?: boolean;
  readonly recovery: StructuredAgentResult<RecoveryResult>;
  /** Immutable candidate graph artifact for operator review before acceptance. */
  readonly candidateGraphArtifactId?: string;
  /** Host-owned review action; selecting an unexecuted branch never accepts it. */
  selectCandidate?(candidateId: string): Promise<void>;
  /** Re-executes a Host-selected alternate candidate before it can be accepted. */
  reexecuteCandidate?(candidateId?: string): Promise<void>;
  /** Records an explicit operator verdict as Host-owned evidence without accepting implicitly. */
  recordReviewFeedback?(input: { candidateId: string; decision: RecoveryReviewFeedback["decision"]; evidenceRefs?: readonly string[] }): Promise<string>;
  /** Records an external effect without claiming that local recovery reversed it. */
  recordExternalEffect?(input: Omit<RecoveryExternalEffect, "schemaVersion" | "recordedAt">): Promise<string>;
  /** Creates an auditable compensation request; unobserved effects remain review-required. */
  requestCompensation?(input: Omit<RecoveryCompensationRequest, "schemaVersion" | "requestedAt">): Promise<RecoveryCompensationResult>;
  readonly experimentRoot: string;
  readonly experimentId: string;
  readonly provider: LocalWorkspaceProvider;
  accept?(): Promise<EnvironmentBaseline>;
};

export type RecoveryAttemptMode =
  "maximum-effort-safe" | "maximum-effort-review" | "maximum-effort-aggressive";

export type RecoveryAttemptInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  /** Optional Host-owned pre-mutation checkpoint captured before the task started. */
  checkpointRoot?: string;
  taskCase: TaskCase;
  recovery: RecoveryAgentPort;
  /** Defaults to safe maximum-effort investigation in isolated staging. */
  attemptMode?: RecoveryAttemptMode;
  /** Bounds retries after transient Recovery model failures; each attempt is independently audited. */
  maxModelAttempts?: number;
  /** Explicit Host capability for legacy shell-based diagnostics; disabled by default. */
  allowShell?: boolean;
  /** Explicit opt-in for replaying allowlisted historical commands inside recovery staging. */
  executeReadinessCommands?: boolean;
  maxToolCalls: number;
  environmentProvider?: LocalWorkspaceProvider;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
};

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverCodexExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  assertPaths(input.dataDir, input.sourceRoot);
  if (input.checkpointRoot && !isAbsolute(input.checkpointRoot))
    throw new Error("Recovery checkpoint path must be absolute.");
  assertIds(input);
  const maxModelAttempts = input.maxModelAttempts ?? 2;
  if (!Number.isSafeInteger(maxModelAttempts) || maxModelAttempts < 1)
    throw new Error("Recovery maxModelAttempts must be a positive integer.");
  const experimentRoot = join(
    resolve(input.dataDir),
    "experiments",
    input.experimentId,
  );
  const provider =
    input.environmentProvider ??
    new LocalWorkspaceProvider(
      input.checkpointRoot
        ? dirname(dirname(resolve(input.checkpointRoot)))
        : join(experimentRoot, "environment"),
    );
  await mkdir(experimentRoot, { recursive: true });
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent
    ? store.subscribe(input.onEvent)
    : undefined;
  let staging: RecoveryStaging | undefined;
  let recovery: StructuredAgentResult<RecoveryResult> | undefined;
  let candidateCreated = false;
  let recoveredPaths: string[] = [];
  let verification:
    "verified" | "pending_user_review" | "rejected" | "insufficient_evidence" =
    "insufficient_evidence";
  let forensicsCompleted = false;
  let evidenceSourcesAttempted: number | undefined;
  let evidenceSourcesAvailable: number | undefined;
  let hypothesisCount: number | undefined;
  let candidateCount: number | undefined;
  let verifierRejectionReasons: string[] | undefined;
  let providerFailureRetryable: boolean | undefined;
  let pathBoundaryRejected: boolean | undefined;
  let readinessResult: RecoveryReadinessResult | undefined;
  let taskOutcome: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"] | undefined;
  let automaticallyAcceptedBaseline: EnvironmentBaseline | undefined;
  let writerAcquired = false;
  const toolFailureByTool = new Map<string, number>();
  let lastToolFailureCategory: string | undefined;
  const controlledWriteEntries: RecoveryControlledWrite[] = [];
  const recoveryOrchestrator = new RecoveryOrchestrator({
    onAttempt: async (record) => {
      await store.append({ type: "recovery.attempt", runId: input.runId, operationId: record.attemptId, payload: { caseId: input.caseId, ...record } });
    },
  });
  let modelAttempts = 0;
  const attemptMode = input.attemptMode ?? "maximum-effort-safe";
  const lifecycleState = (): RecoveryLifecycleState => recoveryOrchestrator.state;
  const moveRecoveryState = (next: Parameters<RecoveryOrchestrator["transition"]>[0]): void => recoveryOrchestrator.transition(next);
  let preflightOperation = "begin_recovery_staging";
  const recordRecoveryAttempt = async (record: ReturnType<typeof recoveryAttemptRecord>): Promise<void> => recoveryOrchestrator.recordAttempt(record);
  let failureStage: NonNullable<
    EnvironmentBaseline["recovery"]
  >["failureStage"] = "preflight_failed";
  try {
    await store.acquireWriter();
    writerAcquired = true;
    const pack = findProductPack(input.taskCase.source.productId);
    const descriptor = pack.recoveryPlaybook();
    const playbook = {
      productId: pack.manifest.productId,
      ...descriptor,
    };
    staging = await retryRecoveryPreflight(
      "begin_recovery_staging",
      () =>
        provider.beginRecovery({
          caseId: input.caseId,
          sourceRoot: resolve(input.sourceRoot),
          ...(input.checkpointRoot
            ? { checkpointRoot: resolve(input.checkpointRoot) }
            : {}),
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
    const activeStaging = staging;
    moveRecoveryState("staged");
    preflightOperation = "recovery_resolve_facts";
    const audit = {
      append: async (
        event: import("../infrastructure/pi-agent-host.js").AgentAuditEvent,
      ): Promise<void> => {
        if (event.type === "agent.tool_failed") {
          const tool = typeof event.payload.tool === "string" ? event.payload.tool : "unknown";
          toolFailureByTool.set(tool, (toolFailureByTool.get(tool) ?? 0) + 1);
          lastToolFailureCategory = typeof event.payload.category === "string" ? event.payload.category : "tool_execution_failed";
        }
        await store.append({
          type: event.type,
          runId: input.runId,
          payload: {
            role: event.role,
            sessionId: event.sessionId,
            ...event.payload,
          },
        });
      },
    };
    await store.append({
      type: "recovery.started",
      runId: input.runId,
      operationId: "recovery-started",
      payload: {
        sourceDigest: staging.sourceFingerprint.digest,
        evidenceLevel: input.taskCase.evidenceLevel ?? "transcript",
        attemptMode,
        playbook: { version: playbook.version, sha256: playbook.sha256 },
        sensitiveFileCounts: staging.sourceBudget.sensitiveFileCounts ?? { env: 0, credential: 0, private_key: 0 },
      },
    });
    if (staging.checkpointFingerprint && staging.checkpointId) {
      const checkpoint = hostCheckpointRecovery(staging);
      recovery = {
        status: "completed",
        sessionId: `host-${staging.checkpointId}`,
        value: checkpoint.result,
      };
      await writeFile(
        join(staging.root, "recovery.md"),
        checkpoint.report,
        "utf8",
      );
      await writeFile(
        join(staging.root, "recovery-manifest.json"),
        JSON.stringify(checkpoint.manifest),
        "utf8",
      );
      await writeImmutableJson(join(experimentRoot, "recovery.json"), recovery);
      await store.append({
        type: "recovery.checkpoint_restored",
        runId: input.runId,
        operationId: "recovery-checkpoint-restored",
        payload: {
          checkpointId: staging.checkpointId,
          checkpointDigest: staging.checkpointFingerprint.digest,
          changedPathCount: checkpoint.changedPaths.length,
        },
      });
      await store.append({
        type: "recovery.completed",
        runId: input.runId,
        operationId: "recovery-completed",
        payload: { status: "completed", source: "host_checkpoint" },
      });
      failureStage = "provider_validation_failed";
      validateRecoveryEvidence(
        checkpoint.evidence.map((item) => item.ref),
        checkpoint.result,
      );
      const providerPreview = await provider.validateRecovery(
        activeStaging,
        checkpoint.result,
        checkpoint.evidence,
      );
      recoveredPaths = [...providerPreview.changedPaths];
      verification = "verified";
      if (providerPreview.reportText) {
        await store.commitArtifact({
          artifactId: "recovery-md",
          kind: "recovery_report",
          mediaType: "text/markdown",
          bytes: Buffer.from(providerPreview.reportText, "utf8"),
        });
      }
      await persistRecoveryEvaluation(store, [
        recoveryEvaluationCase({
          caseId: input.caseId,
          staging,
          candidateCreated: false,
          recoveredPaths,
          forensicsCompleted,
          evidenceSourcesAttempted,
          evidenceSourcesAvailable,
          hypothesisCount,
          candidateCount,
          verifierRejectionReasons,
          providerFailureRetryable,
          pathBoundaryRejected,
          verification,
          modelCalls: 0,
          startedAt: input.now,
          timings: recoveryTimingSummary(recoveryOrchestrator.attempts),
        }),
      ],
      undefined,
      store.events(input.runId),
    );
      return {
        baseline: providerPreview.baseline,
        providerPreview,
        staging,
        ...(readinessResult ? { taskReadiness: readinessResult } : {}),
        recovery,
        experimentRoot,
        experimentId: input.experimentId,
        provider,
        accept: () => provider.acceptRecovery(providerPreview),
      };
    }
    moveRecoveryState("forensics_running");
    await recordRecoveryAttempt(recoveryAttemptRecord({ attemptId: "recovery-attempt-forensics-started", phase: "forensics", operation: "resolve_facts", attemptNumber: 1, result: "started", durationMs: 0, recordedAt: input.now }));
    await store.append({
      type: "recovery.forensics_started",
      runId: input.runId,
      operationId: "recovery-forensics-started",
      payload: {
        mode: attemptMode,
        sources: ["workspace", "git", "transcript", "historical_events"],
      },
    });
    const forensicsStartedAt = Date.now();
    const facts = await resolvedRecoveryFacts(staging.root, input.taskCase);
    await recordRecoveryAttempt(recoveryAttemptRecord({ attemptId: "recovery-attempt-forensics-completed", phase: "forensics", operation: "resolve_facts", attemptNumber: 1, result: "succeeded", durationMs: Math.max(0, Date.now() - forensicsStartedAt), recordedAt: new Date().toISOString() }));
    moveRecoveryState("hypotheses_ready");
    preflightOperation = "recovery_build_investigation";
    const seed = initialRecoveryInvestigation(facts, input.now);
    evidenceSourcesAttempted = 4;
    evidenceSourcesAvailable = [
      true,
      facts.git !== undefined,
      facts.catalog.some((entry) => entry.source === "transcript"),
      facts.catalog.some((entry) => entry.source === "historical_events") ||
        facts.verifiedEvidence.length > 0,
    ].filter(Boolean).length;
    hypothesisCount = seed.plan.hypotheses.length;
    preflightOperation = "recovery_create_candidates";
    moveRecoveryState("candidate_running");
    const candidateCreationStartedAt = Date.now();
    const candidateRecipeDigests = new Set<string>();
    const candidateStagings = await materializeRecoveryCandidates(seed.plan.candidates.map((candidate) => ({
      candidateId: `candidate-${candidate.hypothesisId}`,
      hypothesisId: candidate.hypothesisId,
      operations: candidate.operations,
      baseDigest: activeStaging.checkpointFingerprint?.digest ?? activeStaging.sourceFingerprint.digest,
    })), {
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
    });
    const candidateCreationDurationMs = Math.max(0, Date.now() - candidateCreationStartedAt);
    candidateCreated = true;
    candidateCount = candidateStagings.length;
    if (candidateStagings.length > 0)
      await recordRecoveryAttempt(recoveryAttemptRecord({
        attemptId: "recovery-attempt-candidates-materialization",
        phase: "candidate",
        operation: "create_candidate",
        attemptNumber: 1,
        result: "succeeded",
        durationMs: candidateCreationDurationMs,
        recordedAt: new Date().toISOString(),
      }));
    let knownFactRefs: string[] = [];
    let remainingSearchBudget = input.maxToolCalls;
    for (const hypothesis of seed.plan.hypotheses) {
      const decision = decideRecoverySearch({
        newEvidenceRefs: hypothesis.supportingFactRefs,
        knownEvidenceRefs: knownFactRefs,
        estimatedCost: 1,
        risk: hypothesis.confidence === "high" ? 0.1 : hypothesis.confidence === "medium" ? 0.3 : 0.5,
        remainingBudget: remainingSearchBudget,
      });
      remainingSearchBudget = Math.max(0, remainingSearchBudget - 1);
      knownFactRefs = [...new Set([...knownFactRefs, ...hypothesis.supportingFactRefs])];
      await store.append({
        type: "recovery.search_decision",
        runId: input.runId,
        operationId: `recovery-search-decision-${hypothesis.hypothesisId}`,
        payload: { hypothesisId: hypothesis.hypothesisId, ...decision },
      });
    }
    preflightOperation = "recovery_persist_investigation";
    const investigation: RecoveryInvestigation = {
      ...seed,
      candidates: candidateStagings.map((candidate) => ({
        candidateId: candidate.candidateId,
        hypothesisId: candidate.hypothesisId,
        status: "created",
        factRefs:
          seed.plan.hypotheses.find(
            (hypothesis) => hypothesis.hypothesisId === candidate.hypothesisId,
          )?.supportingFactRefs ?? [],
        beforeDigest: candidate.beforeFingerprint.digest,
        createdAt: candidate.createdAt,
      })),
    };
    if (!Value.Check(RecoveryInvestigationSchema, investigation))
      throw new Error(
        "Recovery investigation did not satisfy its persistence schema.",
      );
    for (const candidate of candidateStagings)
      await store.append({
        type: "recovery.candidate_created",
        runId: input.runId,
        operationId: `recovery-candidate-created-${candidate.candidateId}`,
        payload: {
          caseId: input.caseId,
          candidateId: candidate.candidateId,
          hypothesisId: candidate.hypothesisId,
        },
      });
    const executionCandidate = candidateStagings[0];
    if (!executionCandidate)
      throw new Error("Recovery investigation created no candidate.");
    await store.append({
      type: "recovery.candidate_selected",
      runId: input.runId,
      operationId: `recovery-candidate-selected-${executionCandidate.candidateId}`,
      payload: {
        candidateId: executionCandidate.candidateId,
        hypothesisId: executionCandidate.hypothesisId,
        selection: "highest_evidence_first",
      },
    });
    await store.commitArtifact({
      artifactId: "recovery-investigation",
      kind: "recovery_investigation",
      mediaType: "application/json",
      bytes: Buffer.from(JSON.stringify(investigation), "utf8"),
      operationId: "recovery-investigation-created",
    });
    await store.append({
      type: "recovery.investigation_created",
      runId: input.runId,
      operationId: "recovery-investigation-event",
      payload: {
        factCount: investigation.facts.length,
        hypothesisCount: investigation.plan.hypotheses.length,
        artifactId: "recovery-investigation",
      },
    });
    preflightOperation = "recovery_forensics_complete";
    await store.append({
      type: "recovery.forensics_completed",
      runId: input.runId,
      operationId: "recovery-forensics-completed",
      payload: forensicsFact(facts),
    });
    forensicsCompleted = true;
    failureStage = "agent_tool_failed";
    preflightOperation = "recovery_agent_invoke";
    let context: import("../agents/recovery-agent.js").RecoveryContext = {
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
      readiness: deriveRecoveryReadinessContext(
        input.taskCase,
        historicalCwdOf(input.taskCase),
      ),
    };
    const tools = [
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
        ...(activeStaging.temporaryRoot ? { homeRoot: activeStaging.temporaryRoot } : {}),
        onControlledWrite: async (entry) => {
          const persistedEntry = await persistRecoveryControlledWriteBlob(
            store,
            executionCandidate.root,
            entry,
            {
              ...(activeStaging.checkpointId ? { checkpointId: activeStaging.checkpointId } : {}),
              baseDigest: executionCandidate.beforeFingerprint.digest,
            },
          );
          controlledWriteEntries.push(persistedEntry);
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
          try {
            validateSubmittedRecoveryPlan(plan, investigation);
          } catch (error) {
            if (error instanceof RecoveryPlanPathBoundaryError)
              pathBoundaryRejected = true;
            throw error;
          }
          const knownHypothesisIds = new Set(investigation.plan.hypotheses.map((hypothesis) => hypothesis.hypothesisId));
          const expandedHypotheses = plan.hypotheses.filter((hypothesis) => !knownHypothesisIds.has(hypothesis.hypothesisId));
          const expandedCandidates = plan.candidates.filter((candidate) =>
            expandedHypotheses.some((hypothesis) => hypothesis.hypothesisId === candidate.hypothesisId) &&
            candidate.operations.length > 0,
          );
          for (const proposal of expandedCandidates) {
            const decision = decideRecoverySearch({
              newEvidenceRefs: plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId)?.supportingFactRefs ?? [],
              knownEvidenceRefs: investigation.plan.factsUsed,
              estimatedCost: 1,
              risk: 0.3,
              remainingBudget: remainingSearchBudget,
            });
            await store.append({ type: "recovery.search_decision", runId: input.runId, operationId: `recovery-search-decision-${proposal.hypothesisId}-${sha256(JSON.stringify(proposal.operations)).slice(0, 12)}`, payload: { hypothesisId: proposal.hypothesisId, mechanism: proposal.operations.map((operation) => operation.operation).join(","), ...decision } });
            if (decision.action !== "investigate" && decision.reason !== "no_new_evidence") continue;
            const candidateMaterializationStartedAt = Date.now();
            const createdCandidates = await materializeRecoveryCandidates([{
              candidateId: `candidate-${proposal.hypothesisId}`,
              hypothesisId: proposal.hypothesisId,
              operations: proposal.operations,
              baseDigest: activeStaging.checkpointFingerprint?.digest ?? activeStaging.sourceFingerprint.digest,
            }], {
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
            });
            const candidate = createdCandidates[0];
            if (!candidate) continue;
            candidateStagings.push(candidate);
            investigation.plan.hypotheses.push(...expandedHypotheses.filter((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId));
            investigation.plan.candidates.push(proposal);
            investigation.candidates.push({ candidateId: candidate.candidateId, hypothesisId: candidate.hypothesisId, status: "created", factRefs: plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === proposal.hypothesisId)?.supportingFactRefs ?? [], beforeDigest: candidate.beforeFingerprint.digest, createdAt: candidate.createdAt });
            candidateCount = (candidateCount ?? 0) + 1;
            remainingSearchBudget = Math.max(0, remainingSearchBudget - 1);
            await recordRecoveryAttempt(recoveryAttemptRecord({ attemptId: `recovery-attempt-dynamic-candidate-${candidate.candidateId}`, phase: "candidate", operation: "create_candidate", candidateId: candidate.candidateId, attemptNumber: candidateCount, result: "succeeded", durationMs: Math.max(0, Date.now() - candidateMaterializationStartedAt), recordedAt: new Date().toISOString() }));
            await store.append({ type: "recovery.candidate_created", runId: input.runId, operationId: `recovery-candidate-created-${candidate.candidateId}`, payload: { caseId: input.caseId, candidateId: candidate.candidateId, hypothesisId: candidate.hypothesisId, origin: "agent_submitted_plan" } });
          }
          await store.append({
            type: "recovery.plan_submitted",
            runId: input.runId,
            operationId: `recovery-plan-submitted-${sha256(JSON.stringify(plan)).slice(0, 16)}`,
            payload: { plan, ...(expandedCandidates.length ? { expandedCandidateCount: expandedCandidates.length } : {}) },
          });
        },
      }),
    ];
    // Persist only a structural audit envelope. The full context is sent to the model
    // in memory, but task text, transcript content, and workspace paths never enter artifacts.
    const modelInputBase = recoveryModelInputAudit(context, tools.map((tool) => tool.name));
    let retryModel = true;
    while (retryModel) {
      modelAttempts += 1;
      // Each retry is a distinct immutable input version, so the request chain remains replayable.
      const modelInput = { ...modelInputBase, attempt: modelAttempts };
      const modelInputBytes = Buffer.from(JSON.stringify(modelInput), "utf8");
      const modelInputArtifact = await store.commitArtifact({
        artifactId: `recovery-model-input-${modelAttempts}-${sha256(modelInputBytes).slice(0, 16)}`,
        runId: input.runId,
        kind: "recovery_model_input",
        mediaType: "application/json",
        bytes: modelInputBytes,
        operationId: `recovery-model-input-${modelAttempts}-created`,
      });
      await store.append({
        type: "recovery.model_input",
        runId: input.runId,
        operationId: `recovery-model-input-${modelAttempts}`,
        payload: {
          caseId: input.caseId,
          attempt: modelAttempts,
          artifactId: modelInputArtifact.artifactId,
          contentHash: modelInputArtifact.contentHash,
          byteLength: modelInputArtifact.byteLength,
        },
      });
      await recordRecoveryAttempt(recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${modelAttempts}-started`,
        phase: "candidate",
        operation: "invoke_model",
        candidateId: executionCandidate.candidateId,
        attemptNumber: modelAttempts,
        result: "started",
        durationMs: 0,
        recordedAt: input.now,
      }));
      const modelStartedAt = Date.now();
      recovery = await input.recovery.recover(context, tools, audit);
      await recordRecoveryAttempt(recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${modelAttempts}-completed`,
        phase: "candidate",
        operation: "invoke_model",
        candidateId: executionCandidate.candidateId,
        attemptNumber: modelAttempts,
        result: recovery.status === "completed" ? "succeeded" : "failed",
        ...(recovery.status === "failed" ? { failureCode: recovery.failure.code } : {}),
        durationMs: Math.max(0, Date.now() - modelStartedAt),
        recordedAt: new Date().toISOString(),
      }));
      const retryFailure = retryableRecoveryFailure(recovery);
      retryModel =
        retryFailure !== undefined && modelAttempts < maxModelAttempts;
      if (!retryModel) continue;
      await store.append({
        type: "recovery.model_retry",
        runId: input.runId,
        operationId: `recovery-model-retry-${modelAttempts + 1}`,
        payload: { caseId: input.caseId, attempt: modelAttempts + 1, previousFailure: retryFailure },
      });
    }
    if (!recovery)
      throw new Error("Recovery model did not return an invocation result.");
    await writeImmutableJson(join(experimentRoot, "recovery.json"), recovery);
    await store.append({
      type: "recovery.completed",
      runId: input.runId,
      operationId: "recovery-completed",
      payload: invocationFact(recovery),
    });
    if (recovery.status !== "completed") {
      failureStage =
        recovery.status === "cancelled"
          ? "cancelled"
          : recovery.status === "failed" &&
              recovery.failure.code === "agent_timeout"
            ? "agent_timeout"
            : recovery.status === "failed" &&
                recovery.failure.code === "invalid_output"
              ? "agent_invalid_output"
              : recovery.status === "failed" && recovery.failure.kind === "tool"
                ? "agent_tool_failed"
                : "agent_model_failed";
      throw new Error(`Recovery did not complete: ${recovery.status}.`);
    }
    if (!context.readiness) throw new Error("Recovery readiness context was not prepared.");
    const readinessContext = context.readiness;
    // A historical workspace is itself an intake signal: without task paths the
    // readiness check must record that continuation criteria are unavailable.
    if (readinessContext.relevantPaths.length > 0 || readinessContext.observedWorkspaces.length > 0) {
      failureStage = "provider_validation_failed";
      readinessResult = await checkRecoveryReadiness(executionCandidate.root, readinessContext, input.executeReadinessCommands === true ? { executeCommands: true } : {});
    }
    let readinessSignature: string | undefined;
    let noProgressTurns = 0;
    const recordReadiness = async (result: RecoveryReadinessResult, attempt: number): Promise<void> => {
      const fingerprint = await provider.fingerprintRecoveryCandidate(executionCandidate);
      const signature = sha256(JSON.stringify({ status: result.status, missingPaths: result.missingPaths, digest: fingerprint.digest }));
      if (signature === readinessSignature && result.status !== "ready") noProgressTurns += 1;
      else noProgressTurns = 0;
      readinessSignature = signature;
      await store.append({ type: "recovery.readiness_checked", runId: input.runId, operationId: `recovery-readiness-${attempt}`, payload: { status: result.status, checkedPaths: result.checkedPaths, missingPaths: result.missingPaths, commandChecks: result.commandChecks, stagingDigest: fingerprint.digest, noProgressTurns } });
      if (noProgressTurns >= 2) {
        await store.append({ type: "recovery.no_progress", runId: input.runId, operationId: `recovery-no-progress-${attempt}`, payload: { attempt, stagingDigest: fingerprint.digest, feedback: result.feedback } });
        throw new RecoveryValidationError("provider_validation_failed", `Recovery made no observable progress: ${result.feedback}`);
      }
    };
    if (readinessResult) await recordReadiness(readinessResult, modelAttempts);
    if (readinessResult?.status === "blocked") {
      taskOutcome = "blocked_by_safety";
      throw new RecoveryValidationError("provider_validation_failed", readinessResult.feedback);
    }
    while (readinessResult && readinessResult.status !== "ready" && modelAttempts < maxModelAttempts) {
      context = { ...context, readinessFeedback: { status: readinessResult.status, feedback: readinessResult.feedback, missingPaths: readinessResult.missingPaths } };
      const nextAttempt = modelAttempts + 1;
      const feedbackInput = recoveryModelInputAudit(context, tools.map((tool) => tool.name));
      const feedbackBytes = Buffer.from(JSON.stringify({ ...feedbackInput, attempt: nextAttempt, feedbackTurn: true }), "utf8");
      const feedbackArtifact = await store.commitArtifact({ artifactId: `recovery-model-input-feedback-${nextAttempt}-${sha256(feedbackBytes).slice(0, 16)}`, runId: input.runId, kind: "recovery_model_input", mediaType: "application/json", bytes: feedbackBytes, operationId: `recovery-model-input-feedback-${nextAttempt}-created` });
      await store.append({ type: "recovery.model_input", runId: input.runId, operationId: `recovery-model-input-feedback-${nextAttempt}`, payload: { caseId: input.caseId, attempt: nextAttempt, artifactId: feedbackArtifact.artifactId, contentHash: feedbackArtifact.contentHash, byteLength: feedbackArtifact.byteLength, feedbackTurn: true } });
      await store.append({ type: "recovery.readiness_feedback", runId: input.runId, operationId: `recovery-readiness-feedback-${nextAttempt}`, payload: { artifactId: feedbackArtifact.artifactId, previousStatus: readinessResult.status, missingPaths: readinessResult.missingPaths } });
      modelAttempts = nextAttempt;
      const feedbackStartedAt = Date.now();
      recovery = await input.recovery.recover(context, tools, audit);
      await recordRecoveryAttempt(recoveryAttemptRecord({
        attemptId: `recovery-attempt-model-${modelAttempts}-completed`,
        phase: "candidate",
        operation: "invoke_model",
        candidateId: executionCandidate.candidateId,
        attemptNumber: modelAttempts,
        result: recovery.status === "completed" ? "succeeded" : "failed",
        ...(recovery.status === "failed" ? { failureCode: recovery.failure.code } : {}),
        durationMs: Math.max(0, Date.now() - feedbackStartedAt),
        recordedAt: new Date().toISOString(),
      }));
      if (recovery.status !== "completed") throw new Error(`Recovery feedback turn did not complete: ${recovery.status}.`);
      readinessResult = await checkRecoveryReadiness(executionCandidate.root, readinessContext, input.executeReadinessCommands === true ? { executeCommands: true } : {});
      await recordReadiness(readinessResult, modelAttempts);
    }
    if (readinessResult && readinessResult.status !== "ready") throw new RecoveryValidationError("provider_validation_failed", `Recovery did not reach task readiness: ${readinessResult.feedback}`);
    failureStage = "provider_validation_failed";
    const replayedControlledDelta = await replayControlledRecoveryDeltaBytes(
      controlledWriteEntries,
      (artifactId) =>
        store.readArtifact({
          artifactId,
          experimentId: input.experimentId,
        }),
    );
    await store.append({
      type: "recovery.controlled_write_replayed",
      runId: input.runId,
      operationId: "recovery-controlled-write-replayed",
      payload: {
        entryCount: controlledWriteEntries.length,
        fileCount: replayedControlledDelta.size,
      },
    });
    const afterFingerprint =
      await provider.fingerprintRecoveryCandidate(executionCandidate);
    const selectedCandidate = investigation.candidates.find(
      (candidate) => candidate.candidateId === executionCandidate.candidateId,
    );
    if (!selectedCandidate)
      throw new Error(
        "Selected Recovery candidate is missing from the investigation.",
      );
    const diffArtifactId = `recovery-candidate-diff-${sha256(executionCandidate.candidateId).slice(0, 16)}`;
    const candidateDiff = recoveryCandidateDiff(
      executionCandidate,
      selectedCandidate.factRefs,
      executionCandidate.beforeFingerprint,
      afterFingerprint,
      controlledWriteEntries,
    );
    const verdict = verifyRecoveryCandidate(
      selectedCandidate,
      investigation.facts,
      candidateDiff.taskPathOutcomes.map((outcome) => outcome.path),
      recovery.value.status,
    );
    recoveredPaths = candidateDiff.taskPathOutcomes.map((outcome) => outcome.path);
    verification = verdictToEvaluationStatus(
      verdict.status,
      recovery.value.status,
    );
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
      verifierRejectionReasons = [...verdict.reasonCodes];
      throw new RecoveryValidationError(
        "provider_validation_failed",
        `Recovery candidate was rejected: ${verdict.reasonCodes.join(", ")}.`,
      );
    }
    const candidateReviews: { candidateId: string; artifactId: string }[] = [
      { candidateId: finalizedCandidate.candidateId, artifactId: reviewArtifactId },
    ];
    const graphCandidates = investigation.candidates.map((candidate) =>
      candidate.candidateId === finalizedCandidate.candidateId
        ? finalizedCandidate
        : {
            ...candidate,
            status: "pending_user_review" as const,
          },
    );
    // Keep unexecuted branches alive: weak evidence is a reason to request review,
    // not a reason to destroy the other hypotheses before an operator can compare them.
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
    const candidateGraph: RecoveryCandidateGraph = {
      schemaVersion: 1,
      investigation: { ...investigation, candidates: graphCandidates },
      reviews: candidateReviews,
    };
    if (!Value.Check(RecoveryCandidateGraphSchema, candidateGraph))
      throw new Error("Recovery candidate graph failed schema validation.");
    let candidateGraphArtifactId = "recovery-candidate-graph";
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
    moveRecoveryState(verdict.status === "verified" ? "candidate_verified" : "candidate_pending_review");
    await provider.selectRecoveryCandidate(activeStaging, executionCandidate);
    validateRecoveryEvidence(facts.evidenceRefs, recovery.value);
    const providerVerificationStartedAt = Date.now();
    let activeProviderPreview = await provider.validateRecovery(
      activeStaging,
      recovery.value,
      facts.verifiedEvidence,
    );
    await recordRecoveryAttempt(recoveryAttemptRecord({ attemptId: `recovery-attempt-provider-verification-${executionCandidate.candidateId}`, phase: "verification", operation: "validate_candidate", candidateId: executionCandidate.candidateId, attemptNumber: 1, result: "succeeded", durationMs: Math.max(0, Date.now() - providerVerificationStartedAt), recordedAt: new Date().toISOString() }));
    if (verdict.status === "verified" || readinessResult?.status === "ready") moveRecoveryState("selected_checkpoint");
    if (readinessResult?.status === "ready") {
      taskOutcome = "ready_for_task";
      verification = "verified";
      activeProviderPreview = {
        ...activeProviderPreview,
        baseline: {
          ...activeProviderPreview.baseline,
          ...(activeProviderPreview.baseline.recovery
            ? { recovery: { ...activeProviderPreview.baseline.recovery, taskOutcome } }
            : {}),
        },
      };
      moveRecoveryState("ready_for_task");
      await store.append({
        type: "recovery.ready_for_task",
        runId: input.runId,
        operationId: "recovery-ready-for-task",
        payload: {
          caseId: input.caseId,
          candidateId: executionCandidate.candidateId,
          checkedPaths: readinessResult.checkedPaths,
        },
      });
      automaticallyAcceptedBaseline = await provider.acceptRecovery(activeProviderPreview);
      moveRecoveryState("accepted");
      await store.append({
        type: "recovery.lifecycle_completed",
        runId: input.runId,
        operationId: "recovery-lifecycle-accepted-automatically",
        payload: { state: lifecycleState(), automatic: true },
      });
    }
    const attemptsArtifact = Buffer.from(JSON.stringify({ schemaVersion: 1, state: lifecycleState(), attempts: recoveryOrchestrator.attempts }), "utf8");
    await store.commitArtifact({ artifactId: "recovery-attempts", kind: "recovery_attempts", mediaType: "application/json", bytes: attemptsArtifact, operationId: "recovery-attempts-created" });
    if (activeProviderPreview.reportText) {
      await store.commitArtifact({
        artifactId: "recovery-md",
        kind: "recovery_report",
        mediaType: "text/markdown",
        bytes: Buffer.from(activeProviderPreview.reportText, "utf8"),
      });
    }
    if (writerAcquired)
      await persistRecoveryEvaluation(store, [
        recoveryEvaluationCase({
          caseId: input.caseId,
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
          startedAt: input.now,
          timings: recoveryTimingSummary(recoveryOrchestrator.attempts),
        }),
      ],
      undefined,
      store.events(input.runId),
    );
    let selectedCandidateId = executionCandidate.candidateId;
    let validatedCandidateId = executionCandidate.candidateId;
    const selectCandidate = async (candidateId: string): Promise<void> => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(candidateId))
        throw new Error("Recovery candidate selection is invalid.");
      const graphCandidate = graphCandidates.find((candidate) => candidate.candidateId === candidateId);
      const candidate = candidateStagings.find((item) => item.candidateId === candidateId);
      if (!graphCandidate || !candidate)
        throw new Error(`Recovery candidate is not in the review graph: ${candidateId}.`);
      if (graphCandidate.status !== "pending_user_review")
        throw new Error("Only a pending Recovery candidate can be selected for review.");
      // Selection is recorded without publishing or mutating staging. An unexecuted
      // branch must be re-run through the Agent and Provider verifier first.
      // The attempt returns after its main writer is closed. Reopen a short-lived
      // Host-owned writer so post-return selection remains durable and observable.
      const selectionStore = await ExperimentStore.open(experimentRoot, input.experimentId);
      const unsubscribeSelection = input.onEvent
        ? selectionStore.subscribe(input.onEvent)
        : undefined;
      try {
        await selectionStore.acquireWriter();
        await selectionStore.append({
          type: "recovery.candidate_selected_by_user",
          runId: input.runId,
          operationId: `recovery-candidate-selected-by-user-${candidateId}`,
          payload: {
            candidateId,
            hypothesisId: candidate.hypothesisId,
            graphArtifactId: candidateGraphArtifactId,
            requiresReexecution: candidateId !== executionCandidate.candidateId,
          },
        });
      } finally {
        unsubscribeSelection?.();
        await selectionStore.close();
      }
      selectedCandidateId = candidateId;
    };
    const reexecuteCandidate = async (candidateId = selectedCandidateId): Promise<void> => {
      const graphCandidate = graphCandidates.find((candidate) => candidate.candidateId === candidateId);
      const candidate = candidateStagings.find((item) => item.candidateId === candidateId);
      if (!graphCandidate || !candidate)
        throw new Error(`Recovery candidate is not in the review graph: ${candidateId}.`);
      if (graphCandidate.status !== "pending_user_review")
        throw new Error("Only a pending Recovery candidate can be re-executed.");
      if (candidateId !== selectedCandidateId)
        throw new Error("Select the Recovery candidate before re-executing it.");
      if (candidateId === executionCandidate.candidateId)
        throw new Error("The initially executed Recovery candidate is already validated.");

      const executionStore = await ExperimentStore.open(experimentRoot, input.experimentId);
      const unsubscribeExecution = input.onEvent
        ? executionStore.subscribe(input.onEvent)
        : undefined;
      const executionWrites: RecoveryControlledWrite[] = [];
      try {
        await executionStore.acquireWriter();
        const alternateContext = {
          ...context,
          executionCandidate: {
            candidateId: candidate.candidateId,
            hypothesisId: candidate.hypothesisId,
          },
        };
        const alternateAudit = {
          append: async (event: import("../infrastructure/pi-agent-host.js").AgentAuditEvent): Promise<void> => {
            await executionStore.append({
              type: event.type,
              runId: input.runId,
              payload: { role: event.role, sessionId: event.sessionId, candidateId, ...event.payload },
            });
          },
        };
        const alternateTools = [
          ...recoveryObservationTools(input.taskCase, {
            onOperation: async (operation) => {
              await executionStore.append({
                type: "recovery.frozen_observation_read",
                runId: input.runId,
                operationId: `recovery-${candidateId}-frozen-observation-${operation.operation}-${operation.attempts}-${sha256(JSON.stringify(operation)).slice(0, 12)}`,
                payload: { candidateId, ...operation },
              });
            },
          }),
          ...recoveryTools(candidate.root, input.maxToolCalls, {
            ...(input.allowShell ? { allowShell: true } : {}),
            ...(activeStaging.temporaryRoot ? { homeRoot: activeStaging.temporaryRoot } : {}),
            onControlledWrite: async (entry) => {
              const persistedEntry = await persistRecoveryControlledWriteBlob(
                executionStore,
                candidate.root,
                entry,
                {
                  ...(activeStaging.checkpointId ? { checkpointId: activeStaging.checkpointId } : {}),
                  baseDigest: candidate.beforeFingerprint.digest,
                },
              );
              executionWrites.push(persistedEntry);
              await executionStore.append({
                type: "recovery.controlled_write",
                runId: input.runId,
                operationId: `recovery-${candidateId}-controlled-write-${persistedEntry.tool}-${persistedEntry.phase}-${sha256(JSON.stringify(persistedEntry)).slice(0, 12)}`,
                payload: { candidateId, ...persistedEntry },
              });
            },
            onOperation: async (operation) => {
              await executionStore.append({
                type: "recovery.workspace_read",
                runId: input.runId,
                operationId: `recovery-${candidateId}-workspace-read-${operation.operation}-${operation.attempts}-${sha256(JSON.stringify(operation)).slice(0, 12)}`,
                payload: { candidateId, ...operation },
              });
            },
            onPlan: async (plan) => {
              validateSubmittedRecoveryPlan(plan, investigation);
              await executionStore.append({
                type: "recovery.plan_submitted",
                runId: input.runId,
                operationId: `recovery-${candidateId}-plan-submitted-${sha256(JSON.stringify(plan)).slice(0, 12)}`,
                payload: { candidateId, plan },
              });
            },
          }),
        ];
        const modelInput = {
          ...recoveryModelInputAudit(alternateContext, alternateTools.map((tool) => tool.name)),
          attempt: 1,
          candidateId,
        };
        const modelInputBytes = Buffer.from(JSON.stringify(modelInput), "utf8");
        const inputArtifact = await executionStore.commitArtifact({
          artifactId: `recovery-model-input-${candidateId}-${sha256(modelInputBytes).slice(0, 16)}`,
          runId: input.runId,
          kind: "recovery_model_input",
          mediaType: "application/json",
          bytes: modelInputBytes,
          operationId: `recovery-${candidateId}-model-input-created`,
        });
        await executionStore.append({
          type: "recovery.model_input",
          runId: input.runId,
          operationId: `recovery-${candidateId}-model-input`,
          payload: { caseId: input.caseId, candidateId, attempt: 1, artifactId: inputArtifact.artifactId, contentHash: inputArtifact.contentHash, byteLength: inputArtifact.byteLength },
        });
        const alternateRecovery = await input.recovery.recover(
          alternateContext,
          alternateTools,
          alternateAudit,
        );
        await writeImmutableJson(
          join(experimentRoot, `recovery-${candidateId}.json`),
          alternateRecovery,
        );
        await executionStore.append({
          type: "recovery.candidate_reexecution_completed",
          runId: input.runId,
          operationId: `recovery-${candidateId}-reexecution-completed`,
          payload: { candidateId, status: alternateRecovery.status },
        });
        if (alternateRecovery.status !== "completed")
          throw new Error(`Recovery candidate re-execution did not complete: ${alternateRecovery.status}.`);
        validateRecoveryEvidence(facts.evidenceRefs, alternateRecovery.value);
        await replayControlledRecoveryDeltaBytes(
          executionWrites,
          (artifactId) => executionStore.readArtifact({ artifactId, experimentId: input.experimentId }),
        );
        await provider.selectRecoveryCandidate(activeStaging, candidate);
        const alternatePreview = await provider.validateRecovery(
          activeStaging,
          alternateRecovery.value,
          facts.verifiedEvidence,
        );
        const afterFingerprint = await provider.fingerprintRecoveryStaging(activeStaging);
        const candidateDiff = recoveryCandidateDiff(
          candidate,
          graphCandidate.factRefs,
          candidate.beforeFingerprint,
          afterFingerprint,
          executionWrites,
        );
        const verdict = verifyRecoveryCandidate(
          graphCandidate,
          investigation.facts,
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
          investigation.facts,
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
          investigation: { ...investigation, candidates: graphCandidates },
          reviews: candidateReviews,
        };
        candidateGraphArtifactId = `recovery-candidate-graph-${candidateId}`;
        await executionStore.commitArtifact({
          artifactId: candidateGraphArtifactId,
          kind: "recovery_candidate_graph",
          mediaType: "application/json",
          bytes: Buffer.from(JSON.stringify(updatedGraph), "utf8"),
          operationId: `recovery-${candidateId}-graph-created`,
        });
        await executionStore.append({
          type: "recovery.candidate_reexecuted_and_validated",
          runId: input.runId,
          operationId: `recovery-${candidateId}-validated`,
          payload: { candidateId, status: verdict.status, diffArtifactId, reviewArtifactId, graphArtifactId: candidateGraphArtifactId },
        });
        activeProviderPreview = alternatePreview;
        validatedCandidateId = candidateId;
      } finally {
        unsubscribeExecution?.();
        await executionStore.close();
      }
    };
    const recordExternalEffect = async (effect: Omit<RecoveryExternalEffect, "schemaVersion" | "recordedAt">): Promise<string> => {
      const payload: RecoveryExternalEffect = { ...effect, schemaVersion: 1, recordedAt: input.now };
      if (!Value.Check(RecoveryExternalEffectSchema, payload)) throw new Error("External effect failed schema validation.");
      const bytes = Buffer.from(JSON.stringify(payload), "utf8");
      const artifactId = `recovery-external-effect-${effect.effectId}-${sha256(bytes).slice(0, 16)}`;
      const effectStore = await ExperimentStore.open(experimentRoot, input.experimentId);
      try {
        await effectStore.acquireWriter();
        await effectStore.commitArtifact({ artifactId, kind: "recovery_external_effect", mediaType: "application/json", bytes, operationId: `${artifactId}-created` });
        await effectStore.append({ type: "recovery.external_effect_recorded", runId: input.runId, operationId: `${artifactId}-event`, payload: { artifactId, effectId: effect.effectId, observability: effect.observability, kind: effect.kind } });
      } finally { await effectStore.close(); }
      return artifactId;
    };
    const requestCompensation = async (request: Omit<RecoveryCompensationRequest, "schemaVersion" | "requestedAt">): Promise<RecoveryCompensationResult> => {
      const payload: RecoveryCompensationRequest = { ...request, schemaVersion: 1, requestedAt: input.now };
      if (!Value.Check(RecoveryCompensationRequestSchema, payload)) throw new Error("Compensation request failed schema validation.");
      const result: RecoveryCompensationResult = { schemaVersion: 1, requestId: request.requestId, effectId: request.effectId, status: "requires_review", summary: "External effect is not observed or compensatable by this Runtime.", evidenceRefs: request.evidenceRefs, completedAt: input.now };
      if (!Value.Check(RecoveryCompensationResultSchema, result)) throw new Error("Compensation result failed schema validation.");
      const requestArtifactId = `recovery-compensation-request-${request.requestId}`;
      const resultArtifactId = `recovery-compensation-result-${request.requestId}`;
      const compensationStore = await ExperimentStore.open(experimentRoot, input.experimentId);
      try {
        await compensationStore.acquireWriter();
        await compensationStore.commitArtifact({ artifactId: requestArtifactId, kind: "recovery_compensation_request", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(payload), "utf8"), operationId: `${requestArtifactId}-created` });
        await compensationStore.commitArtifact({ artifactId: resultArtifactId, kind: "recovery_compensation_result", mediaType: "application/json", bytes: Buffer.from(JSON.stringify(result), "utf8"), operationId: `${resultArtifactId}-created` });
        await compensationStore.append({ type: "recovery.compensation_requested", runId: input.runId, operationId: `${requestArtifactId}-event`, payload: { requestArtifactId, resultArtifactId, requestId: request.requestId, effectId: request.effectId, status: result.status } });
      } finally { await compensationStore.close(); }
      return result;
    };
    const recordReviewFeedback = async (feedback: {
      candidateId: string;
      decision: RecoveryReviewFeedback["decision"];
      evidenceRefs?: readonly string[];
    }): Promise<string> => {
      const candidate = graphCandidates.find((item) => item.candidateId === feedback.candidateId);
      if (!candidate) throw new Error(`Recovery candidate is not in the review graph: ${feedback.candidateId}.`);
      const stagingDigest = await provider.fingerprintRecoveryStaging(activeStaging);
      const evidenceRefs = [...new Set(feedback.evidenceRefs ?? [])];
      const feedbackCheckpoint = feedback.decision === "accept"
        ? await provider.captureRecoveryCheckpointFromStaging(activeStaging)
        : undefined;
      const payload: RecoveryReviewFeedback = {
        schemaVersion: 1,
        candidateId: feedback.candidateId,
        decision: feedback.decision,
        evidenceRefs,
        stagingDigest: stagingDigest.digest,
        ...(feedbackCheckpoint ? { checkpointId: feedbackCheckpoint.checkpointId } : {}),
        recordedAt: input.now,
      };
      if (!Value.Check(RecoveryReviewFeedbackSchema, payload))
        throw new Error("Recovery review feedback failed schema validation.");
      const feedbackBytes = Buffer.from(JSON.stringify(payload), "utf8");
      const artifactId = `recovery-review-feedback-${feedback.candidateId}-${sha256(feedbackBytes).slice(0, 16)}`;
      const feedbackStore = await ExperimentStore.open(experimentRoot, input.experimentId);
      const unsubscribeFeedback = input.onEvent ? feedbackStore.subscribe(input.onEvent) : undefined;
      try {
        await feedbackStore.acquireWriter();
        await feedbackStore.commitArtifact({ artifactId, kind: "recovery_review_feedback", mediaType: "application/json", bytes: feedbackBytes, operationId: `${artifactId}-created` });
        await feedbackStore.append({ type: "recovery.review_feedback_recorded", runId: input.runId, operationId: `${artifactId}-event`, payload: { artifactId, candidateId: feedback.candidateId, decision: feedback.decision, stagingDigest: stagingDigest.digest, ...(feedbackCheckpoint ? { checkpointId: feedbackCheckpoint.checkpointId } : {}) } });
      } finally {
        unsubscribeFeedback?.();
        await feedbackStore.close();
      }
      return artifactId;
    };
    return {
      get baseline() { return automaticallyAcceptedBaseline ?? activeProviderPreview.baseline; },
      get providerPreview() { return activeProviderPreview; },
      staging,
      ...(readinessResult ? { taskReadiness: readinessResult } : {}),
      ...(automaticallyAcceptedBaseline ? { acceptedAutomatically: true } : {}),
      recovery,
      get candidateGraphArtifactId() { return candidateGraphArtifactId; },
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
        if (selectedCandidateId !== validatedCandidateId)
          throw new Error("Selected Recovery candidate has not been re-executed and validated.");
        const accepted = await provider.acceptRecovery(activeProviderPreview);
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
  } catch (error) {
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
        runId: input.runId,
        operationId: "recovery-preflight-failed",
        payload: diagnostic,
      });
    }
    let cleanupFailure: string | undefined;
    if (staging && failureStage === "provider_validation_failed") {
      try {
        await persistRecoveryValidationArtifacts(store, staging);
      } catch (artifactError) {
        await store.append({ type: "recovery.validation_artifact_failed", runId: input.runId, operationId: "recovery-validation-artifact-failed", payload: { reasonCode: artifactError instanceof Error ? artifactError.name : "unknown" } });
      }
    }
    if (staging) {
      try {
        await provider.discardRecovery(staging);
      } catch (cleanupError) {
        cleanupFailure = safeRecoveryFailureSummary(cleanupError, "runner_crashed");
        await store.append({ type: "recovery.cleanup_failed", runId: input.runId, operationId: "recovery-cleanup-failed", payload: { summary: cleanupFailure } });
      }
    }
    const fallback = await provider.resolveBaseline(
      { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
      [],
      {},
    );
    // Cleanup failure is recorded separately; it must not erase the original validation or safety diagnosis.
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
        runId: input.runId,
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
      runId: input.runId,
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
          caseId: input.caseId,
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
          startedAt: input.now,
          timings: recoveryTimingSummary(recoveryOrchestrator.attempts),
        }),
      ],
      undefined,
      store.events(input.runId),
    );
    return {
      baseline,
      recovery: failed,
      experimentRoot,
      experimentId: input.experimentId,
      provider,
    };
  } finally {
    if (writerAcquired) {
      const terminalStatus = failureStage === "preflight_failed" ? "failed" : "completed";
      try {
        await store.cleanupRecoveryArtifacts({ runId: input.runId, terminalStatus });
      } catch (error: unknown) {
        // Cleanup is best effort after the terminal record; a cleanup failure must not rewrite the Recovery outcome.
        try {
          await store.append({
            type: "recovery.artifact_cleanup_failed",
            runId: input.runId,
            operationId: "recovery-artifact-cleanup-terminal-failed",
            payload: { terminalStatus, reasonCode: error instanceof Error ? error.name : "unknown" },
          });
        } catch {
          // The writer may already be unusable; the terminal record remains authoritative.
        }
      }
    }
    unsubscribe?.();
    await store.close();
  }
}

/** Retries only transient execution failures; protocol, privacy, and cancellation failures remain terminal. */
function recoveryModelInputAudit(
  context: Record<string, unknown>,
  toolNames: readonly string[],
): Record<string, unknown> {
  const task = context.task as Record<string, unknown> | undefined;
  const session = context.session as Record<string, unknown> | undefined;
  const investigation = context.investigation as Record<string, unknown> | undefined;
  const staging = context.staging as Record<string, unknown> | undefined;
  const budget = context.budget as Record<string, unknown> | undefined;
  const initialInput = task?.initialInput;
  return {
    schemaVersion: 1,
    taskCaseId: typeof task?.caseId === "string" ? task.caseId : "unknown",
    evidenceLevel: context.evidenceLevel,
    attemptMode: context.attemptMode,
    session: {
      transcriptLength: session?.transcriptLength,
      historicalEventCount: session?.historicalEventCount,
    },
    investigation: {
      planId: investigation?.planId,
      factRefs: investigation?.factRefs,
      hypothesisIds: Array.isArray(investigation?.hypotheses)
        ? investigation.hypotheses.flatMap((hypothesis) => {
            const value = hypothesis as Record<string, unknown>;
            return typeof value.hypothesisId === "string" ? [value.hypothesisId] : [];
          })
        : [],
    },
    runtimeCapabilities: context.runtimeCapabilities,
    staging: { fileCount: staging?.fileCount, totalBytes: staging?.totalBytes },
    budget: { maxToolCalls: budget?.maxToolCalls, timeoutMs: budget?.timeoutMs },
    allowModelText: context.allowModelText,
    toolNames: [...toolNames],
    contextDigest: sha256(JSON.stringify(context) ?? "undefined"),
    initialInputDigest: sha256(JSON.stringify(initialInput) ?? "undefined"),
  };
}

function retryableRecoveryFailure(
  result: StructuredAgentResult<RecoveryResult>,
): "agent_failure" | "agent_timeout" | undefined {
  if (result.status !== "failed") return undefined;
  if (result.failure.code === "agent_timeout") return result.failure.code;
  if (result.failure.code !== "agent_failure") return undefined;
  // Legacy injected ports omit kind and retain the historical bounded retry;
  // real Host failures are classified, so auth/protocol/tool/unknown errors do not loop.
  return result.failure.kind === undefined ||
    result.failure.kind === "rate_limited" ||
    result.failure.kind === "transient_network" ||
    result.failure.kind === "transient_upstream" ||
    result.failure.kind === "timeout"
    ? result.failure.code
    : undefined;
}

function recoveryTimingSummary(
  attempts: readonly import("../core/schema.js").RecoveryLifecycleAttempt[],
): {
  forensicsMs?: number;
  modelRequestMs?: number;
  candidateMaterializationMs?: number;
} {
  const sum = (operation: import("../core/schema.js").RecoveryLifecycleAttempt["operation"]): number | undefined => {
    const values = attempts
      .filter((attempt) => attempt.operation === operation && attempt.result !== "started")
      .map((attempt) => attempt.durationMs);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const forensicsMs = sum("resolve_facts");
  const modelRequestMs = sum("invoke_model");
  const candidateMaterializationMs = sum("create_candidate");
  return {
    ...(forensicsMs === undefined ? {} : { forensicsMs }),
    ...(modelRequestMs === undefined ? {} : { modelRequestMs }),
    ...(candidateMaterializationMs === undefined ? {} : { candidateMaterializationMs }),
  };
}

function recoveryEvaluationCase(input: {
  caseId: string;
  staging?: RecoveryStaging | undefined;
  candidateCreated: boolean;
  recoveredPaths: string[];
  verification:
    "verified" | "pending_user_review" | "rejected" | "insufficient_evidence";
  forensicsCompleted: boolean;
  evidenceSourcesAttempted?: number | undefined;
  evidenceSourcesAvailable?: number | undefined;
  hypothesisCount?: number | undefined;
  candidateCount?: number | undefined;
  verifierRejectionReasons?: readonly string[] | undefined;
  providerFailureRetryable?: boolean | undefined;
  pathBoundaryRejected?: boolean | undefined;
  readiness?: RecoveryReadinessResult;
  taskOutcome?: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"];
  modelCalls: number;
  startedAt: string;
  timings?: { forensicsMs?: number; modelRequestMs?: number; candidateMaterializationMs?: number; };
}): import("../core/schema.js").RecoveryEvaluationCase {
  const common = {
    schemaVersion: 1 as const,
    caseId: input.caseId,
    stagingSucceeded: Boolean(input.staging),
    forensicsStarted: Boolean(input.staging),
    forensicsCompleted: input.forensicsCompleted,
    ...(input.evidenceSourcesAttempted === undefined
      ? {}
      : { evidenceSourcesAttempted: input.evidenceSourcesAttempted }),
    ...(input.evidenceSourcesAvailable === undefined
      ? {}
      : { evidenceSourcesAvailable: input.evidenceSourcesAvailable }),
    ...(input.hypothesisCount === undefined
      ? {}
      : { hypothesisCount: input.hypothesisCount }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount }),
    ...(input.verifierRejectionReasons?.length
      ? { verifierRejectionReasons: [...input.verifierRejectionReasons] }
      : {}),
    ...(input.providerFailureRetryable === undefined
      ? {}
      : { providerFailureRetryable: input.providerFailureRetryable }),
    ...(input.pathBoundaryRejected === undefined
      ? {}
      : { pathBoundaryRejected: input.pathBoundaryRejected }),
    ...(input.readiness ? { readinessStatus: input.readiness.status, readinessCheckedPaths: input.readiness.checkedPaths, readinessMissingPaths: input.readiness.missingPaths } : {}),
    ...(input.taskOutcome ? { taskOutcome: input.taskOutcome } : {}),
    candidateCreated: input.candidateCreated,
    verification: input.verification,
    recoveredPaths: [...new Set(input.recoveredPaths)],
    modelCalls: input.modelCalls,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    ...(input.timings && Object.keys(input.timings).length ? { timings: input.timings } : {}),
  };
  const checkpointPaths =
    input.staging?.checkpointFingerprint?.resources
      .filter((resource) => resource.kind === "file")
      .map((resource) => resource.path) ?? [];
  if (checkpointPaths.length > 0)
    return { ...common, layer: "interrupted_checkpoint", checkpointPaths };
  return { ...common, layer: "history_completed" };
}

function verdictToEvaluationStatus(
  candidateStatus: "verified" | "pending_user_review" | "rejected",
  envelopeStatus: RecoveryResult["status"],
): "verified" | "pending_user_review" | "rejected" | "insufficient_evidence" {
  if (candidateStatus === "rejected") return "rejected";
  if (candidateStatus === "verified" && envelopeStatus === "recovered")
    return "verified";
  return envelopeStatus === "insufficient_evidence"
    ? "insufficient_evidence"
    : "pending_user_review";
}

/** Restores a Provider-validated checkpoint without spending a model call or exposing checkpoint contents. */
function hostCheckpointRecovery(staging: RecoveryStaging): {
  result: RecoveryResult;
  manifest: RecoveryManifest;
  report: string;
  evidence: RecoveryEvidenceVerification[];
  changedPaths: string[];
} {
  const checkpoint = staging.checkpointFingerprint;
  if (!checkpoint || !staging.checkpointId)
    throw new Error(
      "Trusted checkpoint recovery requires checkpoint metadata.",
    );
  const before = new Map(
    staging.sourceFingerprint.resources.map((entry) => [entry.path, entry]),
  );
  const after = new Map(
    checkpoint.resources.map((entry) => [entry.path, entry]),
  );
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !path.startsWith(".git/") && path !== ".git")
    .filter(
      (path) =>
        JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)),
    )
    .sort();
  const refPrefix = `artifact:checkpoint-${staging.checkpointId.slice("checkpoint-".length, 96)}`;
  const evidence = changedPaths.map((path, index) => {
    const entry = after.get(path);
    return {
      ref: `${refPrefix}-${index}`,
      kind: "checkpoint" as const,
      path,
      ...(entry
        ? {
            entryKind: entry.kind,
            ...(entry.contentHash ? { hash: entry.contentHash } : {}),
          }
        : {}),
    };
  });
  // A no-op restore is still provenance-backed even though it has no manifest action.
  if (!evidence.length)
    evidence.push({ ref: `${refPrefix}-0`, kind: "checkpoint", path: "." });
  const evidenceByPath = new Map(evidence.map((item) => [item.path, item.ref]));
  const manifest: RecoveryManifest = {
    actions: changedPaths.map((path) => {
      const previous = before.get(path);
      const current = after.get(path);
      return {
        operation: !previous ? "create" : !current ? "delete" : "restore",
        path,
        ...(previous?.contentHash ? { beforeHash: previous.contentHash } : {}),
        ...(current?.contentHash ? { afterHash: current.contentHash } : {}),
        evidenceRefs: [evidenceByPath.get(path)!],
      };
    }),
    unresolved: [],
  };
  const result: RecoveryResult = {
    status: "recovered",
    reportPath: "recovery.md",
    unresolved: [],
    evidenceRefs: evidence.map((item) => item.ref),
    manifestPath: "recovery-manifest.json",
  };
  return {
    result,
    manifest,
    report: `# Recovery checkpoint restored\n\nThe Host restored ${changedPaths.length} candidate-visible path(s) from a Provider-validated checkpoint.\n`,
    evidence,
    changedPaths,
  };
}

/** Stores direct-write postimages as immutable artifacts; journal events only carry their content address. */
async function persistRecoveryControlledWriteBlob(
  store: ExperimentStore,
  candidateRoot: string,
  entry: RecoveryControlledWrite,
  binding: { checkpointId?: string; baseDigest: string },
): Promise<RecoveryControlledWrite> {
  const origin = entry.tool === "rename_file"
    ? "agent_direct_move"
    : entry.tool === "delete_file"
      ? "agent_direct_delete"
      : "agent_direct_write";
  const attributedEntry = { ...entry, ...binding, origin } as RecoveryControlledWrite;
  if (entry.phase !== "after" || !entry.after) {
    if (!Value.Check(RecoveryControlledWriteSchema, attributedEntry))
      throw new Error("Recovery controlled-write attribution is invalid.");
    return attributedEntry;
  }
  const absolutePath = recoveryCandidatePath(candidateRoot, entry.path);
  const bytes = await readFile(absolutePath);
  if (
    bytes.byteLength !== entry.after.size ||
    sha256(bytes) !== entry.after.contentHash
  )
    throw new Error(
      `Recovery controlled-write postimage changed before artifact capture: ${entry.path}.`,
    );
  const artifactId = `recovery-blob-${entry.after.contentHash}`;
  const artifact = await store.commitArtifact({
    artifactId,
    kind: "recovery_controlled_write_blob",
    mediaType: "application/octet-stream",
    bytes,
    operationId: `recovery-blob-${entry.after.contentHash.slice(0, 16)}`,
  });
  if (
    artifact.contentHash !== entry.after.contentHash ||
    artifact.byteLength !== entry.after.size
  )
    throw new Error("Recovery controlled-write blob artifact integrity mismatch.");
  const persisted = {
    ...attributedEntry,
    after: { ...entry.after, artifactId },
  };
  if (!Value.Check(RecoveryControlledWriteSchema, persisted))
    throw new Error("Persisted Recovery controlled-write blob entry is invalid.");
  return persisted;
}

function recoveryCandidatePath(candidateRoot: string, relativePath: string): string {
  const absolutePath = resolve(candidateRoot, relativePath);
  const pathFromRoot = relative(candidateRoot, absolutePath);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${String.fromCharCode(92)}`) ||
    pathFromRoot.startsWith("../") ||
    isAbsolute(pathFromRoot)
  )
    throw new Error("Recovery controlled-write artifact path escapes candidate root.");
  return absolutePath;
}
type RecoveryCandidatePathChange = {
  path: string;
  before?: { contentHash?: string } | undefined;
  after?: { contentHash?: string } | undefined;
};
type RecoveryCandidateDiff = {
  candidateId: string;
  hypothesisId: string;
  factRefs: string[];
  beforeDigest: string;
  afterDigest: string;
  /** All candidate changes, including Host delivery artifacts. */
  changedPaths: RecoveryCandidatePathChange[];
  /** Recovery-effect paths only. recovery.md and recovery-manifest.json never count as recovery. */
  taskPathOutcomes: import("../core/schema.js").RecoveryPathOutcome[];
};

function recoveryReviewSummary(
  candidate: RecoveryInvestigation["candidates"][number],
  facts: RecoveryInvestigation["facts"],
  changedPaths: string[],
  pathOutcomes: RecoveryCandidateDiff["taskPathOutcomes"],
  status: RecoveryReviewSummary["verifierStatus"],
  reasonCodes: readonly string[],
): RecoveryReviewSummary {
  const relevant = facts.filter(
    (fact) =>
      candidate.factRefs.includes(`fact:${fact.factId}`) ||
      changedPaths.some((path) =>
        fact.pathScope.some(
          (scope) => scope === "." || scope === path || path.startsWith(`${scope}/`),
        ),
      ),
  );
  const strengths = new Set(relevant.map((fact) => fact.reliability));
  const evidenceStrength: RecoveryReviewSummary["evidenceStrength"] =
    strengths.size === 0
      ? "none"
      : strengths.size > 1 || strengths.has("contradicted")
        ? "mixed"
        : strengths.has("strong")
          ? "strong"
          : strengths.has("corroborated")
            ? "corroborated"
            : "weak";
  const summary: RecoveryReviewSummary = {
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    hypothesisId: candidate.hypothesisId,
    changedPaths: [...new Set(changedPaths)],
    pathOutcomes,
    evidenceStrength,
    conflict: relevant.some((fact) => fact.reliability === "contradicted"),
    verifierStatus: status,
    reasonCodes: [...new Set(reasonCodes)],
    recommendedAction:
      status === "verified"
        ? "accept"
        : status === "rejected"
          ? "reject"
          : "review_candidate",
  };
  if (!Value.Check(RecoveryReviewSummarySchema, summary))
    throw new Error("Recovery review summary failed schema validation.");
  return summary;
}

/** Produces a bounded metadata diff without copying candidate file content into the event log. */
function recoveryCandidateDiff(
  candidate: { candidateId: string; hypothesisId: string },
  factRefs: string[],
  before: EnvironmentBaseline["fingerprint"],
  after: EnvironmentBaseline["fingerprint"],
  writes: readonly RecoveryControlledWrite[] = [],
): RecoveryCandidateDiff {
  const initial = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  const changedPaths = [...new Set([...initial.keys(), ...current.keys()])]
    .filter(
      (path) =>
        !path.startsWith(".git/") &&
        JSON.stringify(initial.get(path)) !== JSON.stringify(current.get(path)),
    )
    .sort()
    .map((path) => ({
      path,
      ...(initial.has(path) ? { before: initial.get(path) } : {}),
      ...(current.has(path) ? { after: current.get(path) } : {}),
    }));
  const renamedTargets = new Set(
    writes
      .filter((entry) => entry.phase === "after" && entry.tool === "rename_file")
      .map((entry) => entry.path),
  );
  const taskPathOutcomes = changedPaths
    .filter((change) => !isRecoveryDeliveryArtifact(change.path))
    .map((change) => ({
      path: change.path,
      disposition: renamedTargets.has(change.path)
        ? "renamed" as const
        : !change.before ? "created" as const : !change.after ? "removed" as const : "modified" as const,
      ...(change.before?.contentHash ? { beforeHash: change.before.contentHash } : {}),
      ...(change.after?.contentHash ? { afterHash: change.after.contentHash } : {}),
      verification: "changed" as const,
    }));
  return {
    candidateId: candidate.candidateId,
    hypothesisId: candidate.hypothesisId,
    factRefs: [...factRefs],
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changedPaths,
    taskPathOutcomes,
  };
}

function isRecoveryDeliveryArtifact(path: string): boolean {
  return path === "recovery.md" || path === "recovery-manifest.json";
}

type ActiveRun = { cancel(): Promise<unknown> };

/**
 * The publishing-level Codex experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startCodexExperiment(
  input: CodexExperimentInput,
): ExperimentHandle {
  let active: ActiveRun | undefined;
  let activeController: ControllerPort | undefined;
  let activeRunId: string | undefined;
  let cancelRequested = false;
  const result = executeExperiment(input, {
    setActive(run) {
      active = run;
    },
    setController(controller, runId) {
      activeController = controller;
      activeRunId = runId;
    },
    cancelled() {
      return cancelRequested;
    },
  });
  return {
    result,
    async cancel(): Promise<void> {
      cancelRequested = true;
      if (activeController && activeRunId)
        await activeController.cancel?.(
          activeRunId,
          `run:${activeRunId}:cancelled`,
        );
      if (active) await active.cancel();
    },
  };
}

async function executeExperiment(
  input: CodexExperimentInput,
  control: {
    setActive(run: ActiveRun): void;
    setController(controller: ControllerPort, runId: string): void;
    cancelled(): boolean;
  },
): Promise<CodexExperimentResult> {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
  findProductPack(input.candidate.productId);
  if (
    typeof input.taskCase !== "function" &&
    input.caseId !== input.taskCase.caseId
  )
    throw new Error("Experiment caseId must match TaskCase.caseId.");
  const experimentRoot = join(
    resolve(input.dataDir),
    "experiments",
    input.experimentId,
  );
  const startedAt = Date.now();
  const provider =
    input.environmentProvider ??
    new LocalWorkspaceProvider(join(experimentRoot, "environment"));
  const resolved = await resolveVerifiedCandidate(
    input.runtime,
    input.candidate,
  );
  const baseline =
    input.preResolvedBaseline ??
    (await provider.resolveBaseline(
      { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
      [],
      {},
    ));
  const sourceDigest =
    baseline.recovery?.sourceDigest ?? baseline.fingerprint.digest;
  if (
    input.expectedSourceFingerprint &&
    sourceDigest !== input.expectedSourceFingerprint
  ) {
    throw new Error(
      "The selected source changed after preflight. Run preflight again before starting the Candidate.",
    );
  }
  const taskCase =
    typeof input.taskCase === "function"
      ? input.taskCase(baseline)
      : input.taskCase;
  if (taskCase.caseId !== input.caseId)
    throw new Error(
      "Recovered TaskCase.caseId must match the experiment caseId.",
    );
  const historicalCwd = historicalCwdOf(taskCase);
  let sourceRootKind = inferSourceRootKind({
    sourceRoot: resolve(input.sourceRoot),
    ...(historicalCwd ? { historicalCwd } : {}),
    ...(input.sourceRootKind ? { explicit: input.sourceRootKind } : {}),
  });
  await mkdir(experimentRoot, { recursive: true });
  const preflight = preflightFromBaseline(baseline, resolved);
  await ensureTaskCase(
    join(resolve(input.dataDir), "cases", input.caseId, "case.json"),
    taskCase,
  );
  await writeImmutableJson(join(experimentRoot, "preflight.json"), preflight);
  if (preflight.sourceBaseline === "unavailable")
    throw new Error(
      "Candidate was not started because the source baseline is unavailable.",
    );
  if (control.cancelled())
    throw new Error("Experiment was cancelled before Candidate startup.");
  // Capture before the Candidate receives any writable copy; recovered baselines already carry their own immutable staging evidence.
  const checkpoint = baseline.recovery
    ? undefined
    : await provider.captureRecoveryCheckpoint({
        caseId: input.caseId,
        sourceRoot: resolve(input.sourceRoot),
      });

  const comparisonAgentConfig =
    input.comparisonAgentConfig ?? input.agentConfig;
  const spec = {
    experimentId: input.experimentId,
    taskCaseId: input.caseId,
    candidates: [input.candidate],
    controller: input.agentConfig,
    comparison: comparisonAgentConfig,
    runPolicy: input.policy,
    outputRoot: experimentRoot,
  };
  await writeImmutableJson(join(experimentRoot, "experiment.json"), {
    spec,
    runIds: [input.runId],
  });
  let environment = await provider.prepareRun(baseline, input.runId);
  if (sourceRootKind === "historical_cwd") {
    const rewind = await rewindIsolatedWorkspaceToStart({
      workspaceRoot: environment.root,
      taskCase,
      ...(historicalCwd ? { historicalCwd } : {}),
    });
    if (rewind.removed.length) {
      sourceRootKind = "historical_start";
      environment = {
        ...environment,
        beforeFingerprint: await provider.fingerprint(environment),
      };
    }
  }
  const attempt = {
    schemaVersion: 1 as const,
    runId: input.runId,
    experimentId: input.experimentId,
    caseId: input.caseId,
    candidate: input.candidate,
    policy: input.policy,
    createdAt: input.now,
  };
  const manifest: RunManifest = {
    schemaVersion: 1,
    attempt,
    resolvedModel: {
      requested: resolved.requestedModel,
      resolved: resolved.resolvedModel,
    },
    runtime: {
      productId: resolved.productId,
      executable: resolved.executable,
      ...(resolved.version ? { version: resolved.version } : {}),
    },
    environment: {
      environmentId: environment.environmentId,
      workspacePath: environment.root,
    },
    controller: input.agentConfig,
    comparison: comparisonAgentConfig,
    startedAt: input.now,
  };
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent
    ? store.subscribe(input.onEvent)
    : undefined;
  let released = false;
  const release = async () => {
    released = true;
    return provider.release(environment);
  };
  const targetEvents: string[] = [];
  let run: CandidateRun | undefined;
  try {
    await store.acquireWriter();
    if (checkpoint) {
      await store.append({
        type: "recovery.checkpoint_captured",
        runId: input.runId,
        operationId: `${checkpoint.checkpointId}-captured`,
        payload: {
          checkpointId: checkpoint.checkpointId,
          digest: checkpoint.fingerprint.digest,
          resourceCount: checkpoint.fingerprint.resources.length,
        },
      });
    }
    const recoveryArtifact = input.preResolvedBaseline?.recovery?.reportRef
      ? (await store.listArtifacts()).find(
          (artifact) =>
            artifact.artifactId ===
            input.preResolvedBaseline?.recovery?.reportRef,
        )
      : undefined;
    const recoveryArtifactRef = recoveryArtifact
      ? {
          artifactId: recoveryArtifact.artifactId,
          experimentId: input.experimentId,
        }
      : undefined;
    const sink: TargetEventSink = {
      append: async (targetEvent: TargetEvent): Promise<void> => {
        const event = await store.append({
          type: targetEvent.type,
          runId: input.runId,
          payload: targetEvent.payload,
          occurredAt: targetEvent.occurredAt,
        });
        targetEvents.push(`event:${event.eventId}`);
      },
    };
    const runner = await input.runtime.createRunner(
      resolved,
      environment,
      sink,
    );
    run = new CandidateRun({
      runner,
      policy: {
        turnTimeoutMs: input.policy.turnTimeoutMs,
        maxTargetTurns: input.policy.maxTargetTurns,
      },
      release,
      persistence: {
        journal: store,
        attempt,
        manifest,
        ...(recoveryArtifactRef ? { artifactRefs: [recoveryArtifactRef] } : {}),
        captureArtifacts: () =>
          input.captureArtifacts
            ? input.captureArtifacts({
                store,
                environment,
                workspaceProvider: provider,
                sourceRoot: resolve(input.sourceRoot),
                experimentId: input.experimentId,
                runId: input.runId,
              })
            : captureWorkspaceScope({
                store,
                environment,
                workspaceProvider: provider,
                experimentId: input.experimentId,
                runId: input.runId,
              }),
      },
    });
    control.setActive(run);
    control.setController(input.controller, input.runId);
    if (control.cancelled()) await run.cancel();
    else {
      const controller = await runControllerLoop({
        run,
        controller: input.controller,
        store,
        runId: input.runId,
        taskCase,
        policy: input.policy,
        controllerModel: input.agentConfig.requestedModel,
        environment,
        workspaceProvider: provider,
        sourceRootKind,
        requestedModel: input.candidate.requestedModel,
        resolvedModel: resolved.resolvedModel,
      });
      return await finishExperiment({
        input,
        taskCase,
        preflight,
        store,
        run,
        controller,
        experimentRoot,
        targetEvents,
        startedAt,
        sourceRootKind,
      });
    }
    const cancelled = {
      decision: {
        status: "cancelled" as const,
        factRef: `run:${input.runId}:cancelled`,
      },
      followupSubmission: false,
    };
    return await finishExperiment({
      input,
      taskCase,
      preflight,
      store,
      run,
      controller: cancelled,
      experimentRoot,
      targetEvents,
      startedAt,
      sourceRootKind,
    });
  } catch (error) {
    if (run?.states().at(-1) === "awaiting_controller") await run.cancel();
    throw error;
  } finally {
    unsubscribe?.();
    if (!released) await release();
    await store.close();
  }
}

export function controllerRequestSnapshot(context: SteeringContext): Record<string, unknown> {
  return {
    schemaVersion: 1,
    toolSetVersion: 1,
    requestId: context.requestId,
    runId: context.runId,
    runState: context.runState,
    current: context.current,
    trajectory: context.trajectory,
    evidenceCatalog: context.evidenceCatalog,
    budget: context.budget,
    ...(context.replay ? { replay: context.replay } : {}),
  };
}

async function runControllerLoop(input: {
  run: CandidateRun;
  controller: ControllerPort;
  store: ExperimentStore;
  runId: string;
  taskCase: TaskCase;
  policy: RunPolicy;
  controllerModel: string;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
  sourceRootKind: SourceRootKind;
  requestedModel: string;
  resolvedModel: string;
}): Promise<{
  decision: StructuredAgentResult<ControllerDecision>;
  followupSubmission: boolean;
}> {
  let state = await input.run.start(
    {
      id: input.taskCase.initialInput.id,
      text: input.taskCase.initialInput.text,
    },
    {
      runId: input.runId,
      turnIndex: 0,
      clientMessageId: `initial-${input.runId}`,
    },
  );
  const decisions: StructuredAgentResult<ControllerDecision>[] = [];
  let controllerCalls = 0;
  let duplicateInputs = 0;
  let followupSubmission = false;
  const startedAt = Date.now();
  await input.store.append({
    type: "controller.started",
    runId: input.runId,
    operationId: "controller-started",
    payload: { model: input.controllerModel },
  });
  while (state === "awaiting_controller") {
    if (Date.now() - startedAt >= input.policy.wallClockMs) {
      state = await input.run.stopByHarness("limit.wall_clock");
      break;
    }
    if (controllerCalls >= input.policy.maxModelCalls) {
      state = await input.run.stopByHarness("limit.controller_calls");
      break;
    }
    const observation = await inspectRun(
      input.store,
      undefined,
      input.taskCase.privacy.allowModelText,
      input.taskCase.source.productId,
      {
        runId: input.runId,
        environment: input.environment,
        workspaceProvider: input.workspaceProvider,
      },
      {
        sourceRootKind: input.sourceRootKind,
        requestedModel: input.requestedModel,
        resolvedModel: input.resolvedModel,
      },
    );
    const requestId = `controller-request-${input.runId}-${controllerCalls + 1}`;
    const context = {
        requestId,
        runId: input.runId,
        runState: state,
        task: {
          initialInput: input.taskCase.initialInput,
          baseline: input.taskCase.baseline,
          privacy: input.taskCase.privacy,
          historicalUserTurns: historicalUserFollowups(
            input.taskCase.transcript,
            input.taskCase.initialInput.id,
          ),
        },
        current: {
          summary: observation.currentSummary,
          evidenceRefs: observation.evidenceRefs,
        },
        evidenceCatalog: observation.evidenceRefs.map((ref) => ({ ref, runId: input.runId, source: 'initial' as const })),
        trajectory: {
          summary: observation.trajectorySummary,
          evidenceRefs: observation.evidenceRefs,
        },
        budget: {
          decisionsUsed: controllerCalls,
          decisionsLimit: input.policy.maxModelCalls,
        },
        replay: {
          sourceRootKind: input.sourceRootKind,
          isolation:
            "Writes stay in the isolated replica and never land in the original user directory.",
          requestedModel: input.requestedModel,
          resolvedModel: input.resolvedModel,
          changedPaths: observation.changedPaths,
        },
      };
    await input.store.append({
      type: 'controller.requested',
      runId: input.runId,
      operationId: requestId,
      payload: { schemaVersion: 1, toolSetVersion: 1, requestId, runId: input.runId, inputDigest: sha256(JSON.stringify(controllerRequestSnapshot(context))), snapshot: controllerRequestSnapshot(context) },
    });
    const tools = observationTools(input.store, {
      runId: input.runId,
      transcript: input.taskCase.transcript,
      allowModelText: input.taskCase.privacy.allowModelText,
    }).map((tool) => ({
      ...tool,
      onCompleted: async (result: { content: string; details?: unknown }) => {
        await input.store.append(observationReadRecord({
          requestId,
          runId: input.runId,
          details: result.details,
          allowedRefs: currentRunEventRefs(input.store.events(input.runId), input.runId),
        }));
      },
    }));
    const decision = await input.controller.decide(context, tools);
    controllerCalls += 1;
    decisions.push(decision);
    await input.store.append({
      type: "controller.decision",
      runId: input.runId,
      operationId: `controller-decision-${controllerCalls}`,
      payload: invocationFact(decision),
    });
    if (decision.status !== "completed") {
      state =
        decision.status === "failed"
          ? await input.run.failController({
              code: decision.failure.code,
              message: decision.failure.message,
            })
          : decision.status === "cancelled"
            ? await input.run.cancel()
            : await input.run.stopByHarness("stalled.no_progress");
      break;
    }
    if (decision.value.type === "done") {
      state = await input.run.settleController(decision.value.reason);
      break;
    }
    const previous = decisions.at(-2);
    duplicateInputs =
      isCompleted(previous) &&
      previous.value.type === "send" &&
      previous.value.message === decision.value.message
        ? duplicateInputs + 1
        : 0;
    if (duplicateInputs >= input.policy.maxConsecutiveNoProgress) {
      state = await input.run.stopByHarness("stalled.no_progress");
      break;
    }
    followupSubmission = true;
    state = await input.run.submit(
      {
        id: `controller-${input.runId}-${controllerCalls}`,
        text: decision.value.message,
      },
      {
        runId: input.runId,
        turnIndex: controllerCalls,
        clientMessageId: `controller-${controllerCalls}-${input.runId}`,
      },
    );
  }
  if (state !== "finished")
    throw new Error(`Candidate did not reach a terminal state: ${state}.`);
  const last = decisions.at(-1);
  if (!last)
    return {
      decision: {
        status: "failed",
        failure: {
          code: "agent_failure",
          message: "Controller produced no decision.",
          attempts: controllerCalls,
        },
      },
      followupSubmission,
    };
  return { decision: last, followupSubmission };
}

class RecoveryPlanPathBoundaryError extends Error {
  constructor() {
    super(
      "recovery_plan_unsafe_path: operations must use staging-relative slash paths outside .git.",
    );
    this.name = "RecoveryPlanPathBoundaryError";
  }
}

function validateSubmittedRecoveryPlan(
  plan: RecoveryPlan,
  investigation: RecoveryInvestigation,
): void {
  const knownFacts = new Set(
    investigation.facts.map((fact) => `fact:${fact.factId}`),
  );
  const knownHypotheses = new Set(
    investigation.plan.hypotheses.map((hypothesis) => hypothesis.hypothesisId),
  );
  const refs = [
    ...plan.factsUsed,
    ...plan.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supportingFactRefs,
      ...hypothesis.counterFactRefs,
    ]),
  ];
  if (refs.some((ref) => !knownFacts.has(ref)))
    throw new Error(
      "recovery_plan_unknown_fact: use only Host-provided investigation fact refs.",
    );
  const submittedHypotheses = new Set(plan.hypotheses.map((hypothesis) => hypothesis.hypothesisId));
  if (plan.candidates.some((candidate) => !knownHypotheses.has(candidate.hypothesisId) && !submittedHypotheses.has(candidate.hypothesisId)))
    throw new Error("recovery_plan_unknown_hypothesis: candidates must reference a submitted hypothesis.");
  for (const candidate of plan.candidates)
    for (const operation of candidate.operations)
      if (!isSafeRecoveryPlanPath(operation.path))
        throw new RecoveryPlanPathBoundaryError();
}

function isSafeRecoveryPlanPath(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !path.startsWith(".git/")
  );
}

function initialRecoveryInvestigation(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  observedAt: string,
): RecoveryInvestigation {
  const records = recoveryInvestigationFacts(facts, observedAt);
  const hypotheses = recoveryInvestigationHypotheses(facts, records);
  return {
    schemaVersion: 1,
    facts: records,
    plan: {
      planId: "evidence-ranked-forensics",
      factsUsed: records.map((fact) => `fact:${fact.factId}`),
      hypotheses,
      candidates: hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        operations: [],
      })),
      verificationPlan: [
        "compare candidate-visible diffs",
        "run the smallest task-relevant check",
      ],
    },
    candidates: [],
  };
}

function recoveryInvestigationFacts(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  observedAt: string,
): RecoveryInvestigation["facts"] {
  const sourceRefs = facts.evidenceRefs.length
    ? facts.evidenceRefs
    : ["artifact:recovery-investigation"];
  const historicalPaths = recoveryHistoricalPaths(facts);
  const records: RecoveryInvestigation["facts"] = [
    {
      factId: "workspace-current",
      kind: "workspace",
      reliability: "weak",
      sourceRefs,
      observedAt,
      pathScope: ["."],
      summary:
        "The isolated current workspace was captured for recovery investigation.",
    },
  ];
  if (facts.catalog.length)
    records.push({
      factId: "historical-observations",
      kind: "session",
      reliability: "weak",
      sourceRefs: facts.catalog.map((entry) => entry.ref),
      observedAt,
      pathScope: historicalPaths.length ? historicalPaths : ["."],
      summary: `${facts.catalog.length} frozen historical observation(s) are available for targeted investigation.`,
    });
  if (facts.git)
    records.push({
      factId: "git-state",
      kind: "git",
      reliability: facts.git.isRepo ? "corroborated" : "weak",
      sourceRefs,
      observedAt,
      pathScope: ["."],
      summary: facts.git.isRepo
        ? `Git repository observed with ${facts.git.headState} HEAD.`
        : "No Git repository was observed; workspace-only recovery remains possible.",
    });
  if (facts.patches.length)
    records.push({
      factId: "session-patches",
      kind: "patch",
      reliability: facts.patches.some((patch) => patch.verifiableBase)
        ? "corroborated"
        : "weak",
      sourceRefs,
      observedAt,
      pathScope: facts.patches.map((patch) => patch.targetPath),
      summary: `${facts.patches.length} session patch clue(s) were cataloged.`,
    });
  if (facts.preimages.length)
    records.push({
      factId: "preimages",
      kind: "artifact",
      reliability: "strong",
      sourceRefs,
      observedAt,
      pathScope: facts.preimages.map((preimage) => preimage.path),
      summary: `${facts.preimages.length} preimage artifact(s) were mechanically verified.`,
    });
  return records;
}

function recoveryInvestigationHypotheses(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  records: RecoveryInvestigation["facts"],
): RecoveryInvestigation["plan"]["hypotheses"] {
  const historicalPaths = recoveryHistoricalPaths(facts);
  const known = new Set(records.map((fact) => fact.factId));
  const hypotheses: RecoveryInvestigation["plan"]["hypotheses"] = [];
  const add = (input: RecoveryInvestigation["plan"]["hypotheses"][number]) => {
    if (input.supportingFactRefs.every((ref) => known.has(ref.slice(5))))
      hypotheses.push(input);
  };
  add({ hypothesisId: "preimage-reconstruction", rationale: "Mechanically verified preimages can restore the narrowest known paths before weaker inference.", paths: facts.preimages.map((preimage) => preimage.path), supportingFactRefs: ["fact:preimages"], counterFactRefs: [], expectedChecks: ["restore only preimage paths", "verify restored hashes"], confidence: "high" });
  add({ hypothesisId: "patch-replay", rationale: "Patch clues with a verified base may describe an auditable historical delta.", paths: facts.patches.map((patch) => patch.targetPath), supportingFactRefs: ["fact:session-patches"], counterFactRefs: [], expectedChecks: ["compare patch base", "verify affected paths"], confidence: facts.patches.some((patch) => patch.verifiableBase) ? "medium" : "low" });
  if (facts.git?.isRepo && facts.git.headState === "present")
    add({ hypothesisId: "git-history", rationale: "Available Git history is a supplemental, independently inspectable recovery branch.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:git-state"], counterFactRefs: [], expectedChecks: ["inspect Git metadata", "compare candidate diff"], confidence: "medium" });
  add({ hypothesisId: "historical-observations", rationale: "Frozen transcript and historical observations may narrow paths and tests without becoming proof by themselves.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:historical-observations"], counterFactRefs: [], expectedChecks: ["derive footprint", "compare candidate-visible diff"], confidence: "low" });
  add({ hypothesisId: "current-workspace", rationale: "The isolated current workspace remains a low-cost fallback and must be compared rather than assumed.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:workspace-current"], counterFactRefs: facts.git?.isRepo ? ["fact:git-state"] : [], expectedChecks: ["inspect candidate-visible diff", "check task-relevant tests"], confidence: "low" });
  if (!hypotheses.length)
    throw new Error("Recovery investigation has no Host-supported hypothesis.");
  return hypotheses;
}

function recoveryHistoricalPaths(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): string[] {
  return [...new Set([...facts.patches.map((patch) => patch.targetPath), ...facts.preimages.map((preimage) => preimage.path)])];
}

function forensicsFact(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): Record<string, unknown> {
  return {
    git: facts.git
      ? {
          isRepo: facts.git.isRepo,
          headState: facts.git.headState,
          statusAvailable: facts.git.statusAvailable,
        }
      : { isRepo: false, headState: "unavailable", statusAvailable: false },
    transcriptEntries: facts.catalog.filter(
      (entry) => entry.source === "transcript",
    ).length,
    historicalEventEntries: facts.catalog.filter(
      (entry) => entry.source === "historical_events",
    ).length,
    preimageCount: facts.preimages.length,
    patchCount: facts.patches.length,
    verifiedEvidenceCount: facts.verifiedEvidence.length,
    evidenceQuality: recoveryEvidenceQuality(facts),
    operations: facts.operations,
  };
}

function recoveryEvidenceQuality(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): {
  sourceReachability: { available: number; attempted: number };
  taskRelevantEvidence: number;
  strongEvidence: number;
  operationBearingEvidence: number;
  conflictRate: number;
} {
  const attempted = 4;
  const available = [
    true,
    facts.git !== undefined,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events") || facts.verifiedEvidence.length > 0,
  ].filter(Boolean).length;
  const taskRelevant = [
    facts.preimages.length > 0,
    facts.patches.length > 0,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events"),
  ].filter(Boolean).length;
  const strong = facts.verifiedEvidence.filter((evidence) => evidence.kind === "checkpoint" || evidence.kind === "preimage" || evidence.kind === "git_commit").length;
  return {
    sourceReachability: { available, attempted },
    taskRelevantEvidence: taskRelevant,
    strongEvidence: strong,
    operationBearingEvidence: facts.operations.filter((operation) => operation.availability === "available" && operation.operation !== "evidence_catalog").length,
    conflictRate: 0,
  };
}

/** One safe retry for a diagnostic explicitly classified as transient. */
async function retryRecoveryPreflight<T>(
  operation: string,
  operationFn: () => Promise<T>,
  onRetry: (diagnostic: RecoveryPreflightDiagnostic) => Promise<void>,
): Promise<T> {
  try {
    return await operationFn();
  } catch (error) {
    const diagnostic = recoveryPreflightDiagnostic(error, operation);
    if (!diagnostic.retryable) throw error;
    await onRetry(diagnostic);
    return operationFn();
  }
}

type RecoveryPreflightDiagnostic = {
  reasonCode:
    | "staging_creation_failed"
    | "source_unavailable"
    | "source_not_directory"
    | "source_workspace_overlap"
    | "source_budget_blocked"
    | "filesystem_error"
    | "unknown";
  operation: string;
  exitCategory: "hard_failure";
  retryable: boolean;
};

function recoveryPreflightDiagnostic(
  error: unknown,
  operation: string,
): RecoveryPreflightDiagnostic {
  const facts = errorFacts(error);
  const message = facts.messages.join(" ");
  const reasonCode = message.includes("cannot be recovered")
    ? "source_budget_blocked"
    : message.includes("must be a directory")
      ? "source_not_directory"
      : message.includes("must not overlap")
        ? "source_workspace_overlap"
        : message.includes("ENOENT") || facts.codes.includes("ENOENT")
          ? "source_unavailable"
          : operation === "begin_recovery_staging" &&
              /copy|mkdir/i.test(message)
            ? "staging_creation_failed"
            : facts.codes.length > 0 ||
                /git .* probe failed|fingerprint|workspace|filesystem|copy|mkdir/i.test(
                  message,
                )
              ? "filesystem_error"
              : "unknown";
  return {
    reasonCode,
    operation: operation || "recovery_preflight",
    exitCategory: "hard_failure",
    retryable:
      reasonCode === "filesystem_error" ||
      reasonCode === "staging_creation_failed",
  };
}

function errorFacts(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && messages.length < 8) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return { messages, codes };
}

/** Preserves known verifier failures while keeping unknown provider errors as crashes. */
async function persistRecoveryValidationArtifacts(store: ExperimentStore, staging: RecoveryStaging): Promise<void> {
  const files = ["recovery.md", "recovery-manifest.json"] as const;
  for (const file of files) {
    try {
      const bytes = await readFile(join(staging.root, file));
      await store.commitArtifact({
        artifactId: `recovery-validation-${file.replaceAll(".", "-")}`,
        kind: file === "recovery.md" ? "recovery_report" : "recovery_manifest",
        mediaType: file.endsWith(".md") ? "text/markdown" : "application/json",
        bytes,
        operationId: `recovery-validation-${file}-preserved`,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  await store.append({
    type: "recovery.validation_artifacts_preserved",
    runId: staging.caseId,
    operationId: "recovery-validation-artifacts-preserved",
    payload: { files: files.map((file) => file) },
  });
}

export function classifyRecoveryFailureStage(
  stage: NonNullable<
    NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]
  >,
  error: unknown,
  verifierRejectionReasons?: readonly string[],
  agentCompletedWithCandidate = false,
): NonNullable<NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]> {
  if (
    stage === "provider_validation_failed" &&
    verifierRejectionReasons?.length
  )
    return "provider_validation_failed";
  if (
    error instanceof RecoveryValidationError &&
    error.code === "source_tripwire_failed"
  )
    return "source_tripwire_failed";
  if (stage === "provider_validation_failed" && agentCompletedWithCandidate)
    return "provider_validation_failed";
  if (
    stage === "provider_validation_failed" &&
    !(error instanceof RecoveryValidationError) &&
    !(error instanceof RecoveryEvidenceValidationError)
  )
    return "runner_crashed";
  return stage;
}

function safeRecoveryFailureSummary(
  error: unknown,
  stage: NonNullable<EnvironmentBaseline["recovery"]>["failureStage"],
): string {
  if (stage === "source_tripwire_failed")
    return "Recovery source tripwire detected a source change.";
  if (stage === "agent_model_failed") return "Recovery model request failed.";
  if (stage === "agent_timeout") return "Recovery agent timed out.";
  if (stage === "agent_invalid_output")
    return "Recovery agent returned an invalid completion envelope.";
  if (stage === "provider_validation_failed")
    return "Provider validation rejected the recovery result.";
  if (stage === "preflight_failed") return "Recovery preflight failed.";
  if (stage === "cancelled") return "Recovery agent was cancelled.";
  if (stage === "runner_crashed") return "Recovery runner crashed.";
  return error instanceof Error && error.name === "AbortError"
    ? "Recovery agent was cancelled."
    : "Recovery agent or tool execution failed.";
}

function recoveryClues(taskCase: TaskCase): {
  cwd?: string;
  historicalCommit?: string;
  sourceVersion?: string;
} {
  const context = taskCase.taskContext ?? {};
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.length ? value : undefined;
  const cwd = string(context.cwd);
  const historicalCommit = string(context.historicalCommit);
  const sourceVersion = string(context.sourceVersion);
  return {
    ...(cwd ? { cwd } : {}),
    ...(historicalCommit ? { historicalCommit } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}

async function ensureTaskCase(path: string, taskCase: TaskCase): Promise<void> {
  try {
    const persisted = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<TaskCase>;
    if (
      persisted.caseId !== taskCase.caseId ||
      persisted.contentHash !== taskCase.contentHash
    )
      throw new Error(
        `TaskCase ${taskCase.caseId} conflicts with existing immutable content.`,
      );
  } catch (error) {
    if (isMissing(error)) await writeImmutableJson(path, taskCase);
    else throw error;
  }
}




