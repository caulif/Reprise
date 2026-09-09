import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { buildComparisonContext, briefingComparisonContext, comparisonOwnedObservationRefs } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonInvocationSchema, type ArtifactRef, type TaskCase } from "../core/schema.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import {
  writeImmutableJson,
  type ExperimentStore,
} from "../infrastructure/store/experiment-store.js";
import type { ExperimentInput, ExperimentResult } from "./experiment.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import { experimentAgentAuditSink, invocationFact, isMissing } from "./experiment-helpers.js";
import { inspectRun } from "./experiment-inspection.js";
import type { SourceRootKind } from "./replay-conditions.js";
import { comparisonOrientation, newComparisonAttempt, writeComparisonBriefing } from "./comparison-briefing.js";
import { controllerBriefingRoot } from "./controller-briefing.js";
import { assertComparisonResult, type ComparisonContext, type ComparisonResult } from "../agents/comparison-agent.js";
import type { AgentAuditSink, AgentInvocation, AgentToolDefinition } from "../infrastructure/agent/host.js";

const MAX_COMPARISON_INPUT_BYTES = 262_144;

export async function finishExperiment(input: {
  signal?: AbortSignal;
  input: ExperimentInput;
  taskCase: TaskCase;
  preflight: ExperimentPreflight;
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
  candidateSnapshotRoot: string;
  candidateSnapshotStatus: "complete" | "incomplete" | "missing";
  compare?: boolean;
}): Promise<ExperimentResult> {
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
): Promise<ExperimentResult> {
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
    comparisonResult: ExperimentResult["comparison"]["result"];
    reportPath: string;
  },
): ExperimentResult {
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
  if (input.candidateSnapshotStatus !== "complete") {
    await mkdir(comparisonCandidateMount({
      candidateSnapshotStatus: input.candidateSnapshotStatus,
      candidateSnapshotRoot: input.candidateSnapshotRoot,
      attemptRoot,
    }), { recursive: true });
  }
  const events = input.store.events(input.input.runId);
  const context: ComparisonContext = {
    ...buildComparisonContext(input.taskCase, [record], [inspection]),
    ownedEvidenceRefs: comparisonOwnedObservationRefs(input.taskCase, events),
  };
  const briefingContext = briefingComparisonContext(context);
  const materializedIds = new Set(record.artifactRefs.map((ref) => ref.artifactId));
  const briefing = await writeComparisonBriefing({
    attemptRoot, experimentRoot: input.experimentRoot, workspaceRoot: comparisonWorkspaceRoot(input),
    taskCase: input.taskCase, record, context: briefingContext, events,
    artifacts: (await input.store.listArtifacts(input.input.runId)).filter((artifact) => materializedIds.has(artifact.artifactId)),
  });
  await persistComparisonRequest(input.store, input.input.runId, attemptId, briefingContext);
  const compareContext = withOrientation(context, input, attemptId, attemptRoot, briefing.indexMarkdown);
  let comparisonResult: AgentInvocation<ComparisonResult>;
  try {
    comparisonResult = input.signal?.aborted
      ? { status: "cancelled" }
      : await invokeCompare(input, compareContext, attemptRoot, attemptId);
    if (input.signal?.aborted) comparisonResult = { status: "cancelled" };
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
  } finally {
    input.input.comparison.release?.(attemptId);
  }
  await input.store.append({
    type: "comparison.completed",
    runId: input.input.runId,
    operationId: `comparison-completed-${attemptId}`,
    payload: { attemptId, ...invocationFact(comparisonResult) },
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
  attemptId: string,
  attemptRoot: string,
  indexMarkdown: string,
): ComparisonContext {
  return {
    ...context,
    attemptId,
    promptContent: comparisonOrientation({
      briefingRoot: join(attemptRoot, "briefing"),
      indexMarkdown,
      baselineAvailable: input.taskCase.baseline.status === "available",
      candidateAvailable: context.candidates.length > 0,
    }),
  };
}

async function invokeCompare(
  input: Parameters<typeof finishExperiment>[0],
  context: ComparisonContext,
  attemptRoot: string,
  attemptId: string,
): Promise<AgentInvocation<ComparisonResult>> {
  if (input.signal?.aborted) return { status: "cancelled" };
  return input.input.comparison.compare(
    context,
    comparisonTools(input, attemptRoot),
    comparisonAudit(input, attemptId),
    input.signal,
  );
}

function comparisonWorkspaceRoot(input: Parameters<typeof finishExperiment>[0]): string {
  return input.candidateSnapshotStatus === "complete"
    ? input.candidateSnapshotRoot
    : join(input.experimentRoot, "comparison-attempts", "candidate-snapshot-unavailable");
}

export function comparisonCandidateMount(input: {
  candidateSnapshotStatus: "complete" | "incomplete" | "missing";
  candidateSnapshotRoot: string;
  attemptRoot: string;
}): string {
  if (input.candidateSnapshotStatus === "complete") return input.candidateSnapshotRoot;
  return join(input.attemptRoot, "candidate-snapshot-unavailable");
}

function comparisonTools(input: Parameters<typeof finishExperiment>[0], attemptRoot: string): AgentToolDefinition[] {
  const controllerRoot = controllerBriefingRoot(input.experimentRoot, input.input.runId);
  const scratchRoot = join(attemptRoot, "scratch");
  const candidateRoot = comparisonCandidateMount({
    candidateSnapshotStatus: input.candidateSnapshotStatus,
    candidateSnapshotRoot: input.candidateSnapshotRoot,
    attemptRoot,
  });
  return [
    ...recoveryTools(attemptRoot, {
      allowBinary: input.taskCase.privacy.allowBinary,
      mounts: {
        candidate: candidateRoot,
        evidence: join(attemptRoot, "evidence"),
        history: join(controllerRoot, "history"),
        turns: join(controllerRoot, "run", "turns"),
      },
      allowWrite: comparisonAttemptWriteAllowed,
      completionPaths: new Set(["work/comparison-plan.md", "report.html"]),
      denyDestructiveOnPrefix: ["candidate", "evidence", "history", "turns", "observations"],
      shellCwd: scratchRoot,
      shellEnv: {
        REPRISE_BASELINE_ROOT: join(controllerRoot, "history"), REPRISE_CANDIDATE_ROOT: candidateRoot,
        REPRISE_EVIDENCE_ROOT: join(attemptRoot, "evidence"), REPRISE_SCRATCH_ROOT: scratchRoot,
      },
      homeRoot: join(attemptRoot, ".home"),
    }),
  ];
}

function comparisonAudit(input: Parameters<typeof finishExperiment>[0], attemptId: string): AgentAuditSink {
  const sink = experimentAgentAuditSink(input.store, input.input.runId);
  return { append: (event) => sink.append({ ...event, payload: { attemptId, ...event.payload } }) };
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
  const failed = result.status === "failed" ? result.failure : undefined;
  const reason = failed?.message ?? "Comparison did not return a completed report.";
  const category =
    failed?.code === "invalid_output" && failed.message === "invalid JSON"
      ? "invalid_json"
      : failed?.message === "invalid JSON"
        ? "invalid_json"
        : failed?.message.startsWith("schema validation failed")
          ? "schema_validation"
          : undefined;
  const facts = [
    failed ? `code=${escapeHtml(failed.code)}` : undefined,
    category ? `category=${escapeHtml(category)}` : undefined,
    failed?.kind ? `kind=${escapeHtml(failed.kind)}` : undefined,
    failed ? `attempts=${failed.attempts}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const detail = facts.length ? `<p>${facts.join(" · ")}</p>` : "";
  await writeFile(reportPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Comparison unavailable</title><main><h1>Comparison unavailable</h1><p>${escapeHtml(reason)}</p>${detail}<p>Open the experiment trace and artifacts to inspect the recorded evidence. If report.html already exists, it belongs to an earlier successful attempt.</p></main></html>`, "utf8");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

/** Comparison may write only this attempt's scratch tree, working notes, and report.html. */
export function comparisonAttemptWriteAllowed(relativePath: string): boolean {
  const posix = relativePath.replaceAll("\\", "/");
  if (posix === "work/comparison-plan.md" || posix === "report.html") return true;
  return posix.split("/").filter(Boolean)[0] === "scratch";
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
