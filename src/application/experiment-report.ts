import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { buildComparisonContext, briefingComparisonContext, comparisonOwnedObservationRefs } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonInvocationSchema, type ArtifactRef, type TaskCase } from "../core/schema.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import {
  writeImmutableJson,
  type ExperimentStore,
} from "../infrastructure/store/experiment-store.js";
import type {
  CodexExperimentInput,
  CodexExperimentPreflight,
  CodexExperimentResult,
} from "./experiment.js";
import { experimentAgentAuditSink, invocationFact, isMissing } from "./experiment-helpers.js";
import { inspectRun } from "./experiment-inspection.js";
import type { SourceRootKind } from "./replay-conditions.js";
import { comparisonOrientation, newComparisonAttempt, writeComparisonBriefing, type ComparisonPhase, type ComparisonPlanStatus } from "./comparison-briefing.js";
import { controllerBriefingRoot } from "./controller-briefing.js";
import { assertComparisonResult, type ComparisonContext, type ComparisonPlanResult, type ComparisonResult } from "../agents/comparison-agent.js";
import type { AgentAuditSink, AgentInvocation, AgentToolDefinition } from "../infrastructure/pi-agent-host.js";

const MAX_COMPARISON_INPUT_BYTES = 262_144;

export async function finishExperiment(input: {
  signal?: AbortSignal;
  input: CodexExperimentInput;
  taskCase: TaskCase;
  preflight: CodexExperimentPreflight;
  store: ExperimentStore;
  run: CandidateRun;
  controller: {
    decision: StructuredAgentResult<ControllerDecision>;
    followupSubmission: boolean;
  };
  experimentRoot: string;
  targetEvents: readonly string[];
  startedAt: number;
  sourceRootKind: SourceRootKind;
  workspaceRoot: string;
  compare?: boolean;
}): Promise<CodexExperimentResult> {
  const finishedRecord = input.run.result().record;
  if (!finishedRecord)
    throw new Error("Candidate run did not produce a RunRecord.");
  const traceArtifact = await input.store.commitArtifact({
    artifactId: "host-trace.json",
    runId: input.input.runId,
    kind: "host_run_trace",
    mediaType: "application/json",
    bytes: Buffer.from(
      JSON.stringify(input.store.events(input.input.runId), null, 2),
      "utf8",
    ),
  });
  const traceRef = {
    artifactId: traceArtifact.artifactId,
    experimentId: input.input.experimentId,
    runId: input.input.runId,
  };
  const record = {
    ...finishedRecord,
    artifactRefs: [...finishedRecord.artifactRefs, traceRef],
  };
  await writeImmutableJson(
    join(input.experimentRoot, "runs", input.input.runId, "record.json"),
    record,
  );
  const inspection = await inspectExperimentRun(input, record);
  const compared = input.compare
    ? await compareExperimentOutcome(input, record, inspection)
    : skippedComparison(input.experimentRoot);
  return experimentResult(input, record, inspection, compared);
}

export async function attachExperimentComparison(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
): Promise<CodexExperimentResult> {
  const inspection = await inspectExperimentRun(input, record);
  return experimentResult(
    input,
    record,
    inspection,
    await compareExperimentOutcome(input, record, inspection),
  );
}

function skippedComparison(experimentRoot: string) {
  return {
    comparisonResult: { status: "skipped" as const },
    reportPath: experimentRoot,
  };
}

function experimentResult(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
  inspection: Awaited<ReturnType<typeof inspectRun>>,
  compared: {
    comparisonResult: CodexExperimentResult["comparison"]["result"];
    reportPath: string;
  },
): CodexExperimentResult {
  const controllerCalls = input.store
    .events(input.input.runId)
    .filter((event) => event.type === "controller.decision").length;
  return {
    taskCase: input.taskCase,
    experimentRoot: input.experimentRoot,
    reportPath: compared.reportPath,
    preflight: input.preflight,
    record,
    decision: input.controller.decision,
    comparison: { result: compared.comparisonResult },
    followupSubmission: input.controller.followupSubmission,
    targetEvents: input.targetEvents,
    facts: {
      elapsedMs: Date.now() - input.startedAt,
      turns: inspection.turns,
      controllerCalls,
      ...(inspection.wallClockMs === undefined
        ? {}
        : { wallClockMs: inspection.wallClockMs }),
      ...(inspection.tokenCount === undefined
        ? {}
        : { tokenCount: inspection.tokenCount }),
    },
  };
}

