import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { writeAtomic } from "../core/identity.js";
import {
  journalControlledRecoveryWrite,
  type RecoveryControlledWriteHook,
} from "./recovery-write-journal.js";
import type { AgentToolDefinition } from "./pi-agent-host.js";
import { runProcess } from "./process-runner.js";
import {
  chargeRecoveryToolBudget,
  noteDestructiveRecoveryCall,
} from "./recovery-tool-budget.js";
import { integer, requiredString } from "./recovery-tools.js";

const MAX_BYTES = 262_144;
const DEFAULT_READ_BYTES = 65_536;
const MAX_LIST_ENTRIES = 256;
const MAX_COMMAND_BYTES = 32_768;
const MAX_GREP_MATCHES = 64;
const RECOVERY_SHELL_TIMEOUT_MS = 60_000;
const HOST_RESERVED = new Set(["recovery-manifest.json"]);

export type RecoveryToolOperation = {
  operation: "workspace_tree" | "directory_list" | "file_read";
  availability: "available" | "unavailable";
  attempts: 1 | 2;
  reason?: "filesystem_error";
};
type RecoveryDirectoryEntry = {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
};
export type RecoveryToolFilesystem = {
  readDirectory?: (path: string) => Promise<readonly RecoveryDirectoryEntry[]>;
  readRegularFile?: (path: string) => Promise<Buffer>;
};
export type RecoveryToolOptions = {
  shellTimeoutMs?: number;
  shellExecutable?: string;
  homeRoot?: string;
  allowShell?: boolean;
  onBudgetExhausted?: (category: "budget_exhausted") => void;
  onControlledWrite?: RecoveryControlledWriteHook;
  onOperation?: (operation: RecoveryToolOperation) => Promise<void>;
  filesystem?: RecoveryToolFilesystem;
};

type RecoveryToolContext = {
  root: string;
  options: RecoveryToolOptions;
  limit: <T>(fn: () => Promise<T>) => () => Promise<T>;
  boundedRead: <T>(
    operation: RecoveryToolOperation["operation"],
    read: () => Promise<T>,
  ) => Promise<T | undefined>;
  ensureHome: () => Promise<string>;
  readDirectory: NonNullable<RecoveryToolFilesystem["readDirectory"]>;
  readRegularFile: NonNullable<RecoveryToolFilesystem["readRegularFile"]>;
};

function createRecoveryToolContext(
  stagingRoot: string,
  options: RecoveryToolOptions,
): RecoveryToolContext {
  const root = resolve(stagingRoot);
  let homeReady: Promise<string> | undefined;
  const limit = <T>(fn: () => Promise<T>) => fn;
  const homeRoot = options.homeRoot
    ? resolve(options.homeRoot)
    : resolve(root, ".reprise-recovery-home");
  const ensureHome = async (): Promise<string> => {
    homeReady ??= mkdir(homeRoot, { recursive: true }).then(() => homeRoot);
    return homeReady;
  };
  const readDirectory: NonNullable<RecoveryToolFilesystem["readDirectory"]> =
    options.filesystem?.readDirectory ??
    ((path: string) => readdir(path, { withFileTypes: true }));
  const readRegularFile: NonNullable<RecoveryToolFilesystem["readRegularFile"]> =
    options.filesystem?.readRegularFile ?? ((path: string) => readFile(path));
  const boundedRead = async <T>(
    operation: RecoveryToolOperation["operation"],
    read: () => Promise<T>,
  ): Promise<T | undefined> => {
    for (const attempt of [1, 2] as const) {
      try {
        const value = await read();
        await options.onOperation?.({ operation, availability: "available", attempts: attempt });
        return value;
      } catch (error) {
        if (recoveryReadBoundaryError(error)) throw error;
        if (attempt === 2)
          await options.onOperation?.({
            operation,
            availability: "unavailable",
            attempts: attempt,
            reason: "filesystem_error",
          });
      }
    }
    return undefined;
  };
  return { root, options, limit, boundedRead, ensureHome, readDirectory, readRegularFile };
}

function decorateRecoveryTools(
  tools: readonly AgentToolDefinition[],
  options: RecoveryToolOptions,
  maxToolCalls: number,
): readonly AgentToolDefinition[] {
  const seen = new Set<string>();
  let mutationVersion = 0;
  const budget = { investigationCalls: 0, completionCalls: 0, deleteCalls: 0 };
  const completionTools = new Set<string>();
  const mutatingTools = new Set(["write", "edit", "powershell"]);
  return tools.map((tool) => ({
    ...tool,
    execute: async (params: unknown, signal: AbortSignal) => {
      chargeRecoveryToolBudget(
        tool.name,
        budget,
        maxToolCalls,
        completionTools,
        options.onBudgetExhausted,
        params,
      );
      const key = `${mutationVersion}:${tool.name}:${JSON.stringify(params)}`;
      if (seen.has(key)) throw new Error("recovery_no_information_gain: repeated tool call with identical inputs.");
      seen.add(key);
      const result = await tool.execute(params, signal);
      noteDestructiveRecoveryCall(tool.name, params, budget);
      if (mutatingTools.has(tool.name)) mutationVersion += 1;
      return result;
    },
  }));
}

