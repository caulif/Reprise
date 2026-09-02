import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { comparePersistedFacts, buildComparisonContext } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import { sha256 } from "../core/identity.js";
import type { ArtifactRef, TaskCase } from "../core/schema.js";
import { observationTools } from "../infrastructure/agent-tools.js";
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

const MAX_COMPARISON_INPUT_BYTES = 262_144;

export async function finishExperiment(input: {
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
  await input.store.append({
    type: "comparison.started",
    runId: input.input.runId,
    operationId: "comparison-started",
    payload: {
      model: (input.input.comparisonAgentConfig ?? input.input.agentConfig)
        .requestedModel,
    },
  });
  const sandboxRoot = join(input.experimentRoot, "comparison-sandbox");
  await materializeComparisonSandbox(input.store, record.artifactRefs, sandboxRoot);
  await persistComparisonRequest(input.store, input.input.runId, buildComparisonContext(
    input.taskCase,
    [record],
    [inspection],
  ));
  let comparisonResult = (await invokeComparison(input, record, inspection, sandboxRoot)).result;
  if (comparisonResult.status === "completed") {
    await copyComparisonReport(sandboxRoot, input.experimentRoot);
  }
  if (
    comparisonResult.status === "completed" &&
    !(await reportExists(
      input.experimentRoot,
      comparisonResult.value.reportPath,
    ))
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
  await input.store.append({
    type: "comparison.completed",
    runId: input.input.runId,
    operationId: "comparison-completed",
    payload: invocationFact(comparisonResult),
  });
  await writeImmutableJson(
    join(input.experimentRoot, "comparison.json"),
    comparisonResult,
  );
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
    operationId: "report-created",
    payload: { path: reportPath },
  });
  return { comparisonResult, reportPath };
}

async function invokeComparison(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
  inspection: Awaited<ReturnType<typeof inspectRun>>,
  sandboxRoot: string,
) {
  return comparePersistedFacts({
    taskCase: input.taskCase,
    runs: [record],
    inspections: [inspection],
    agent: input.input.comparison,
    audit: experimentAgentAuditSink(input.store, input.input.runId),
    tools: [
      ...observationTools(input.store, {
        runId: input.input.runId,
        transcript: input.taskCase.transcript,
        allowModelText: input.taskCase.privacy.allowModelText,
      }),
      ...recoveryTools(sandboxRoot, {
        mounts: { candidate: input.workspaceRoot },
        allowWrite: (path) => path === "report.html",
        completionPaths: new Set(["report.html"]),
        denyDestructiveOnPrefix: ["candidate"],
        homeRoot: join(input.experimentRoot, ".reprise-comparison-home"),
      }),
    ],
  });
}

async function persistComparisonRequest(store: ExperimentStore, runId: string, context: unknown): Promise<void> {
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
    operationId: "comparison-requested",
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

async function copyComparisonReport(sandboxRoot: string, experimentRoot: string): Promise<void> {
  try {
    await copyFile(join(sandboxRoot, "report.html"), join(experimentRoot, "report.html"));
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
  await writeFile(reportPath, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Comparison unavailable</title><main><h1>Comparison unavailable</h1><p>${escapeHtml(reason)}</p><p>Open the experiment trace and artifacts to inspect the recorded evidence.</p></main></html>`, "utf8");
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