async function inspectExperimentRun(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
) {
  return inspectRun(
    input.store,
    record,
    input.taskCase.privacy.allowModelText,
    input.input.candidate.productId,
    undefined,
    {
      sourceRootKind: input.sourceRootKind,
      requestedModel: input.input.candidate.requestedModel,
      ...(record.manifest?.resolvedModel.resolved
        ? { resolvedModel: record.manifest.resolvedModel.resolved }
        : {}),
      lang: languageOf(input.taskCase.initialInput.text),
    },
  );
}

async function compareExperimentOutcome(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
  inspection: Awaited<ReturnType<typeof inspectRun>>,
) {
  const { attemptId, attemptRoot } = newComparisonAttempt(input.experimentRoot);
  await input.store.append({
    type: "comparison.started",
    runId: input.input.runId,
    operationId: `comparison-started-${attemptId}`,
    payload: {
      attemptId,
      model: (input.input.comparisonAgentConfig ?? input.input.agentConfig)
        .requestedModel,
    },
  });
  await materializeComparisonSandbox(input.store, record.artifactRefs, attemptRoot);
  const events = input.store.events(input.input.runId);
  const context: ComparisonContext = {
    ...buildComparisonContext(input.taskCase, [record], [inspection]),
    ownedEvidenceRefs: comparisonOwnedObservationRefs(input.taskCase, events),
  };
  const briefingContext = briefingComparisonContext(context);
  const materializedIds = new Set(record.artifactRefs.map((ref) => ref.artifactId));
  const briefing = await writeComparisonBriefing({
    attemptRoot, experimentRoot: input.experimentRoot, workspaceRoot: input.workspaceRoot,
    taskCase: input.taskCase, record, context: briefingContext, events,
    artifacts: (await input.store.listArtifacts(input.input.runId)).filter((artifact) => materializedIds.has(artifact.artifactId)),
  });
  await persistComparisonRequest(input.store, input.input.runId, attemptId, briefingContext);
  const planContext = withOrientation(context, input, "plan", attemptRoot, briefing.indexMarkdown, "unavailable");
    await persistPhaseRequest(input.store, input.input.runId, attemptId, "plan", briefingComparisonContext(planContext));
  const planResult = await invokePlan(input, planContext, attemptRoot, attemptId);
  const plan = await planHandoff(attemptRoot, planResult);
  await input.store.append({ type: "comparison.plan_completed", runId: input.input.runId, operationId: `comparison-plan-completed-${attemptId}`, payload: { attemptId, phase: "plan", planStatus: plan.status, ...invocationFact(planResult) } });
  const reportContext = withOrientation(context, input, "report", attemptRoot, briefing.indexMarkdown, plan.status, plan.failureKind, plan.digest);
  let comparisonResult: AgentInvocation<ComparisonResult>;
  if (planResult.status === 'cancelled' || input.signal?.aborted) comparisonResult = { status: 'cancelled' };
  else {
    await persistPhaseRequest(input.store, input.input.runId, attemptId, "report", { ...briefingComparisonContext(reportContext), planContent: plan.content });
    comparisonResult = await invokeReport(input, reportContext, attemptRoot, attemptId);
  }
  if (input.signal?.aborted) comparisonResult = { status: 'cancelled' };
  if (comparisonResult.status === "completed") assertComparisonResult(comparisonResult.value, context);
  if (
    comparisonResult.status === "completed" &&
    !(await reportExists(attemptRoot, comparisonResult.value.reportPath))
  ) {
    comparisonResult = {
      status: "failed",
      sessionId: comparisonResult.sessionId,
      failure: {
        code: "agent_failure",
        message: "Comparison agent completed without writing report.html.",
        attempts: 1,
      },
    };
  }
  if (comparisonResult.status === "completed") await publishComparisonReport(attemptRoot, input.experimentRoot);
  await input.store.append({
    type: "comparison.completed",
    runId: input.input.runId,
    operationId: `comparison-report-completed-${attemptId}`,
    payload: { attemptId, phase: "report", ...invocationFact(comparisonResult) },
  });
  if (!Value.Check(ComparisonInvocationSchema, comparisonResult)) throw new Error("Comparison result does not satisfy ComparisonInvocationSchema.");
  await writeAtomic(join(input.experimentRoot, "comparison.json"), `${JSON.stringify(comparisonResult)}\n`);
  const completedComparison = comparisonResult.status === "completed" ? comparisonResult.value : undefined;
  const reportPath = completedComparison
    ? join(input.experimentRoot, "report.html")
    : join(input.experimentRoot, "comparison-failure.html");
  if (!completedComparison) {
    await writeComparisonFailurePage(reportPath, comparisonResult);
  }
  await input.store.append({
    type: "report.created",
    runId: input.input.runId,
    operationId: `report-created-${attemptId}`,
    payload: { path: reportPath, attemptId },
  });
  return { comparisonResult, reportPath };
}

