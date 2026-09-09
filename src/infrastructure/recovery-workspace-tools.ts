import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { writeAtomic } from "../core/identity.js";
import { pathContainedBy, relativeInside, stripWindowsExtendedPrefix } from "../core/paths.js";
import {
  journalControlledRecoveryWrite,
  type RecoveryControlledWriteHook,
} from "./recovery-write-journal.js";
import type { AgentToolDefinition } from "./agent/host.js";
import { ProcessBoundaryError, runProcess, type ProcessSpawner } from "./process-runner.js";
import { shellExecutableAvailable, shellInvocation } from "./platform.js";
import { integer, requiredString } from "./recovery-tools.js";

const MAX_BYTES = 262_144;
const DEFAULT_READ_BYTES = 65_536;
const MAX_LIST_ENTRIES = 256;
const MAX_COMMAND_BYTES = 32_768;
const MAX_GREP_MATCHES = 64;
const RECOVERY_SHELL_TIMEOUT_MS = 60_000;
/** CreateProcess lpCurrentDirectory; Node fs can still create longer staging roots. */
const WINDOWS_CREATEPROCESS_CWD_LIMIT = 248;
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;
const POWERSHELL_UTF8_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const LONG_CWD_POWERSHELL =
  "Set-Location -LiteralPath $env:REPRISE_RECOVERY_CWD; Invoke-Expression $env:REPRISE_RECOVERY_COMMAND; exit $LASTEXITCODE";
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
  onControlledWrite?: RecoveryControlledWriteHook;
  onOperation?: (operation: RecoveryToolOperation) => Promise<void>;
  filesystem?: RecoveryToolFilesystem;
  /** First path segment → absolute tree. Writes to these mounts are denied. */
  mounts?: Readonly<Record<string, string>>;
  allowWrite?: (relativePath: string) => boolean;
  completionPaths?: ReadonlySet<string>;
  denyDestructiveOnPrefix?: readonly string[];
  findExecutableOnPath?: (name: string) => string | undefined;
  spawnProcess?: ProcessSpawner;
  /** When set, shell_exec cwd is this directory instead of `root`. */
  shellCwd?: string;
  /** Explicit task-scoped variables added after environment sanitization. */
  shellEnv?: Readonly<Record<string, string>>;
  /** Whether this role may send file bytes to the model as native image blocks. */
  allowBinary?: boolean;
};

type RecoveryToolContext = {
  root: string;
  options: RecoveryToolOptions;
  mounts: Readonly<Record<string, string>>;
  completionPaths: ReadonlySet<string>;
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
  return { root, options, mounts: options.mounts ?? {}, completionPaths: options.completionPaths ?? new Set(["recovery.md"]), limit, boundedRead, ensureHome, readDirectory, readRegularFile };
}

export function recoveryTools(
  stagingRoot: string,
  options: RecoveryToolOptions = {},
): readonly AgentToolDefinition[] {
  const ctx = createRecoveryToolContext(stagingRoot, options);
  return [
    lsTool(ctx),
    readTool(ctx),
    grepTool(ctx),
    findTool(ctx),
    editTool(ctx),
    writeTool(ctx),
    powershellTool(ctx),
  ];
}

function lsTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { root, limit, boundedRead } = ctx;
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
        const path = value.path === undefined ? { absolute: root, relative: "", writable: true, containmentRoot: root } : pathIn(ctx, requiredString(value.path, "path"));
        const depth = value.depth === undefined ? 1 : integer(value.depth, undefined, "depth", 0, 4);
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(path.containmentRoot, path.absolute);
          return listTree(ctx, path.relative, depth);
        });
        return directoryReadResult(path.relative || ".", entries);
      })(),
  };
}

function readTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { limit, boundedRead, readRegularFile } = ctx;
  return {
    name: "read",
    description: "Read a bounded byte range from a regular file, or return the whole file as a native Pi image block when format=image is authorized.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_BYTES })),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")])),
      mimeType: Type.Optional(Type.String({ pattern: "^image/[A-Za-z0-9.+-]+$" })),
    }),
    execute: async (params) =>
      limit(async () => {
        const value = params as { path?: unknown; offset?: unknown; maxBytes?: unknown; format?: unknown; mimeType?: unknown };
        const path = pathIn(ctx, requiredString(value.path, "path"));
        if (isSensitiveRecoveryPath(path.relative))
          throw recoveryToolError("credential_read_denied", "Known credential files are not readable by the Recovery model.", {
            path: "<credential-file>",
          });
        const offset = integer(value.offset, 0, "offset");
        const maxBytes =
          value.maxBytes === undefined ? DEFAULT_READ_BYTES : integer(value.maxBytes, undefined, "maxBytes", 1, MAX_BYTES);
        const bytes = await boundedRead("file_read", async () => {
          await assertNoSymlinkAncestors(path.containmentRoot, path.absolute);
          await assertRegular(path.absolute);
          return readRegularFile(path.absolute);
        });
        if (!bytes) return unavailableFileReadResult(path.relative, offset);
        if (value.format === "image") {
          if (!ctx.options.allowBinary) throw new Error("binary_read_denied: image content is not authorized for this task.");
          if (offset !== 0 || bytes.length > maxBytes) throw new Error(`image_read_requires_whole_file: image must fit within ${maxBytes} bytes.`);
          const mimeType = requiredString(value.mimeType, "mimeType");
          if (!/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)) throw new Error("mimeType must be an image media type.");
          return {
            content: `Image ${path.relative} (${mimeType}, ${bytes.length} bytes).`,
            contentBlocks: [{ type: "text" as const, text: `Image ${path.relative}.` }, { type: "image" as const, data: bytes.toString("base64"), mimeType }],
            details: { path: path.relative, offset: 0, available: true, mediaType: mimeType, byteLength: bytes.length, truncated: false },
          };
        }
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
  const { root, limit, boundedRead, readRegularFile } = ctx;
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
        const start = requested ? pathIn(ctx, requested) : { absolute: root, relative: "", containmentRoot: root, writable: true };
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(start.containmentRoot, start.absolute);
          return listTree(ctx, start.relative, 4);
        });
        const matches: string[] = [];
        for (const entry of entries ?? []) {
          if (!entry.startsWith("file ") || matches.length >= MAX_GREP_MATCHES) continue;
          const relativePath = entry.slice(5);
          if (isSensitiveRecoveryPath(relativePath) || HOST_RESERVED.has(basename(relativePath))) continue;
          const absolute = pathIn(ctx, relativePath).absolute;
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
  const { root, limit, boundedRead } = ctx;
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
        const start = requested ? pathIn(ctx, requested) : { absolute: root, relative: "", containmentRoot: root, writable: true };
        const entries = await boundedRead("directory_list", async () => {
          await assertNoSymlinkAncestors(start.containmentRoot, start.absolute);
          return listTree(ctx, start.relative, 4);
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
  const { options, limit } = ctx;
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
        const path = pathIn(ctx, requiredString(value.path, "path"));
        assertWritablePath(ctx, path);
        if (HOST_RESERVED.has(basename(path.relative)))
          throw recoveryToolError("recovery_sink_reserved", "Host-owned contract files cannot be edited.", {
            path: "notes.txt",
          });
        const oldText = requiredString(value.oldText, "oldText");
        const newText = requiredString(value.newText, "newText");
        await assertNoSymlinkAncestors(path.containmentRoot, path.absolute);
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
        await assertStillInside(path.containmentRoot, path.absolute);
        return { content: "Edited file.", details: { path: path.relative, byteLength: Buffer.byteLength(next) } };
      })(),
  };
}

