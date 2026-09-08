import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CLI_EXIT, exitCodeForKind } from "../core/cli-protocol.js";
import { classifyCliError, CliError } from "../application/cli-error.js";
import {
  emptyConfigDraft,
  listCandidateModels,
    listHistoryPage,
    listProducts,
    listSourceProjects,
    listSourceSessions,
    inspectSourceSession,
    importSourceSession,
    readAuthStatus,
  readPublicConfig,
  savePublicConfig,
} from "../application/experiment-queries.js";
import { readExperimentEvents } from "../application/experiment-event-read.js";
import { loadAndActivateProductPacks } from "../products/index.js";
import { parseSessionsDirs } from "./sessions-dirs.js";
import { errorBody, parseOutputMode, writeJsonResult, type ProtocolIo } from "./protocol.js";
import type { HarnessConfigDraft } from "../infrastructure/harness-model-config.js";

const common = {
  "data-dir": { type: "string" },
  "sessions-dir": { type: "string", multiple: true },
  json: { type: "boolean" },
  jsonl: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  limit: { type: "string" },
  cursor: { type: "string" },
} as const;

export async function runQueryCommand(command: string, args: readonly string[], io: ProtocolIo): Promise<number> {
  try {
    if (command === "config") return await runConfig(args, io);
    const values = parseArgs({ args: [...args], options: { ...common, product: { type: "string" }, project: { type: "string" }, "source-path": { type: "string" }, experiment: { type: "string" }, "from-sequence": { type: "string" } }, allowPositionals: false, strict: true }).values;
    if (values.help) {
      io.stdout(queryUsage(command));
      return CLI_EXIT.ok;
    }
    parseOutputMode(values);
    const dataDir = resolve(values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
    if (command !== "history" && command !== "events") await loadAndActivateProductPacks(dataDir);
    const sessionsRoots = parseSessionsDirs(values["sessions-dir"]);
    const limit = parseOptionalInt(values.limit, "limit");
    const data = await queryData(command, {
      dataDir,
      sessionsRoots,
      ...(values.product ? { product: values.product } : {}),
      ...(values.project ? { project: values.project } : {}),
      ...(values["source-path"] ? { "source-path": values["source-path"] } : {}),
      ...(values.experiment ? { experiment: values.experiment } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(values["from-sequence"] ? { "from-sequence": values["from-sequence"] } : {}),
    });
    writeJsonResult(io, { ok: true, command, data });
    return CLI_EXIT.ok;
  } catch (error: unknown) {
    const classified = classifyCliError(error);
    io.stderr(classified.message);
    writeJsonResult(io, { ok: false, command, error: errorBody(classified) });
    return exitCodeForKind(classified.kind);
  }
}

async function queryData(command: string, values: {
  dataDir: string;
  sessionsRoots: Record<string, string>;
  product?: string;
  project?: string;
  "source-path"?: string;
  experiment?: string;
  cursor?: string;
  limit?: number;
  "from-sequence"?: string;
}): Promise<unknown> {
  if (command === "products") return listProducts();
  if (command === "models") return { productId: requireProduct(values.product), models: await listCandidateModels(requireProduct(values.product)) };
  if (command === "projects") {
    const productId = requireProduct(values.product);
    return { productId, ...await listSourceProjects({
      productId, dataDir: values.dataDir, sessionsRoots: values.sessionsRoots,
      ...(values.limit !== undefined ? { limit: values.limit } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
    }) };
  }
  if (command === "sessions") {
    const productId = requireProduct(values.product);
    return { productId, ...await listSourceSessions({
      productId, dataDir: values.dataDir, sessionsRoots: values.sessionsRoots,
      ...(values.project ? { project: values.project } : {}),
      ...(values["source-path"] ? { sourcePath: values["source-path"] } : {}),
      ...(values.limit !== undefined ? { limit: values.limit } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
    }) };
  }
  if (command === "history") {
    return listHistoryPage({
      dataDir: values.dataDir,
      ...(values.limit !== undefined ? { limit: values.limit } : {}),
      ...(values.cursor ? { cursor: values.cursor } : {}),
    });
  }
  if (command === "events") {
    const experimentId = values.experiment;
    if (!experimentId) throw new CliError("usage", "Usage: reprise events --experiment <experimentId> [--from-sequence N] [--limit N]");
    const fromSequence = parseOptionalInt(values["from-sequence"], "from-sequence");
    return readExperimentEvents({
      dataDir: values.dataDir, experimentId,
      ...(fromSequence !== undefined ? { fromSequence } : {}),
      ...(values.limit !== undefined ? { limit: values.limit } : {}),
    });
  }
  if (command === "inspect") {
    const productId = requireProduct(values.product);
    const sourcePath = values["source-path"];
    if (!sourcePath) throw new CliError("usage", "Usage: reprise inspect --product <id> --source-path <path>");
    return inspectSourceSession({ productId, dataDir: values.dataDir, sourcePath, sessionsRoots: values.sessionsRoots });
  }
  if (command === "import") {
    const productId = requireProduct(values.product);
    const sourcePath = values["source-path"];
    if (!sourcePath) throw new CliError("usage", "Usage: reprise import --product <id> --source-path <path>");
    const frozen = await importSourceSession({ productId, dataDir: values.dataDir, sourcePath, sessionsRoots: values.sessionsRoots });
    return { caseId: frozen.taskCase.caseId, reused: frozen.reused, taskCasePath: join(values.dataDir, "cases", frozen.taskCase.caseId, "case.json") };
  }
  if (command === "auth") return readAuthStatus(values.dataDir, values.sessionsRoots);
  throw new CliError("usage", `Unknown command '${command}'.`);
}

async function runConfig(args: readonly string[], io: ProtocolIo): Promise<number> {
  const action = args[0];
  if (action === "set") return runConfigSet(args.slice(1), io);
  const values = parseArgs({ args: [...args.slice(action === "get" ? 1 : 0)], options: common, allowPositionals: false, strict: true }).values;
  if (values.help || action === undefined) {
    io.stdout("Usage: reprise config get|set [--data-dir <dir>]");
    return action === undefined ? CLI_EXIT.usage : CLI_EXIT.ok;
  }
  parseOutputMode(values);
  const dataDir = resolve(values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
  writeJsonResult(io, { ok: true, command: "config", data: await readPublicConfig(dataDir) });
  return CLI_EXIT.ok;
}

async function runConfigSet(args: readonly string[], io: ProtocolIo): Promise<number> {
  try {
    if (args.includes("--api-key") || args.some((item) => item.startsWith("--api-key="))) {
      throw new CliError("usage", "Do not pass API keys on the command line. Use --api-key-file or --key-ref env:NAME.");
    }
    const values = parseArgs({
      args: [...args],
      options: {
        ...common,
        kind: { type: "string" },
        "provider-id": { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        "base-url": { type: "string" },
        "api-key-file": { type: "string" },
        "key-ref": { type: "string" },
        api: { type: "string" },
      },
      allowPositionals: false,
      strict: true,
    }).values;
    parseOutputMode(values);
    const dataDir = resolve(values["data-dir"] ?? process.env.REPRISE_DATA_DIR ?? ".reprise");
    const saved = await savePublicConfig(dataDir, await draftFromFlags(values));
    writeJsonResult(io, { ok: true, command: "config", data: saved });
    return CLI_EXIT.ok;
  } catch (error: unknown) {
    const classified = classifyCliError(error);
    io.stderr(classified.message);
    writeJsonResult(io, { ok: false, command: "config", error: errorBody(classified) });
    return exitCodeForKind(classified.kind);
  }
}

async function draftFromFlags(values: {
  kind?: string;
  "provider-id"?: string;
  model?: string;
  effort?: string;
  "base-url"?: string;
  "api-key-file"?: string;
  "key-ref"?: string;
  api?: string;
}): Promise<HarnessConfigDraft> {
  const kind: HarnessConfigDraft["kind"] = values.kind === "openai-compatible" ? "openai-compatible" : "pi-catalog";
  const draft: HarnessConfigDraft = {
    ...emptyConfigDraft(),
    kind,
    providerId: values["provider-id"] ?? (kind === "pi-catalog" ? "openai-codex" : "openai-compatible"),
    modelId: values.model ?? "",
  };
  if (!values.model) throw new CliError("config_missing", "config set requires --model.");
  if (values.effort) draft.effort = values.effort as HarnessConfigDraft["effort"];
  if (kind === "pi-catalog") return draft;
  if (!values["base-url"]) throw new CliError("config_missing", "openai-compatible config requires --base-url.");
  draft.baseUrl = values["base-url"];
  if (values.api === "openai-responses" || values.api === "openai-completions") draft.api = values.api;
  if (values["key-ref"]) {
    draft.keyRef = values["key-ref"];
    return draft;
  }
  if (values["api-key-file"]) {
    draft.keyRef = (await readFile(values["api-key-file"], "utf8")).trim();
    return draft;
  }
  throw new CliError("config_missing", "openai-compatible config requires --api-key-file or --key-ref. Interactive login is `pi /login`.");
}

function requireProduct(productId: string | undefined): string {
  if (!productId) throw new CliError("usage", "This command requires --product <id>.");
  return productId;
}

function parseOptionalInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("usage", `${label} must be a positive integer.`);
  return parsed;
}

function queryUsage(command: string): string {
  if (command === "events") return "Usage: reprise events --experiment <experimentId> [--from-sequence N] [--limit N] [--json]";
  if (command === "models" || command === "projects" || command === "sessions") return `Usage: reprise ${command} --product <id> [--limit N] [--cursor <id>] [--json]`;
  return `Usage: reprise ${command} [--json]`;
}
