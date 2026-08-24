import { mkdir } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  RecoveryResult,
} from "../agents/recovery-agent.js";
import { verifyRecoveryCandidate } from "./recovery-verifier.js";
import { persistRecoveryEvaluation } from "./recovery-evaluation.js";
import {
  RecoveryCandidateGraphSchema,
  RecoveryInvestigationSchema,








} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import { replayControlledRecoveryDeltaBytes } from "../infrastructure/recovery-write-journal.js";
import type {
  RecoveryCandidateGraph,
  RecoveryInvestigation,
  RecoveryControlledWrite,
} from "../core/schema.js";
import {
  LocalWorkspaceProvider,
  RecoveryValidationError,
  type EnvironmentBaseline,
  type RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import {
  recoveryObservationTools,
  recoveryTools,
  resolvedRecoveryFacts,
  validateRecoveryEvidence,
} from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import {
  ExperimentStore,
  writeImmutableJson,
} from "../infrastructure/store/experiment-store.js";
import { findProductPack } from "../products/index.js";
import { historicalCwdOf } from "./replay-conditions.js";
import {
  assertIds,
  assertPaths,
  invocationFact,
} from "./experiment-helpers.js";
import { decideRecoverySearch } from "./recovery-selection.js";
import { materializeRecoveryCandidates } from "./recovery-candidate-materialization.js";
import { RecoveryOrchestrator, recoveryAttemptRecord, type RecoveryLifecycleState } from "./recovery-orchestrator.js";
import { checkRecoveryReadiness, deriveRecoveryReadinessContext, type RecoveryReadinessResult } from "./recovery-readiness.js";
import {
  recoveryModelInputAudit,
  retryableRecoveryFailure,
  recoveryTimingSummary,
  recoveryEvaluationCase,
  verdictToEvaluationStatus,

  persistRecoveryControlledWriteBlob,
  recoveryReviewSummary,
  recoveryCandidateDiff,
  validateSubmittedRecoveryPlan,
  initialRecoveryInvestigation,
  forensicsFact,
  retryRecoveryPreflight,
  classifyRecoveryFailureStage,
  recoveryClues,
  RecoveryPlanPathBoundaryError,
} from "./experiment-recovery-support.js";
import type { RecoveryAttempt, RecoveryAttemptInput } from "./experiment-recovery-types.js";
import { failRecoverCodexExperiment } from "./experiment-recovery-fail.js";
import { completeRecoveryReview } from "./experiment-recovery-review.js";
import { completeHostCheckpointRecovery } from "./experiment-recovery-checkpoint.js";

export { classifyRecoveryFailureStage };
export type { RecoveryAttempt, RecoveryAttemptInput, RecoveryAttemptMode } from "./experiment-recovery-types.js";

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverCodexExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  return executeRecoverCodexExperiment(input);
}

async function executeRecoverCodexExperiment(
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
  const providerFailureRetryable: boolean | undefined = undefined;
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
    const checkpointAttempt = await completeHostCheckpointRecovery({
      input,
      staging,
      experimentRoot,
      store,
      provider,
      activeStaging,
      recoveryOrchestrator,
      readinessResult,
      forensicsCompleted,
      evidenceSourcesAttempted,
      evidenceSourcesAvailable,
      hypothesisCount,
      candidateCount,
      verifierRejectionReasons,
      providerFailureRetryable,
      pathBoundaryRejected,
    });
    if (checkpointAttempt) return checkpointAttempt;
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
    const candidateGraphArtifactId = "recovery-candidate-graph";
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
    return await completeRecoveryReview({
      input,
      executionCandidate,
      graphCandidates,
      candidateStagings,
      staging,
      experimentRoot,
      recovery,
      candidateGraphArtifactId,
      context,
      activeStaging,

      investigation,
      facts,
      provider,
      candidateReviews,
      activeProviderPreview,

      automaticallyAcceptedBaseline,

      readinessResult,
      lifecycleState,
      moveRecoveryState,
      recoveryOrchestrator,
    });
  } catch (error) {
    return await failRecoverCodexExperiment({
      error,
      attemptInput: input,
      store,
      provider,
      experimentRoot,
      staging,
      recovery,
      recoveryOrchestrator,
      lifecycleState,
      moveRecoveryState,
      failureStage,
      preflightOperation,
      writerAcquired,
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
      readinessResult,
      taskOutcome,
      modelAttempts,
      toolFailureByTool,
      lastToolFailureCategory,
    });
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