export function recoveryTools(
  stagingRoot: string,
  maxToolCalls = 64,
  options: RecoveryToolOptions = {},
): readonly AgentToolDefinition[] {
  const ctx = createRecoveryToolContext(stagingRoot, options);
  return decorateRecoveryTools(
    [
      lsTool(ctx),
      readTool(ctx),
      grepTool(ctx),
      findTool(ctx),
      editTool(ctx),
      writeTool(ctx),
      powershellTool(ctx),
    ],
    options,
    maxToolCalls,
  );
}

function lsTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, limit, boundedRead, readDirectory } = ctx;
  return {
    name: "ls",
    description: "List a bounded directory within staging. Paths must be relative.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ maxLength: 512 })),
      depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { path?: unknown; depth?: unknown };
        const requestedPath = value.path === undefined ? "" : requiredString(value.path, "path");
        const path = requestedPath ? pathIn(root, requestedPath) : { absolute: root, relative: "" };
        const depth = value.depth === undefined ? 1 : integer(value.depth, undefined, "depth", 0, 4);
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(root, path.absolute);
          return listTree(root, path.relative, depth, readDirectory);
        });
        return directoryReadResult(path.relative || ".", entries);
      })(),
  };
}

function readTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, limit, boundedRead, readRegularFile } = ctx;
  return {
    name: "read",
    description: "Read a bounded byte range from a regular staging file.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BYTES })),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { path?: unknown; offset?: unknown; maxBytes?: unknown };
        const path = pathIn(root, requiredString(value.path, "path"));
        if (isSensitiveRecoveryPath(path.relative))
          throw recoveryToolError("credential_read_denied", "Known credential files are not readable by the Recovery model.", {
            path: "<credential-file>",
          });
        const offset = integer(value.offset, 0, "offset");
        const maxBytes =
          value.maxBytes === undefined ? DEFAULT_READ_BYTES : integer(value.maxBytes, undefined, "maxBytes", 1, MAX_BYTES);
        const bytes = await boundedRead("file_read", async () => {
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertRegular(path.absolute);
          return readRegularFile(path.absolute);
        });
        if (!bytes) return unavailableFileReadResult(path.relative, offset);
        const slice = bytes.subarray(offset, offset + maxBytes);
        return {
          content: slice.toString("utf8"),
          details: {
            path: path.relative,
            offset,
            available: true,
            truncated: offset + slice.length < bytes.length,
            ...(offset + slice.length < bytes.length ? { nextCursor: offset + slice.length } : {}),
          },
        };
      })(),
  };
}

function grepTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, limit, boundedRead, readDirectory, readRegularFile } = ctx;
  return {
    name: "grep",
    description: "Search file contents in staging; returns a bounded list of path:line matches.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 256 }),
      path: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { query?: unknown; path?: unknown };
        const query = requiredString(value.query, "query");
        const requested = value.path === undefined ? "" : requiredString(value.path, "path");
        const start = requested ? pathIn(root, requested) : { absolute: root, relative: "" };
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(root, start.absolute);
          return listTree(root, start.relative, 4, readDirectory);
        });
        const matches: string[] = [];
        for (const entry of entries ?? []) {
          if (!entry.startsWith("file ") || matches.length >= MAX_GREP_MATCHES) continue;
          const relativePath = entry.slice(5);
          if (isSensitiveRecoveryPath(relativePath) || HOST_RESERVED.has(basename(relativePath))) continue;
          const absolute = pathIn(root, relativePath).absolute;
          const bytes = await boundedRead("file_read", async () => {
            await assertRegular(absolute);
            return readRegularFile(absolute);
          });
          if (!bytes) continue;
          const text = bytes.subarray(0, MAX_BYTES).toString("utf8");
          if (text.includes("\u0000")) continue;
          for (const [index, line] of text.split(/\r?\n/).entries()) {
            if (line.includes(query)) {
              matches.push(`${relativePath}:${index + 1}:${line.slice(0, 200)}`);
              if (matches.length >= MAX_GREP_MATCHES) break;
            }
          }
        }
        return {
          content: JSON.stringify(matches),
          details: { query, returned: matches.length, truncated: matches.length >= MAX_GREP_MATCHES },
        };
      })(),
  };
}

function findTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, limit, boundedRead, readDirectory } = ctx;
  return {
    name: "find",
    description: "Find staging paths whose names contain a bounded substring.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 256 }),
      path: Type.Optional(Type.String({ maxLength: 512 })),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { name?: unknown; path?: unknown };
        const needle = requiredString(value.name, "name").toLowerCase();
        const requested = value.path === undefined ? "" : requiredString(value.path, "path");
        const start = requested ? pathIn(root, requested) : { absolute: root, relative: "" };
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(root, start.absolute);
          return listTree(root, start.relative, 4, readDirectory);
        });
        const hits = (entries ?? [])
          .map((entry) => entry.replace(/^(?:file|directory|other) /, ""))
          .filter((path) => path.toLowerCase().includes(needle))
          .slice(0, MAX_LIST_ENTRIES);
        return {
          content: JSON.stringify(hits),
          details: { returned: hits.length, truncated: hits.length >= MAX_LIST_ENTRIES },
        };
      })(),
  };
}

function editTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, options, limit } = ctx;
  return {
    name: "edit",
    description: "Replace one exact text span in an existing staging file.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      oldText: Type.String({ minLength: 1, maxLength: MAX_BYTES }),
      newText: Type.String({ maxLength: MAX_BYTES }),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { path?: unknown; oldText?: unknown; newText?: unknown };
        const path = pathIn(root, requiredString(value.path, "path"));
        if (HOST_RESERVED.has(basename(path.relative)))
          throw recoveryToolError("recovery_sink_reserved", "Host-owned contract files cannot be edited.", {
            path: "notes.txt",
          });
        const oldText = requiredString(value.oldText, "oldText");
        const newText = requiredString(value.newText, "newText");
        await assertNoSymlinkAncestors(root, path.absolute);
        await assertRegular(path.absolute);
        const current = await readFile(path.absolute, "utf8");
        const index = current.indexOf(oldText);
        if (index < 0) throw new Error("oldText was not found in the file.");
        if (current.indexOf(oldText, index + 1) >= 0) throw new Error("oldText matches more than once; make it unique.");
        const next = `${current.slice(0, index)}${newText}${current.slice(index + oldText.length)}`;
        if (Buffer.byteLength(next) > MAX_BYTES) throw new Error(`content exceeds ${MAX_BYTES} bytes.`);
        await journalControlledRecoveryWrite(
          {
            tool: "edit",
            relativePath: path.relative,
            absolutePath: path.absolute,
            write: () => writeAtomic(path.absolute, next),
          },
          options.onControlledWrite,
        );
        return { content: "Edited file.", details: { path: path.relative, byteLength: Buffer.byteLength(next) } };
      })(),
  };
}

function writeTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, options, limit } = ctx;
  return {
    name: "write",
    description: "Create or overwrite one explicit regular file in staging. recovery.md is the report sink.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      content: Type.String({ maxLength: MAX_BYTES }),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { path?: unknown; content?: unknown };
        const path = pathIn(root, requiredString(value.path, "path"));
        if (HOST_RESERVED.has(basename(path.relative)) && !path.relative.includes("/"))
          throw recoveryToolError("recovery_sink_reserved", "recovery-manifest.json is Host-owned.", {
            path: "notes.txt",
            content: "text",
          });
        const content = requiredString(value.content, "content");
        if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`content exceeds ${MAX_BYTES} bytes.`);
        await assertNoSymlinkAncestors(root, path.absolute);
        await assertWritableFile(path.absolute);
        await mkdir(resolve(path.absolute, ".."), { recursive: true });
        await journalControlledRecoveryWrite(
          {
            tool: "write",
            relativePath: path.relative,
            absolutePath: path.absolute,
            write: () => writeAtomic(path.absolute, content),
          },
          options.onControlledWrite,
        );
        return {
          content: `Wrote ${Buffer.byteLength(content)} bytes.`,
          details: { path: path.relative, byteLength: Buffer.byteLength(content) },
        };
      })(),
  };
}

function powershellTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, options, limit, ensureHome } = ctx;
  return {
    name: "powershell",
    description:
      "Run one PowerShell command with cwd locked to staging. Network is open; credentials and global configuration are not provided.",
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_BYTES }),
    }),
    execute: async (params, signal) =>
      limit(async () => {
        const command = requiredString((params as { command?: unknown }).command, "command");
        if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
          throw new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes.`);
        assertShellCommandDoesNotTargetSensitiveFiles(command);
        const home = await ensureHome();
        return runShell(
          root,
          home,
          command,
          signal,
          options.shellTimeoutMs ?? RECOVERY_SHELL_TIMEOUT_MS,
          options.shellExecutable,
        );
      })(),
  };
}

function isSensitiveRecoveryPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === "auth.json" ||
    name === ".credentials.json" ||
    name === "credentials.json" ||
    /\.(pem|key|p12|pfx)$/.test(name) ||
    name.includes("credential")
  );
}

function recoveryToolError(code: string, detail: string, example: unknown): Error {
  return new Error(`${code}: ${detail} Example: ${JSON.stringify(example)}`);
}

function assertShellCommandDoesNotTargetSensitiveFiles(command: string): void {
  if (
    /(?:^|[\s"'/\\])(?:\.env(?:\.[A-Za-z0-9_-]+)?|auth\.json|credentials?\.json|[^\s"'/\\]*credential[^\s"'/\\]*|[^\s"'/\\]+\.(?:pem|key|p12|pfx))(?:$|[\s"'/\\])/i.test(
      command,
    )
  )
    throw new Error("credential_read_denied: sensitive file category.");
}

function runShell(
  root: string,
  home: string,
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
  executableOverride?: string,
): Promise<{ content: string; details: Record<string, unknown> }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Shell timeout must be a positive integer.");
  const windows = process.platform === "win32";
  const powershell = executableOverride ?? "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  return runProcess({
    operation: "powershell",
    executableKind: windows ? "powershell_7" : "shell",
    command: windows ? powershell : command,
    args: windows
      ? ["-NoProfile", "-NonInteractive", "-Command", "Invoke-Expression $env:REPRISE_RECOVERY_COMMAND; exit $LASTEXITCODE"]
      : [],
    cwd: root,
    env: windows ? { ...sanitizedEnvironment(home), REPRISE_RECOVERY_COMMAND: command } : sanitizedEnvironment(home),
    shell: !windows,
    allowNonzeroExit: windows,
    killTree: true,
    signal,
    timeoutMs,
    maxOutputBytes: MAX_BYTES,
    truncateOutput: true,
  }).then((result) => {
    const content = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n");
    return {
      content: content || "ok",
      details: {
        command: redactCommand(command),
        cwd: ".",
        exitCode: result.exitCode,
        stdoutBytes: Buffer.byteLength(result.stdout),
        stderrBytes: Buffer.byteLength(result.stderr),
        truncated: result.outputTruncated,
        networkAccess: looksLikeNetworkCommand(command),
      },
    };
  });
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "USER",
    "USERNAME",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && (allowed.has(key) || key.startsWith("LC_"))) env[key] = value;
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = home;
  env.APPDATA = home;
  env.LOCALAPPDATA = home;
  env.GIT_CONFIG_GLOBAL = resolve(home, "gitconfig");
  env.GIT_CONFIG_SYSTEM = resolve(home, "missing-system-gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function redactCommand(command: string): string {
  return command
    .replace(/(authorization\s*[=:]\s*)(?:"?)(?:Bearer\s+)?[^\s"]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}

function looksLikeNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget|fetch|invoke-webrequest|iwr|git\s+(?:clone|fetch|pull|ls-remote)|npm\s+(?:install|view|pack)|pnpm\s+(?:install|fetch)|yarn\s+(?:install|add)|pip\s+install)\b/i.test(
    command,
  );
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget))
    throw new Error("Path escapes staging.");
  let current = resolvedRoot;
  for (const part of relativeTarget.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not supported in staging.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function pathIn(root: string, input: string): { absolute: string; relative: string } {
  if (!input || isAbsolute(input) || input.includes("\\") || input.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Path must be a non-empty slash-separated relative path without . or ...");
  const absolute = resolve(root, ...input.split("/"));
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes staging.");
  return { absolute, relative: rel.replaceAll("\\", "/") };
}

function recoveryReadBoundaryError(error: unknown): boolean {
  return error instanceof Error && /symbolic link|regular file/i.test(error.message);
}

function directoryReadResult(
  path: string,
  entries: string[] | undefined,
): { content: string; details: Record<string, unknown> } {
  if (!entries) return { content: "[]", details: { path, available: false, reason: "filesystem_error" } };
  return {
    content: JSON.stringify(entries.slice(0, MAX_LIST_ENTRIES)),
    details: {
      path,
      available: true,
      returned: Math.min(entries.length, MAX_LIST_ENTRIES),
      truncated: entries.length > MAX_LIST_ENTRIES,
    },
  };
}

function unavailableFileReadResult(path: string, offset: number): { content: string; details: Record<string, unknown> } {
  return { content: "", details: { path, offset, available: false, reason: "filesystem_error" } };
}

async function listTree(
  root: string,
  prefix: string,
  depth: number,
  readDirectory: NonNullable<RecoveryToolFilesystem["readDirectory"]>,
): Promise<string[]> {
  const current = prefix ? resolve(root, ...prefix.split("/")) : root;
  const entries = await readDirectory(current);
  const output: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link encountered: ${relativePath}`);
    output.push(`${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"} ${relativePath}`);
    if (entry.isDirectory() && depth > 0 && output.length < MAX_LIST_ENTRIES)
      output.push(...(await listTree(root, relativePath, depth - 1, readDirectory)));
  }
  return output;
}

async function assertRegular(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Path must name a regular file.");
}

async function assertWritableFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Path must name a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
