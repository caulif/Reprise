import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { buildComparisonContext, briefingComparisonContext, comparisonOwnedObservationRefs } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonInvocationSchema, ComparisonReportModelSchema, type ArtifactRef, type ComparisonLinkRecord, type ComparisonMediaRecord, type TaskCase } from "../core/schema.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import {
  writeImmutableJson,
  type ExperimentStore,
} from "../infrastructure/store/experiment-store.js";
import type { ExperimentInput, ExperimentResult } from "./experiment.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import { experimentAgentAuditSink, invocationFact, isMissing } from "./experiment-helpers.js";
import { inspectRun } from "./controller-queries.js";
import type { SourceRootKind } from "./replay-conditions.js";
import {
  comparisonAttemptMounts,
  comparisonCandidateMount,
  comparisonOrientation,
  newComparisonAttempt,
  writeComparisonBriefing,
} from "./comparison-briefing.js";
import { controllerBriefingRoot } from "./controller-briefing.js";
import { assertComparisonResult, type ComparisonContext, type ComparisonResult } from "../agents/comparison-agent.js";
import type { AgentAuditSink, AgentInvocation, AgentToolDefinition } from "../infrastructure/agent/host.js";
import { extractHostZoneSnapshot, metricsFromReportFacts, renderComparisonReportShell } from "./comparison-report-shell.js";
import {
  comparisonFailureDiagnostic,
  persistComparisonReportModel,
  publishComparisonArtifacts,
  verifyAndRenderComparisonReport,
} from "./comparison-publication.js";

export { comparisonCandidateMount };

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
      ...(inspection.costUsd === undefined ? {} : { costUsd: inspection.costUsd }),
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
    attemptId,
    ownedEvidenceRefs: comparisonOwnedObservationRefs(input.taskCase, events),
  };
  const briefingContext = briefingComparisonContext(context);
  const materializedIds = new Set(record.artifactRefs.map((ref) => ref.artifactId));
  const briefing = await writeComparisonBriefing({
    attemptRoot, experimentRoot: input.experimentRoot, workspaceRoot: comparisonWorkspaceRoot(input),
    taskCase: input.taskCase, record, context: briefingContext, events,
    artifacts: (await input.store.listArtifacts(input.input.runId)).filter((artifact) => materializedIds.has(artifact.artifactId)),
    snapshotStatus: input.candidateSnapshotStatus,
  });
  const reportShellHtml = renderComparisonReportShell({
    task: context.task.summary,
    facts: context.reportFacts,
    metrics: metricsFromReportFacts(context.reportFacts),
    evidence: briefing.links,
    media: briefing.media,
  });
  const hostZoneSnapshot = extractHostZoneSnapshot(reportShellHtml);
  const compareFacts = {
    ...context,
    media: briefing.media,
    shortEvidenceRefs: briefing.links.flatMap((link) => link.shortRef ? [link.shortRef] : []),
    attemptRoot,
    ...(hostZoneSnapshot ? { hostZoneSnapshot } : {}),
  };
  await persistComparisonRequest(input.store, input.input.runId, attemptId, { ...briefingContext, media: briefing.media });
  const compareContext = {
    ...withOrientation(compareFacts, input, attemptId, attemptRoot, briefing.indexMarkdown),
    reportShellHtml,
  };
  let comparisonResult: AgentInvocation<ComparisonResult>;
  try {
    comparisonResult = input.signal?.aborted
      ? { status: "cancelled" }
      : await invokeCompare(input, compareContext, attemptRoot, attemptId, briefing.media.some((item) => item.available));
    if (input.signal?.aborted) comparisonResult = { status: "cancelled" };
    comparisonResult = remapInvalidEnvelope(comparisonResult, await reportExists(attemptRoot, "report.html"));
    if (comparisonResult.status === "completed") assertComparisonResult(comparisonResult.value, compareFacts);
    if (comparisonResult.status === "completed") {
      comparisonResult = await enforcePublishedReport(comparisonResult, attemptRoot, compareFacts, briefing);
    }
    if (comparisonResult.status === "completed") {
      await publishComparisonArtifacts({
        attemptRoot,
        experimentRoot: input.experimentRoot,
        html: await readFile(join(attemptRoot, "report.html"), "utf8"),
      });
      await persistPublishedReportModel(attemptRoot, input.experimentRoot);
    }
  } finally {
    await input.input.comparison.release?.(attemptId);
  }
  return persistComparisonInvocation({
    store: input.store,
    runId: input.input.runId,
    experimentRoot: input.experimentRoot,
    attemptId,
    attemptRoot,
    comparisonResult,
    facts: context.reportFacts,
  });
}