function withOrientation(
  context: ComparisonContext,
  input: Parameters<typeof finishExperiment>[0],
  phase: ComparisonPhase,
  attemptRoot: string,
  indexMarkdown: string,
  planStatus: ComparisonPlanStatus,
  planFailureKind?: string,
  planDigest?: string,
): ComparisonContext {
  return { ...context, promptContent: comparisonOrientation({
    phase, initialInput: input.taskCase.initialInput.text,
    briefingRoot: join(attemptRoot, "briefing"), indexMarkdown,
    baselineAvailable: input.taskCase.baseline.status === "available",
    candidateAvailable: context.candidates.length > 0,
    planStatus, ...(planFailureKind ? { planFailureKind } : {}), ...(planDigest ? { planDigest } : {}),
  }) };
}

async function invokePlan(
  input: Parameters<typeof finishExperiment>[0],
  context: ComparisonContext,
  attemptRoot: string,
  attemptId: string,
): Promise<AgentInvocation<ComparisonPlanResult>> {
  if (!input.input.comparison.plan) return { status: "failed", failure: { code: "agent_failure", message: "Comparison Planner is unavailable.", attempts: 0 } };
  if (input.signal?.aborted) return { status: 'cancelled' };
  return input.input.comparison.plan(context, comparisonTools(input, attemptRoot, "plan"), phaseAudit(input, attemptId, "plan"), input.signal);
}

async function invokeReport(
  input: Parameters<typeof finishExperiment>[0], context: ComparisonContext, attemptRoot: string, attemptId: string,
): Promise<AgentInvocation<ComparisonResult>> {
  if (input.signal?.aborted) return { status: 'cancelled' };
  const tools = comparisonTools(input, attemptRoot, "report");
  const audit = phaseAudit(input, attemptId, "report");
  return input.input.comparison.report
    ? input.input.comparison.report(context, tools, audit, input.signal)
    : input.input.comparison.compare(context, tools, audit, input.signal);
}

function comparisonTools(input: Parameters<typeof finishExperiment>[0], attemptRoot: string, phase: ComparisonPhase): AgentToolDefinition[] {
  const controllerRoot = controllerBriefingRoot(input.experimentRoot, input.input.runId);
  const scratchRoot = join(attemptRoot, "scratch");
  return [
    ...recoveryTools(attemptRoot, {
      allowBinary: input.taskCase.privacy.allowBinary,
      mounts: {
        candidate: input.workspaceRoot,
        evidence: join(attemptRoot, "evidence"),
        history: join(controllerRoot, "history"),
        turns: join(controllerRoot, "run", "turns"),
      },
      allowWrite: (path) => path.startsWith("scratch/") || path === "work/comparison-plan.md" || (phase === "report" && path === "report.html"),
      completionPaths: new Set(phase === "plan" ? ["work/comparison-plan.md"] : ["report.html"]),
      denyDestructiveOnPrefix: ["candidate", "evidence", "history", "turns", "observations"],
      shellCwd: scratchRoot,
      shellEnv: {
        REPRISE_BASELINE_ROOT: join(controllerRoot, "history"), REPRISE_CANDIDATE_ROOT: input.workspaceRoot,
        REPRISE_EVIDENCE_ROOT: join(attemptRoot, "evidence"), REPRISE_SCRATCH_ROOT: scratchRoot,
      },
      homeRoot: join(attemptRoot, ".home"),
    }),
  ];
}

