import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHarnessWorkflow } from "../application/experiment-workflow.js";
import { formatCancelResult, requestCancel } from "../application/experiment-cancel.js";
import { classifyCliError } from "../application/cli-error.js";
import { CLI_EXIT, exitCodeForKind } from "../core/cli-protocol.js";
import { runHeadlessCommand, type HeadlessContext } from "./headless.js";
import { runQueryCommand } from "./query.js";
import { loadAndActivateProductPacks } from "../products/index.js";
import { parseSessionsDirs } from "./sessions-dirs.js";
import { parseOutputMode, writeJsonResult } from "./protocol.js";

export { parseSessionsDirs };

const MIN_NODE = [22, 19, 0] as const;
const QUERY_COMMANDS = new Set(["products", "models", "projects", "sessions", "inspect", "import", "history", "events", "auth", "config"]);
const commandOptions = {
  "data-dir": { type: "string" },
  "sessions-dir": { type: "string", multiple: true },
  compare: { type: "boolean" },
  json: { type: "boolean" },
  jsonl: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type CommandValues = {
  readonly "data-dir"?: string;
  readonly "sessions-dir"?: string[];
  readonly compare?: boolean;
  readonly json?: boolean;
  readonly jsonl?: boolean;
  readonly help?: boolean;
  readonly version?: boolean;
};

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface CliContext extends HeadlessContext {
  readonly runTui?: (input: { dataDir: string; sessionsRoot: string; sessionsRoots: Readonly<Record<string, string>>; now?: string; autoCompare?: boolean }) => Promise<void>;
}

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const actual = version.split(".").map(Number);
  let supported = true;
  for (let index = 0; index < MIN_NODE.length; index += 1) {
    const minimum = MIN_NODE[index] ?? 0;
    const difference = (actual[index] ?? 0) - minimum;
    if (difference !== 0) {
      supported = difference > 0;
      break;
    }
  }
  if (!supported) throw new Error(`Reprise requires Node.js >= ${MIN_NODE.join(".")}; found ${version}.`);
}

export function helpText(): string {
  return [
    "Reprise — local-first agent runtime replay and inspection",
    "",
    "Usage:",
    "  reprise [--data-dir <dir>] [--sessions-dir <productId>=<path>] [--compare]",
    "  reprise products|models|projects|sessions|inspect|import|history|events|auth [--json]",
    "  reprise config get|set [--json]",
    "  reprise prepare (--source-root <dir> --task-case <file.json> | --product <id> --source-path <path>) [--json|--jsonl]",
    "  reprise run (--source-root <dir> --task-case <file.json> | --scenario <experimentId>) [--json|--jsonl]",
    "  reprise compare (--experiment <id> | --source-root <dir> --task-case <file.json>) [--json|--jsonl]",
    "  reprise cancel <operationId|experimentId|runId> [--data-dir <dir>] [--json]",
    "  reprise [--help] [--version]",
    "",
    "No subcommand opens the TUI. `--compare` on that entry skips the TUI comparison gate; it is not the `compare` subcommand.",
    "Query and mutate subcommands do not load TUI components. `--json` and `--jsonl` are mutually exclusive.",
    "Do not pass API keys as command-line arguments. Use --api-key-file or --key-ref env:NAME.",
    "Ambiguous sources are selected with --source-path, not titles or list indexes.",
  ].join("\n");
}

