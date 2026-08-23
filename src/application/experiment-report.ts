import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { comparePersistedFacts } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import type { TaskCase } from "../core/schema.js";
import {
  comparisonReportTool,
  evidenceTools,
  observationTools,
} from "../infrastructure/agent-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import {
  writeImmutableJson,
  type ExperimentStore,
} from "../infrastructure/store/experiment-store.js";
import type {
  CodexExperimentInput,
  CodexExperimentPreflight,
  CodexExperimentResult,
} from "./experiment.js";
import { invocationFact, isMissing } from "./experiment-helpers.js";
import { inspectRun } from "./experiment-inspection.js";
import type { SourceRootKind } from "./replay-conditions.js";

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
  await input.store.append({
    type: "comparison.started",
    runId: input.input.runId,
    operationId: "comparison-started",
    payload: {
      model: (input.input.comparisonAgentConfig ?? input.input.agentConfig)
        .requestedModel,
    },
  });
  const inspection = await inspectRun(
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
  const comparison = await comparePersistedFacts({
    taskCase: input.taskCase,
    runs: [record],
    inspections: [inspection],
    agent: input.input.comparison,
    tools: [
      ...evidenceTools(input.store, record.artifactRefs),
      ...observationTools(input.store, {
        runId: input.input.runId,
        transcript: input.taskCase.transcript,
        allowModelText: input.taskCase.privacy.allowModelText,
      }),
      comparisonReportTool(input.experimentRoot),
    ],
  });
  let comparisonResult = comparison.result;
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
  const controllerCalls = input.store
    .events(input.input.runId)
    .filter((event) => event.type === "controller.decision").length;
  return {
    taskCase: input.taskCase,
    experimentRoot: input.experimentRoot,
    reportPath,
    preflight: input.preflight,
    record,
    decision: input.controller.decision,
    comparison: { result: comparisonResult },
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