async function persistComparisonInvocation(input: {
  store: ExperimentStore;
  runId: string;
  experimentRoot: string;
  attemptId: string;
  attemptRoot: string;
  comparisonResult: AgentInvocation<ComparisonResult>;
  facts: ComparisonContext["reportFacts"];
}) {
  await input.store.append({
    type: "comparison.completed",
    runId: input.runId,
    operationId: `comparison-completed-${input.attemptId}`,
    payload: { attemptId: input.attemptId, ...invocationFact(input.comparisonResult) },
  });
  const status = input.comparisonResult.status;
  if (!Value.Check(ComparisonInvocationSchema, input.comparisonResult)) throw new Error("Comparison result does not satisfy ComparisonInvocationSchema.");
  await writeAtomic(join(input.experimentRoot, "comparison.json"), `${JSON.stringify(input.comparisonResult)}\n`);
  const completed = status === "completed";
  const reportPath = completed
    ? join(input.experimentRoot, "report.html")
    : join(input.experimentRoot, "comparison-failure.html");
  if (!completed) {
    await writeComparisonFailurePage({
      reportPath,
      result: input.comparisonResult,
      facts: input.facts,
      attemptId: input.attemptId,
      attemptRoot: input.attemptRoot,
    });
  }
  await input.store.append({
    type: "report.created",
    runId: input.runId,
    operationId: `report-created-${input.attemptId}`,
    payload: { path: reportPath, attemptId: input.attemptId },
  });
  return { comparisonResult: input.comparisonResult, reportPath };
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

async function enforcePublishedReport(
  result: AgentInvocation<ComparisonResult>,
  attemptRoot: string,
  context: ComparisonContext,
  briefing: { links: readonly ComparisonLinkRecord[]; media: readonly ComparisonMediaRecord[] },
): Promise<AgentInvocation<ComparisonResult>> {
  if (result.status !== "completed") return result;
  if (!(await reportExists(attemptRoot, result.value.reportPath))) {
    return {
      status: "failed",
      sessionId: result.sessionId,
      failure: {
        code: "agent_failure",
        message: "Comparison agent completed without writing report.html.",
        attempts: 1,
      },
    };
  }
  const verified = await verifyAndRenderComparisonReport({
    html: await readFile(join(attemptRoot, "report.html"), "utf8"),
    facts: context.reportFacts,
    result: result.value,
    attemptRoot,
    media: briefing.media,
    evidence: briefing.links,
    ...(context.hostZoneSnapshot ? { hostZoneSnapshot: context.hostZoneSnapshot } : {}),
  });
  if ("failureClass" in verified) {
    return {
      status: "failed",
      sessionId: result.sessionId,
      failure: {
        code: verified.code,
        message: verified.message,
        attempts: 1,
      },
    };
  }
  await writeAtomic(join(attemptRoot, "report.html"), verified.html);
  await persistComparisonReportModel(attemptRoot, verified.model);
  return result;
}

function remapInvalidEnvelope(result: AgentInvocation<ComparisonResult>, reportPresent: boolean): AgentInvocation<ComparisonResult> {
  if (result.status !== "failed" || !reportPresent) return result;
  const message = result.failure.message;
  if (result.failure.code !== "invalid_output" && message !== "invalid JSON" && !message.includes("schema validation failed")) return result;
  return { ...result, failure: { ...result.failure, code: "invalid_envelope" } };
}

async function persistPublishedReportModel(attemptRoot: string, experimentRoot: string): Promise<void> {
  try {
    await persistComparisonReportModel(experimentRoot, readReportModel(await readFile(join(attemptRoot, "report-model.json"), "utf8")));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

async function invokeCompare(
  input: Parameters<typeof finishExperiment>[0],
  context: ComparisonContext,
  attemptRoot: string,
  attemptId: string,
  allowBinary: boolean,
): Promise<AgentInvocation<ComparisonResult>> {
  if (input.signal?.aborted) return { status: "cancelled" };
  return input.input.comparison.compare(
    context,
    comparisonTools(input, attemptRoot, allowBinary),
    comparisonAudit(input, attemptId),
    input.signal,
  );
}

function comparisonWorkspaceRoot(input: Parameters<typeof finishExperiment>[0]): string {
  return input.candidateSnapshotStatus === "complete"
    ? input.candidateSnapshotRoot
    : join(input.experimentRoot, "comparison-attempts", "candidate-snapshot-unavailable");
}

function comparisonTools(input: Parameters<typeof finishExperiment>[0], attemptRoot: string, allowBinary: boolean): AgentToolDefinition[] {
  const controllerRoot = controllerBriefingRoot(input.experimentRoot, input.input.runId);
  const scratchRoot = join(attemptRoot, "scratch");
  const mounts = comparisonAttemptMounts({
    experimentRoot: input.experimentRoot,
    runId: input.input.runId,
    attemptRoot,
    candidateSnapshotStatus: input.candidateSnapshotStatus,
    candidateSnapshotRoot: input.candidateSnapshotRoot,
  });
  const candidateRoot = mounts.candidate;
  return [
    ...recoveryTools(attemptRoot, {
      allowBinary: input.taskCase.privacy.allowBinary || allowBinary,
      mounts,
      allowWrite: comparisonAttemptWriteAllowed,
      completionPaths: new Set(["work/comparison-plan.md", "report.html"]),
      denyDestructiveOnPrefix: ["candidate", "evidence", "history", "turns", "run", "observations"],
      allowShell: true,
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

function languageOf(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function readReportModel(raw: string): import("../core/schema.js").ComparisonReportModel {
  const value = JSON.parse(raw) as unknown;
  if (!Value.Check(ComparisonReportModelSchema, value)) throw new Error("Comparison report model does not satisfy ComparisonReportModelSchema.");
  return value;
}

async function writeComparisonFailurePage(input: {
  reportPath: string;
  result: StructuredAgentResult<unknown>;
  facts: ComparisonContext["reportFacts"];
  attemptId: string;
  attemptRoot: string;
}): Promise<void> {
  const reportPresent = await reportExists(input.attemptRoot, "report.html");
  const html = renderComparisonReportShell({
    title: "Comparison unavailable",
    task: "对照未能完成这次比较",
    facts: input.facts,
    metrics: metricsFromReportFacts(input.facts),
    diagnostic: comparisonFailureDiagnostic({
      result: input.result,
      facts: input.facts,
      reportPresent,
      attemptId: input.attemptId,
    }),
  });
  await writeFile(input.reportPath, html, "utf8");
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