export async function runCli(argv: readonly string[] = process.argv.slice(2), io: CliIo = defaultIo(), context: CliContext = {}): Promise<number> {
  try {
    assertSupportedNodeVersion();
    const command = argv[0];
    if (command === "cancel") return await runCancel(argv.slice(1), io);
    if (command && QUERY_COMMANDS.has(command)) return await runQueryCommand(command, argv.slice(1), io);
    if (command === "prepare" || command === "run" || command === "compare") {
      return await runHeadlessCommand(command, argv.slice(1), io, context);
    }
    const values = parseCommandArgs(argv);
    if (values.help) {
      io.stdout(helpText());
      return CLI_EXIT.ok;
    }
    if (values.version) {
      io.stdout(versionText());
      return CLI_EXIT.ok;
    }
    parseOutputMode(values);
    const dataDir = values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise";
    const sessionsRoots = parseSessionsDirs(values["sessions-dir"]);
    await loadAndActivateProductPacks(resolve(dataDir));
    await (context.runTui ?? runBenchmarkWorkbenchTui)({
      dataDir,
      sessionsRoot: "",
      sessionsRoots,
      ...(values.compare ? { autoCompare: true } : {}),
      ...(context.now ? { now: context.now } : {}),
    });
    io.stdout("TUI closed.");
    return CLI_EXIT.ok;
  } catch (error: unknown) {
    const classified = classifyCliError(error);
    io.stderr(`Error: ${classified.message}`);
    return exitCodeForKind(classified.kind);
  }
}

async function runBenchmarkWorkbenchTui(input: { dataDir: string; sessionsRoot: string; sessionsRoots: Readonly<Record<string, string>>; now?: string; autoCompare?: boolean }): Promise<void> {
  const { CodexIntakeTui } = await import("../tui/intake-app.js");
  const dataDir = resolve(input.dataDir);
  await new CodexIntakeTui({
    dataDir,
    sessionsRoot: input.sessionsRoot,
    sessionsRoots: input.sessionsRoots,
    workflow: createHarnessWorkflow({ dataDir, now: input.now ? () => input.now! : () => new Date().toISOString() }),
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    now: input.now ? () => input.now! : () => new Date().toISOString(),
    ...(input.autoCompare ? { autoCompare: true } : {}),
  }).run();
}

async function runCancel(args: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    options: { json: { type: "boolean" }, "data-dir": { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const json = parsed.values.json === true;
  const id = parsed.positionals[0];
  if (!id || parsed.positionals.length !== 1) {
    io.stderr("Usage: reprise cancel <operationId|experimentId|runId> [--data-dir <dir>] [--json]");
    if (json) writeJsonResult(io, { ok: false, command: "cancel", error: { kind: "usage", message: "Usage: reprise cancel <operationId|experimentId|runId>" } });
    return CLI_EXIT.usage;
  }
  const dataDir = resolve(parsed.values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
  const result = await requestCancel(id, dataDir);
  if (json) writeJsonResult(io, { ok: cancelJsonOk(result.status), command: "cancel", data: publicCancelData(result) });
  else io.stdout(formatCancelResult(result));
  if (result.status === "invalid") return CLI_EXIT.usage;
  if (result.status === "unknown" || result.status === "unreachable") return CLI_EXIT.not_found;
  if (result.status === "auth_failed") return CLI_EXIT.failed;
  if (result.status === "timeout") return CLI_EXIT.timeout;
  return CLI_EXIT.ok;
}

function cancelJsonOk(status: string): boolean {
  return status === "accepted" || status === "cancel_requested" || status === "already_finished";
}

function publicCancelData(result: Awaited<ReturnType<typeof requestCancel>>): unknown {
  if ("activity" in result) {
    const { activity, status } = result;
    return {
      status,
      kind: activity.kind,
      operationId: activity.operationId,
      experimentId: activity.experimentId,
      runId: activity.runId,
    };
  }
  return { status: result.status, id: result.id };
}

function parseCommandArgs(args: readonly string[]): CommandValues {
  return parseArgs({ args: [...args], options: commandOptions, allowPositionals: false, strict: true }).values;
}

function defaultIo(): CliIo {
  return { stdout: console.log, stderr: console.error };
}

function versionText(): string {
  return `reprise ${process.env.npm_package_version ?? "0.1.0"} (Node.js ${process.versions.node})`;
}

if (import.meta.main) process.exitCode = await runCli();
