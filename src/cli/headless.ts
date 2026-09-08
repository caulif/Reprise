import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Value } from "@sinclair/typebox/value";
import { TaskCaseSchema, type EventEnvelope, type TaskCase } from "../core/schema.js";
import { CLI_EXIT, exitCodeForKind, type CliActivity, type CliOutputMode } from "../core/cli-protocol.js";
import { classifyCliError, CliError } from "../application/cli-error.js";
import { createHarnessWorkflow, type ExperimentWorkflow } from "../application/experiment-workflow.js";
import { assertExclusiveRunInputs, compareExperiment, prepareExperiment, runFullExperiment, runSealedScenario } from "../application/experiment-operations.js";
import { importSourceSession, inspectSourceSession } from "../application/experiment-queries.js";
import { activityControlReady, type ExperimentActivity } from "../application/experiment-activity.js";
import { loadAndActivateProductPacks } from "../products/index.js";
import { errorBody, parseOutputMode, writeActivity, writeEnd, writeEvent, writeJsonResult, type ProtocolIo } from "./protocol.js";

export type HeadlessContext = {
  readonly now?: string;
  readonly workflow?: ExperimentWorkflow;
};

const headlessOptions = {
  "data-dir": { type: "string" },
  "source-root": { type: "string" },
  "task-case": { type: "string" },
  scenario: { type: "string" },
  "source-path": { type: "string" },
  experiment: { type: "string" },
  run: { type: "string" },
  product: { type: "string" },
  model: { type: "string" },
  compare: { type: "boolean" },
  json: { type: "boolean" },
  jsonl: { type: "boolean" },
  "timeout-ms": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export async function runHeadlessCommand(command: "prepare" | "run" | "compare", args: readonly string[], io: ProtocolIo, context: HeadlessContext = {}): Promise<number> {
  let mode: CliOutputMode = "json";
  try {
    const values = parseArgs({ args: [...args], options: headlessOptions, allowPositionals: false, strict: true }).values;
    if (values.help) {
      io.stdout(headlessUsage(command));
      return CLI_EXIT.ok;
    }
    mode = parseOutputMode(values);
    const signal = timeoutSignal(values["timeout-ms"]);
    const dataDir = resolve(values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
    await loadAndActivateProductPacks(dataDir);
    const workflow = context.workflow ?? createHarnessWorkflow({
      dataDir,
      now: context.now ? () => context.now! : () => new Date().toISOString(),
    });
    if (command === "compare" && values.experiment) {
      return await runPersistedCompare(workflow, values.experiment, values.run, io, mode, signal);
    }
    if (command === "compare" && !values.experiment) {
      assertExclusiveRunInputs({ sourceRoot: values["source-root"], taskCasePath: values["task-case"] });
    }
    if (command === "run") {
      assertExclusiveRunInputs({ sourceRoot: values["source-root"], taskCasePath: values["task-case"] }, values.scenario);
    }
    if (command === "prepare") {
      if (values["task-case"] && values["source-root"]) {
        /* task-case path */
      } else if (!values.product || !values["source-path"]) {
        throw new CliError("usage", headlessUsage(command));
      }
    }
    return await runSourceOrScenario(command, values, workflow, dataDir, io, mode, signal);
  } catch (error: unknown) {
    return failCommand(command, error, io, mode);
  }
}

async function runPersistedCompare(workflow: ExperimentWorkflow, experimentId: string, runId: string | undefined, io: ProtocolIo, mode: CliOutputMode, signal?: AbortSignal): Promise<number> {
  const activity: CliActivity = {
    operationId: `op-compare-${experimentId}`,
    experimentId,
    runId: runId ?? experimentId,
  };
  writeActivity(io, mode, "compare", activity);
  const result = await workflow.comparePersisted(experimentId, (event) => writeEvent(io, mode, event), signal, runId);
  const ok = result.comparison.result.status === "completed";
  emitSettled(io, mode, "compare", activity, { status: result.comparison.result.status, experimentId, reportPath: result.reportPath }, ok, result.comparison.result.status);
  return ok ? CLI_EXIT.ok : CLI_EXIT.failed;
}

async function runSourceOrScenario(
  command: "prepare" | "run" | "compare",
  values: { "source-root"?: string; "task-case"?: string; "source-path"?: string; scenario?: string; product?: string; model?: string; compare?: boolean },
  workflow: ExperimentWorkflow,
  dataDir: string,
  io: ProtocolIo,
  mode: CliOutputMode,
  signal?: AbortSignal,
): Promise<number> {
  const candidate = candidateFromFlags(values, workflow);
  const onEvent = (event: EventEnvelope) => writeEvent(io, mode, event);
  if (command === "prepare") {
    const prepared = await resolvePrepareSource(values, dataDir);
    const attempt = await prepareExperiment(workflow, { taskCase: prepared.taskCase, sourceRoot: prepared.sourceRoot, ...(signal ? { signal } : {}), onEvent });
    const activity = { operationId: `op-prepare-${attempt.experimentId}`, experimentId: attempt.experimentId, runId: attempt.experimentId };
    writeActivity(io, mode, command, activity);
    emitSettled(io, mode, command, activity, { experimentId: attempt.experimentId, sealed: attempt.accept !== undefined, accept: attempt.accept !== undefined, caseId: prepared.taskCase.caseId }, attempt.accept !== undefined, attempt.accept !== undefined ? "sealed" : "failed");
    return attempt.accept !== undefined ? CLI_EXIT.ok : CLI_EXIT.failed;
  }
  const compare = values.compare === true || command === "compare";
  if (values.scenario) {
    const handle = await runSealedScenario(workflow, {
      dataDir, scenario: values.scenario, onEvent,
      ...(candidate ? { candidate } : {}),
      ...(compare ? { compare: true } : {}),
      ...(signal ? { signal } : {}),
    });
    return settleHandle(command, handle, io, mode, signal);
  }
  const handle = await runFullExperiment(workflow, {
    taskCase: await readTaskCase(values["task-case"]!),
    sourceRoot: resolve(values["source-root"]!),
    onEvent,
    ...(candidate ? { candidate } : {}),
    ...(compare ? { compare: true } : {}),
    ...(signal ? { signal } : {}),
  });
  if (command === "compare") await compareExperiment(handle);
  return settleHandle(command, handle, io, mode, signal);
}

function candidateFromFlags(
  values: { product?: string; model?: string },
  workflow: ExperimentWorkflow,
) {
  if (Boolean(values.product) !== Boolean(values.model)) {
    throw new CliError("usage", "--product and --model must be provided together.");
  }
  if (values.product && values.model) {
    return { candidateId: `${values.product}-${values.model}`, productId: values.product, requestedModel: values.model };
  }
  return workflow.candidate;
}

async function settleHandle(command: string, handle: Awaited<ReturnType<typeof runFullExperiment>>, io: ProtocolIo, mode: CliOutputMode, signal?: AbortSignal): Promise<number> {
  const activity = handle.activity
    ? cliActivity(handle.activity)
    : { operationId: `op-${command}-unset`, experimentId: "unset", runId: "unset" };
  writeActivity(io, mode, command, activity);
  if (handle.activity) await activityControlReady(handle.activity);
  const stop = attachSigint(() => handle.cancel());
  const abortRun = () => { void handle.cancel(); };
  if (signal?.aborted) abortRun();
  signal?.addEventListener("abort", abortRun, { once: true });
  try {
    const result = await handle.result;
    const comparisonStatus = result.comparison.result.status;
    const ok = command === "compare" ? comparisonStatus === "completed" : runSucceeded(result.record.state, result.record.outcome.termination.kind);
    emitSettled(io, mode, command, activity, { state: result.record.state, experimentId: result.record.attempt.experimentId, runId: result.record.attempt.runId, comparisonStatus }, ok, result.record.state);
    return exitForOutcome(ok, result.record.outcome.termination.kind);
  } finally {
    signal?.removeEventListener("abort", abortRun);
    stop();
  }
}

function runSucceeded(state: string, kind: string): boolean {
  if (kind === "cancelled") return false;
  if (state === "failed" || kind === "failed") return false;
  return true;
}

function exitForOutcome(ok: boolean, kind: string): number {
  if (kind === "cancelled") return CLI_EXIT.cancelled;
  return ok ? CLI_EXIT.ok : CLI_EXIT.failed;
}

function cliActivity(activity: ExperimentActivity): CliActivity {
  return { operationId: activity.operationId, experimentId: activity.experimentId, runId: activity.runId };
}

function attachSigint(cancel: () => Promise<void>): () => void {
  const onSigint = () => { void cancel(); };
  process.on("SIGINT", onSigint);
  return () => process.off("SIGINT", onSigint);
}

function emitSettled(io: ProtocolIo, mode: CliOutputMode, command: string, activity: CliActivity, data: unknown, ok: boolean, status?: string): void {
  if (mode === "jsonl") writeEnd(io, mode, ok, status);
  else writeJsonResult(io, { ok, command, activity, data });
}

function failCommand(command: string, error: unknown, io: ProtocolIo, mode: CliOutputMode): number {
  const classified = classifyCliError(error);
  io.stderr(classified.message);
  if (mode === "jsonl") writeEnd(io, mode, false, classified.kind, errorBody(classified));
  else writeJsonResult(io, { ok: false, command, error: errorBody(classified) });
  return exitCodeForKind(classified.kind);
}

function timeoutSignal(value: string | undefined): AbortSignal | undefined {
  if (!value) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1) throw new CliError("usage", "--timeout-ms must be a positive integer.");
  return AbortSignal.timeout(ms);
}

function headlessUsage(command: "prepare" | "run" | "compare"): string {
  if (command === "prepare") return "Usage: reprise prepare (--source-root <dir> --task-case <file.json> | --product <id> --source-path <path> [--source-root <dir>]) [--data-dir <dir>] [--json|--jsonl]";
  if (command === "compare") return "Usage: reprise compare (--experiment <id> [--run <runId>] | --source-root <dir> --task-case <file.json>) [--data-dir <dir>] [--json|--jsonl]";
  return "Usage: reprise run (--source-root <dir> --task-case <file.json> | --scenario <experimentId>) [--data-dir <dir>] [--product <id>] [--model <id>] [--compare] [--json|--jsonl]";
}

async function resolvePrepareSource(values: { "source-root"?: string; "task-case"?: string; "source-path"?: string; product?: string }, dataDir: string): Promise<{ taskCase: TaskCase; sourceRoot: string }> {
  if (values["task-case"] && values["source-root"]) {
    return { taskCase: await readTaskCase(values["task-case"]), sourceRoot: resolve(values["source-root"]) };
  }
  if (!values.product || !values["source-path"]) throw new CliError("usage", headlessUsage("prepare"));
  const frozen = await importSourceSession({ productId: values.product, dataDir, sourcePath: values["source-path"] });
  const inspected = values["source-root"] ? undefined : await inspectSourceSession({ productId: values.product, dataDir, sourcePath: values["source-path"] });
  return {
    taskCase: frozen.taskCase,
    sourceRoot: values["source-root"] ? resolve(values["source-root"]) : inspected?.cwd ?? dirname(values["source-path"]),
  };
}

async function readTaskCase(path: string): Promise<TaskCase> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Value.Check(TaskCaseSchema, parsed)) throw new Error(`TaskCase at ${path} does not satisfy TaskCaseSchema.`);
  return parsed;
}
