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
import { createProductLookup, loadAndActivateProductPacks, packLoadDiagnostics, productPacks } from "../products/index.js";
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
  "source-product": { type: "string" },
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
  const foreground = installForegroundCancel();
  try {
    const values = parseArgs({ args: [...args], options: headlessOptions, allowPositionals: false, strict: true }).values;
    if (values.help) {
      io.stdout(headlessUsage(command));
      return CLI_EXIT.ok;
    }
    mode = parseOutputMode(values);
    const timeout = timeoutSignal(values["timeout-ms"]);
    if (timeout) foreground.follow(timeout);
    const dataDir = resolve(values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
    await loadAndActivateProductPacks(dataDir);
    const workflow = context.workflow ?? createHarnessWorkflow({
      dataDir,
      lookup: createProductLookup(productPacks, packLoadDiagnostics),
      now: context.now ? () => context.now! : () => new Date().toISOString(),
    });
    if (command === "compare" && values.experiment) {
      return await runPersistedCompare(workflow, values.experiment, values.run, io, mode, foreground.signal);
    }
    if (command === "compare" && !values.experiment) {
      assertExclusiveRunInputs({ sourceRoot: values["source-root"], taskCasePath: values["task-case"] });
    }
    if (command === "run") {
      assertExclusiveRunInputs({ sourceRoot: values["source-root"], taskCasePath: values["task-case"] }, values.scenario);
    }
    if (command === "prepare") {
      if (values.product || values.model) {
        throw new CliError("usage", "prepare uses --source-product for the session source; --product/--model select a candidate on run.");
      }
      if (values["task-case"] && values["source-root"]) {
        /* task-case path */
      } else if (!values["source-product"] || !values["source-path"]) {
        throw new CliError("usage", headlessUsage(command));
      }
    }
    return await runSourceOrScenario(command, values, workflow, dataDir, io, mode, foreground.signal);
  } catch (error: unknown) {
    return failCommand(command, error, io, mode);
  } finally {
    foreground.stop();
  }
}

async function runPersistedCompare(workflow: ExperimentWorkflow, experimentId: string, runId: string | undefined, io: ProtocolIo, mode: CliOutputMode, signal: AbortSignal): Promise<number> {
  const sink = bindProtocol(io, mode, "compare");
  const result = await workflow.comparePersisted(experimentId, sink.onEvent, signal, runId, sink.onActivity);
  const ok = result.comparison.result.status === "completed";
  emitSettled(io, mode, "compare", sink.current(), { status: result.comparison.result.status, experimentId, reportPath: result.reportPath }, ok, result.comparison.result.status);
  return ok ? CLI_EXIT.ok : CLI_EXIT.failed;
}

async function runSourceOrScenario(
  command: "prepare" | "run" | "compare",
  values: { "source-root"?: string; "task-case"?: string; "source-path"?: string; "source-product"?: string; scenario?: string; product?: string; model?: string; compare?: boolean },
  workflow: ExperimentWorkflow,
  dataDir: string,
  io: ProtocolIo,
  mode: CliOutputMode,
  signal: AbortSignal,
): Promise<number> {
  const sink = bindProtocol(io, mode, command);
  const onEvent = sink.onEvent;
  const onActivity = sink.onActivity;
  if (command === "prepare") {
    const prepared = await resolvePrepareSource(values, dataDir);
    const attempt = await prepareExperiment(workflow, { taskCase: prepared.taskCase, sourceRoot: prepared.sourceRoot, signal, onEvent, onActivity });
    emitSettled(io, mode, command, sink.current(), { experimentId: attempt.experimentId, sealed: attempt.accept !== undefined, accept: attempt.accept !== undefined, caseId: prepared.taskCase.caseId }, attempt.accept !== undefined, attempt.accept !== undefined ? "sealed" : "failed");
    return attempt.accept !== undefined ? CLI_EXIT.ok : CLI_EXIT.failed;
  }
  const candidate = candidateFromFlags(values, workflow);
  const compare = values.compare === true || command === "compare";
  if (values.scenario) {
    const handle = await runSealedScenario(workflow, {
      dataDir, scenario: values.scenario, onEvent, onActivity,
      ...(candidate ? { candidate } : {}),
      ...(compare ? { compare: true } : {}),
      signal,
    });
    return settleHandle(command, handle, io, mode, signal, sink);
  }
  const handle = await runFullExperiment(workflow, {
    taskCase: await readTaskCase(values["task-case"]!),
    sourceRoot: resolve(values["source-root"]!),
    onEvent,
    onActivity,
    ...(candidate ? { candidate } : {}),
    ...(compare ? { compare: true } : {}),
    signal,
  });
  if (command === "compare") await compareExperiment(handle);
  return settleHandle(command, handle, io, mode, signal, sink);
}