function writeTool(ctx: RecoveryToolContext): AgentToolDefinition {
  const { options, limit } = ctx;
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
        const path = pathIn(ctx, requiredString(value.path, "path"));
        assertWritablePath(ctx, path);
        if (HOST_RESERVED.has(basename(path.relative)) && !path.relative.includes("/"))
          throw recoveryToolError("recovery_sink_reserved", "recovery-manifest.json is Host-owned.", {
            path: "notes.txt",
            content: "text",
          });
        const content = requiredString(value.content, "content");
        if (Buffer.byteLength(content) > MAX_BYTES) throw new Error(`content exceeds ${MAX_BYTES} bytes.`);
        await assertNoSymlinkAncestors(path.containmentRoot, path.absolute);
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
        await assertStillInside(path.containmentRoot, path.absolute);
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
    name: "shell_exec",
    description: shellExecDescription(ctx),
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_BYTES }),
    }),
    execute: async (params, signal) =>
      limit(async () => {
        const command = requiredString((params as { command?: unknown }).command, "command");
        if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
          throw new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes.`);
        assertShellCommandDoesNotTargetSensitiveFiles(command);
        assertShellDoesNotMutateReadonlyMount(ctx, command);
        const cwd = options.shellCwd ?? root;
        if (!existsSync(cwd)) throw new Error("Working directory does not exist. Cannot execute PowerShell commands.");
        const home = await ensureHome();
        return runShell(cwd, home, command, signal, options);
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
  options: RecoveryToolOptions,
): Promise<{ content: string; details: Record<string, unknown> }> {
  const timeoutMs = options.shellTimeoutMs ?? RECOVERY_SHELL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Shell timeout must be a positive integer.");
  if (!existsSync(root)) throw new Error("Working directory does not exist. Cannot execute PowerShell commands.");
  const windows = process.platform === "win32";
  const resolved = windows
    ? resolveWindowsPowershell(options.shellExecutable, options.findExecutableOnPath)
    : undefined;
  if (windows && !resolved) {
    throw new Error("ENOENT: PowerShell executable was not found (未找到 PowerShell).");
  }
  const invocation = windows ? windowsPowershellInvocation(root, command) : undefined;
  const portableShell = windows ? undefined : shellInvocation(command);
  if (!windows && portableShell && !shellExecutableAvailable(portableShell)) {
    throw new Error("ENOENT: Bash executable was not found (未找到 Bash).");
  }
  return runProcess({
    operation: "shell_exec",
    executableKind: windows ? resolved!.kind : portableShell!.kind,
    command: windows ? resolved!.executable : portableShell!.executable,
    args: windows ? invocation!.args : portableShell!.args,
    cwd: windows ? invocation!.spawnCwd : root,
    env: { ...sanitizedEnvironment(home), ...options.shellEnv, ...(windows ? invocation!.extraEnv : {}) },
    allowNonzeroExit: windows,
    killTree: true,
    signal,
    timeoutMs,
    maxOutputBytes: MAX_BYTES,
    truncateOutput: true,
    ...(options.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
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
  }).catch((error) => {
    if (error instanceof ProcessBoundaryError) throw formatShellBoundary(error, windows, windows ? resolved?.executable : portableShell?.executable);
    throw error;
  });
}

function windowsPowershellInvocation(
  stagingRoot: string,
  command: string,
): { spawnCwd: string; args: string[]; extraEnv: NodeJS.ProcessEnv } {
  const script = `${POWERSHELL_UTF8_PREFIX}${command}`;
  const spawnCwd = windowsCreateProcessCwd(stagingRoot);
  if (process.platform !== "win32" || spawnCwd === stagingRoot) {
    return { spawnCwd, args: [...POWERSHELL_ARGS, script], extraEnv: {} };
  }
  return {
    spawnCwd,
    args: [...POWERSHELL_ARGS, LONG_CWD_POWERSHELL],
    extraEnv: { REPRISE_RECOVERY_COMMAND: script, REPRISE_RECOVERY_CWD: stagingRoot },
  };
}

function windowsCreateProcessCwd(stagingRoot: string): string {
  if (process.platform !== "win32" || stagingRoot.length < WINDOWS_CREATEPROCESS_CWD_LIMIT) return stagingRoot;
  return tmpdir();
}

function resolveWindowsPowershell(
  override?: string,
  findOnPath?: (name: string) => string | undefined,
): { executable: string; kind: "powershell_7" | "powershell_windows" } | undefined {
  if (override) {
    if (!existsSync(override)) return undefined;
    return { executable: override, kind: /pwsh\.exe$/i.test(override) ? "powershell_7" : "powershell_windows" };
  }
  const locate = findOnPath ?? findExecutableOnPath;
  const pwshOnPath = locate("pwsh.exe");
  if (pwshOnPath) return { executable: pwshOnPath, kind: "powershell_7" };
  const programFiles = envLookup(process.env, "ProgramFiles") ?? "C:\\Program Files";
  const pwsh7 = join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (existsSync(pwsh7)) return { executable: pwsh7, kind: "powershell_7" };
  const windowsPsOnPath = locate("powershell.exe");
  if (windowsPsOnPath) return { executable: windowsPsOnPath, kind: "powershell_windows" };
  const systemRoot = envLookup(process.env, "SystemRoot") ?? envLookup(process.env, "WINDIR") ?? "C:\\Windows";
  const windowsPs = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(windowsPs)) return { executable: windowsPs, kind: "powershell_windows" };
  return undefined;
}

function findExecutableOnPath(executable: string): string | undefined {
  try {
    const result = spawnSync("where", [executable], { encoding: "utf-8", timeout: 5_000, windowsHide: true });
    if (result.status !== 0 || !result.stdout) return undefined;
    const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
    if (firstMatch && existsSync(firstMatch)) return firstMatch;
  } catch {
    // where.exe missing, timed out, or spawn failed: continue to known install paths
  }
  return undefined;
}

function formatShellBoundary(error: ProcessBoundaryError, windows: boolean, executable?: string): Error {
  const bits = [error.exitCategory, error.errnoCode].filter(Boolean).join(" ");
  const missing =
    error.errnoCode === "ENOENT" && executable && existsSync(executable)
      ? " Windows CreateProcess rejected the working directory (MAX_PATH)."
      : error.errnoCode === "ENOENT"
        ? windows
          ? " PowerShell executable was not found (未找到 PowerShell)."
          : " Bash executable was not found (未找到 Bash)."
        : "";
  return new Error(`${bits}:${missing} ${error.message}`.replace(/\s+/g, " ").trim());
}

function envLookup(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? undefined : env[found];
}

function sanitizedEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path",
    "pathext",
    "systemroot",
    "windir",
    "comspec",
    "temp",
    "tmp",
    "lang",
    "lc_all",
    "lc_ctype",
    "term",
    "user",
    "username",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && (allowed.has(key.toLowerCase()) || key.startsWith("LC_"))) env[key] = value;
  const ensure = (canonical: string, fallback?: string) => {
    if (envLookup(env, canonical) !== undefined) return;
    const fromProcess = envLookup(process.env, canonical) ?? fallback;
    if (fromProcess) env[canonical] = fromProcess;
  };
  const systemRoot = envLookup(env, "SystemRoot") ?? envLookup(process.env, "SystemRoot") ?? envLookup(process.env, "WINDIR");
  ensure("SystemRoot", systemRoot);
  ensure("WINDIR", envLookup(env, "SystemRoot"));
  const root = envLookup(env, "SystemRoot");
  ensure("ComSpec", root ? join(root, "System32", "cmd.exe") : undefined);
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

function assertWritablePath(ctx: RecoveryToolContext, path: { relative: string; writable: boolean }): void {
  if (!path.writable) throw new Error("write_denied: path is a read-only mount.");
  if (ctx.options.allowWrite && !ctx.options.allowWrite(path.relative))
    throw new Error("write_denied: path is outside the Host write policy.");
}

function assertShellDoesNotMutateReadonlyMount(ctx: RecoveryToolContext, command: string): void {
  const prefixes = ctx.options.denyDestructiveOnPrefix ?? Object.keys(ctx.mounts);
  if (!prefixes.length) return;
  const mutates = /\b(Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Move-Item|Copy-Item|Rename-Item|rmdir|\brm\b|\bdel\b|\brd\b)\b/i.test(
    command,
  );
  if (!mutates) return;
  for (const prefix of prefixes) {
    if (command.includes(prefix) || command.includes(ctx.mounts[prefix] ?? ""))
      throw new Error("write_denied: shell_exec must not mutate a read-only mount.");
  }
}

async function assertNoSymlinkAncestors(root: string, target: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = relativeInside(resolvedRoot, resolvedTarget);
  if (relativeTarget === undefined) throw new Error("Path escapes staging.");
  let current = resolvedRoot;
  for (const part of relativeTarget.split("/").filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not supported in staging.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertStillInside(root: string, target: string): Promise<void> {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = stripWindowsExtendedPrefix(await realpath(root));
    realTarget = stripWindowsExtendedPrefix(await realpath(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!pathContainedBy(realRoot, realTarget)) throw new Error("Path escapes staging.");
}

type ResolvedWorkspacePath = {
  absolute: string;
  relative: string;
  writable: boolean;
  containmentRoot: string;
};

function shellExecDescription(ctx: RecoveryToolContext): string {
  const mounts = Object.keys(ctx.mounts);
  const denied = ctx.options.denyDestructiveOnPrefix ?? [];
  const readonly = [...new Set([...mounts, ...denied])];
  const lock = readonly.length
    ? ` Read-only mounts (${readonly.join(", ")}) must not be mutated. Write only staging files the role allows (Comparison: scratch/, work/comparison-plan.md, report.html).`
    : "";
  return `Run one host-shell command with cwd locked to staging. The host selects PowerShell or a POSIX shell. Network is open; credentials and global configuration are not provided.${lock}`;
}

function workspaceRelative(input: string): string | { root: true } | undefined {
  if (isAbsolute(input)) return undefined;
  const slash = input.replaceAll("\\", "/");
  if (slash.includes("\\")) return undefined;
  if (slash === "" || slash === "." || slash === "./") return { root: true };
  const kept: string[] = [];
  for (const part of slash.split("/")) {
    if (part === ".") continue;
    if (!part || part === "..") return undefined;
    kept.push(part);
  }
  return kept.length === 0 ? { root: true } : kept.join("/");
}

function pathIn(ctx: RecoveryToolContext, input: string): ResolvedWorkspacePath {
  const relativePath = workspaceRelative(input);
  if (relativePath === undefined)
    throw new Error("Path must be a slash-separated relative path without .. or backslashes.");
  if (typeof relativePath !== "string")
    return { absolute: ctx.root, relative: "", writable: true, containmentRoot: ctx.root };
  const parts = relativePath.split("/");
  const mountRoot = ctx.mounts[parts[0] ?? ""];
  if (mountRoot) {
    const rest = parts.slice(1).join("/");
    if (!rest) return { absolute: resolve(mountRoot), relative: parts[0]!, writable: false, containmentRoot: resolve(mountRoot) };
    const inner = containedPath(mountRoot, rest);
    return { absolute: inner.absolute, relative: `${parts[0]}/${inner.relative}`, writable: false, containmentRoot: resolve(mountRoot) };
  }
  const inner = containedPath(ctx.root, relativePath);
  return { ...inner, writable: true, containmentRoot: ctx.root };
}

function containedPath(root: string, input: string): { absolute: string; relative: string } {
  const absolute = resolve(root, ...input.split("/"));
  const rel = relativeInside(root, absolute);
  if (rel === undefined) throw new Error("Path escapes staging.");
  return { absolute, relative: rel };
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

async function listTree(ctx: RecoveryToolContext, prefix: string, depth: number): Promise<string[]> {
  const start = prefix ? pathIn(ctx, prefix) : { absolute: ctx.root, relative: "", containmentRoot: ctx.root, writable: true };
  const entries = await ctx.readDirectory(start.absolute);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    seen.add(entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link encountered: ${relativePath}`);
    output.push(`${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"} ${relativePath}`);
    if (entry.isDirectory() && depth > 0 && output.length < MAX_LIST_ENTRIES)
      output.push(...(await listTree(ctx, relativePath, depth - 1)));
  }
  if (!prefix) {
    for (const mount of Object.keys(ctx.mounts)) {
      if (seen.has(mount)) continue;
      output.unshift(`directory ${mount}`);
      if (depth > 0 && output.length < MAX_LIST_ENTRIES) output.push(...(await listTree(ctx, mount, depth - 1)));
    }
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