function phaseAudit(input: Parameters<typeof finishExperiment>[0], attemptId: string, phase: ComparisonPhase): AgentAuditSink {
  const sink = experimentAgentAuditSink(input.store, input.input.runId);
  return { append: (event) => sink.append({ ...event, payload: { attemptId, phase, ...event.payload } }) };
}

async function planHandoff(attemptRoot: string, result: AgentInvocation<ComparisonPlanResult>): Promise<{ status: ComparisonPlanStatus; content?: string; digest?: string; failureKind?: string }> {
  const path = join(attemptRoot, "work", "comparison-plan.md");
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content?.trim()) return { status: "unavailable", ...(result.status === "failed" && result.failure.kind ? { failureKind: result.failure.kind } : {}) };
  return {
    status: result.status === "completed" ? "ready" : "partial_unverified",
    content, digest: sha256(content),
    ...(result.status === "failed" && result.failure.kind ? { failureKind: result.failure.kind } : {}),
  };
}

async function persistPhaseRequest(store: ExperimentStore, runId: string, attemptId: string, phase: ComparisonPhase, snapshot: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  const digest = sha256(bytes);
  const artifact = await store.commitArtifact({ artifactId: `comparison-${phase}-input-${digest.slice(0, 16)}`, runId, kind: `comparison_${phase}_model_input`, mediaType: "application/json", bytes });
  await store.append({ type: `comparison.${phase}_requested`, runId, operationId: `comparison-${phase}-requested-${attemptId}`, payload: { schemaVersion: 1, attemptId, phase, inputDigest: digest, artifactId: artifact.artifactId, byteLength: bytes.byteLength } });
}

async function persistComparisonRequest(store: ExperimentStore, runId: string, attemptId: string, context: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(context), "utf8");
  const truncated = bytes.byteLength > MAX_COMPARISON_INPUT_BYTES;
  const stored = truncated ? bytes.subarray(0, MAX_COMPARISON_INPUT_BYTES) : bytes;
  const digest = sha256(stored);
  const artifact = await store.commitArtifact({
    artifactId: `comparison-model-input-${digest.slice(0, 16)}`,
    runId,
    kind: "comparison_model_input",
    mediaType: "application/json",
    bytes: stored,
  });
  await store.append({
    type: "comparison.requested",
    runId,
    operationId: `comparison-requested-${attemptId}`,
    payload: {
      schemaVersion: 1,
      requestId: "comparison-requested",
      runId,
      inputDigest: digest,
      artifactId: artifact.artifactId,
      byteLength: stored.byteLength,
      truncated,
    },
  });
}

async function materializeComparisonSandbox(
  store: ExperimentStore,
  refs: readonly ArtifactRef[],
  sandboxRoot: string,
): Promise<void> {
  await mkdir(join(sandboxRoot, "evidence"), { recursive: true });
  for (const ref of refs) {
    if (!("experimentId" in ref)) continue;
    const bytes = await store.readArtifact(ref);
    await writeFile(join(sandboxRoot, "evidence", ref.artifactId), bytes);
  }
}

async function publishComparisonReport(attemptRoot: string, experimentRoot: string): Promise<void> {
  try {
    await writeAtomic(join(experimentRoot, "report.html"), await readFile(join(attemptRoot, "report.html"), "utf8"));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function languageOf(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

async function writeComparisonFailurePage(
  reportPath: string,
  result: StructuredAgentResult<unknown>,
): Promise<void> {
  const reason = result.status === "failed" ? result.failure.message : "Comparison did not return a completed report.";
  await writeFile(reportPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Comparison unavailable</title><main><h1>Comparison unavailable</h1><p>${escapeHtml(reason)}</p><p>Open the experiment trace and artifacts to inspect the recorded evidence. If report.html already exists, it belongs to an earlier successful attempt.</p></main></html>`, "utf8");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

async function reportExists(
  experimentRoot: string,
  reportPath: string,
): Promise<boolean> {
  try {
    await readFile(join(experimentRoot, reportPath), "utf8");
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