function candidateFromFlags(
  values: { product?: string; model?: string },
  workflow: ExperimentWorkflow,
) {
  if (Boolean(values.product) !== Boolean(values.model)) {
    throw new CliError("usage", "--product and --model must be provided together to select a candidate.");
  }
  if (values.product && values.model) {
    return { candidateId: `${values.product}-${values.model}`, productId: values.product, requestedModel: values.model };
  }
  return workflow.candidate;
}

async function settleHandle(
  command: string,
  handle: Awaited<ReturnType<typeof runFullExperiment>>,
  io: ProtocolIo,
  mode: CliOutputMode,
  signal: AbortSignal,
  sink: ProtocolSink,
): Promise<number> {
  if (handle.activity) sink.onActivity(handle.activity);
  if (handle.activity) await activityControlReady(handle.activity);
  const abortRun = () => { void handle.cancel(); };
  if (signal.aborted) abortRun();
  signal.addEventListener("abort", abortRun, { once: true });
  try {
    const result = await handle.result;
    const comparisonStatus = result.comparison.result.status;
    const ok = command === "compare" ? comparisonStatus === "completed" : runSucceeded(result.record.state, result.record.outcome.termination.kind);
    const activity = sink.current();
    emitSettled(io, mode, command, activity, { state: result.record.state, experimentId: result.record.attempt.experimentId, runId: result.record.attempt.runId, comparisonStatus }, ok, result.record.state);
    return exitForOutcome(ok, result.record.outcome.termination.kind);
  } finally {
    signal.removeEventListener("abort", abortRun);
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

type ProtocolSink = {
  onActivity: (activity: ExperimentActivity) => void;
  onEvent: (event: EventEnvelope) => void;
  current: () => CliActivity | undefined;
};

function bindProtocol(io: ProtocolIo, mode: CliOutputMode, command: string): ProtocolSink {
  let published: CliActivity | undefined;
  const pending: EventEnvelope[] = [];
  return {
    onActivity(activity) {
      const next = cliActivity(activity);
      if (published?.operationId === next.operationId) return;
      published = next;
      writeActivity(io, mode, command, next);
      for (const event of pending.splice(0)) writeEvent(io, mode, event);
    },
    onEvent(event) {
      if (!published) pending.push(event);
      else writeEvent(io, mode, event);
    },
    current: () => published,
  };
}

function emitSettled(io: ProtocolIo, mode: CliOutputMode, command: string, activity: CliActivity | undefined, data: unknown, ok: boolean, status?: string): void {
  if (mode === "jsonl") writeEnd(io, mode, ok, status);
  else writeJsonResult(io, { ok, command, ...(activity ? { activity } : {}), data });
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

type ForegroundCancel = { readonly signal: AbortSignal; follow(other: AbortSignal): void; stop(): void };

function installForegroundCancel(): ForegroundCancel {
  const controller = new AbortController();
  const onSigint = () => { controller.abort(); };
  process.on("SIGINT", onSigint);
  const followed: AbortSignal[] = [];
  const onFollow = () => { controller.abort(); };
  return {
    signal: controller.signal,
    follow(other) {
      if (other.aborted) controller.abort();
      other.addEventListener("abort", onFollow, { once: true });
      followed.push(other);
    },
    stop() {
      process.off("SIGINT", onSigint);
      for (const other of followed) other.removeEventListener("abort", onFollow);
    },
  };
}

function headlessUsage(command: "prepare" | "run" | "compare"): string {
  if (command === "prepare") return "Usage: reprise prepare (--source-root <dir> --task-case <file.json> | --source-product <id> --source-path <path> [--source-root <dir>]) [--data-dir <dir>] [--json|--jsonl]";
  if (command === "compare") return "Usage: reprise compare (--experiment <id> [--run <runId>] | --source-root <dir> --task-case <file.json>) [--data-dir <dir>] [--json|--jsonl]";
  return "Usage: reprise run (--source-root <dir> --task-case <file.json> | --scenario <experimentId>) [--data-dir <dir>] [--product <id> --model <id>] [--compare] [--json|--jsonl]";
}

async function resolvePrepareSource(values: { "source-root"?: string; "task-case"?: string; "source-path"?: string; "source-product"?: string }, dataDir: string): Promise<{ taskCase: TaskCase; sourceRoot: string }> {
  if (values["task-case"] && values["source-root"]) {
    return { taskCase: await readTaskCase(values["task-case"]), sourceRoot: resolve(values["source-root"]) };
  }
  if (!values["source-product"] || !values["source-path"]) throw new CliError("usage", headlessUsage("prepare"));
  const frozen = await importSourceSession({ productId: values["source-product"], dataDir, sourcePath: values["source-path"] });
  const inspected = values["source-root"] ? undefined : await inspectSourceSession({ productId: values["source-product"], dataDir, sourcePath: values["source-path"] });
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
