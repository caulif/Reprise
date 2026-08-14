import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { sha256, writeAtomic } from "../core/identity.js";
import type { TaskCase } from "../core/schema.js";
import type { AgentToolDefinition } from "./pi-agent-host.js";
const execFileAsync = promisify(execFile);
const MAX_BYTES = 262_144;
const DEFAULT_READ_BYTES = 65_536;
const MAX_LIST_ENTRIES = 256;
const MAX_COMMAND_BYTES = 32_768;
export const RECOVERY_SHELL_TIMEOUT_MS = 60_000;
export type RecoveryToolOptions = {
  shellTimeoutMs?: number;
  /** Harness-owned directory used for HOME and tool configuration. */ homeRoot?: string;
};
export type RecoveryEvidenceVerification =
  | { ref: string; kind: "historical_event" | "case_artifact" }
  | { ref: string; kind: "git_commit"; commit: string }
  | {
      ref: string;
      kind: "preimage";
      path: string;
      source: string;
      hash: string;
    };
type ResolvedRecoveryFacts = {
  git?: {
    isRepo: boolean;
    head?: string;
    historicalCommitPresent?: boolean;
    dirtyPaths: string[];
    untrackedPaths: string[];
  };
  patches: {
    eventIndex: number;
    targetPath: string;
    verifiableBase: boolean;
  }[];
  preimages: { path: string; source: string; hash: string }[];
  /** Only these frozen, Harness-owned references may appear in the thin Agent envelope. */ evidenceRefs: string[];
  verifiedEvidence: RecoveryEvidenceVerification[];
};
/** Resolves only evidence whose path, content hash, or Git object can be mechanically checked. */ export async function resolvedRecoveryFacts(
  root: string,
  taskCase: TaskCase,
): Promise<ResolvedRecoveryFacts> {
  const historicalCommit =
    typeof taskCase.taskContext?.historicalCommit === "string"
      ? taskCase.taskContext.historicalCommit
      : undefined;
  const preimages = extractPreimages(taskCase.historicalEvents);
  const verifiedEvidence = taskCaseEvidence(taskCase, preimages);
  try {
    const head = (
      await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        windowsHide: true,
        maxBuffer: MAX_BYTES,
      })
    ).stdout.trim();
    const status = (
      await execFileAsync("git", ["status", "--porcelain"], {
        cwd: root,
        windowsHide: true,
        maxBuffer: MAX_BYTES,
      })
    ).stdout
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter(Boolean);
    const present = historicalCommit
      ? await gitObjectPresent(root, historicalCommit)
      : undefined;
    if (present && historicalCommit)
      verifiedEvidence.push({
        ref: "artifact:historical-commit",
        kind: "git_commit",
        commit: historicalCommit,
      });
    return {
      git: {
        isRepo: true,
        ...(head ? { head } : {}),
        ...(present === undefined ? {} : { historicalCommitPresent: present }),
        dirtyPaths: status
          .filter((line) => !line.startsWith("?? "))
          .map((line) => line.slice(3)),
        untrackedPaths: status
          .filter((line) => line.startsWith("?? "))
          .map((line) => line.slice(3)),
      },
      patches: extractPatches(taskCase.historicalEvents),
      preimages,
      evidenceRefs: uniqueRefs(verifiedEvidence),
      verifiedEvidence,
    };
  } catch (error) {
    if (!isNotRepository(error)) throw error;
    return {
      git: { isRepo: false, dirtyPaths: [], untrackedPaths: [] },
      patches: extractPatches(taskCase.historicalEvents),
      preimages,
      evidenceRefs: uniqueRefs(verifiedEvidence),
      verifiedEvidence,
    };
  }
}
function taskCaseEvidence(
  taskCase: TaskCase,
  preimages: readonly { path: string; source: string; hash: string }[],
): RecoveryEvidenceVerification[] {
  const evidence: RecoveryEvidenceVerification[] = [];
  for (const ref of taskCase.baseline.evidenceRefs)
    evidence.push({ ref, kind: "historical_event" });
  for (const artifact of [
    ...taskCase.baseline.artifactRefs,
    ...taskCase.sourceRuntimeEvidence.artifactRefs,
  ])
    evidence.push({
      ref: `artifact:${artifact.artifactId}`,
      kind: "case_artifact",
    });
  for (const event of taskCase.historicalEvents) {
    const id =
      typeof event.eventId === "string"
        ? event.eventId
        : typeof event.id === "string"
          ? event.id
          : undefined;
    if (id && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
      evidence.push({ ref: `event:${id}`, kind: "historical_event" });
  }
  preimages.forEach((preimage, index) =>
    evidence.push({
      ref: `artifact:preimage-${index}`,
      kind: "preimage",
      ...preimage,
    }),
  );
  return evidence;
}
function uniqueRefs(
  evidence: readonly RecoveryEvidenceVerification[],
): string[] {
  return [...new Set(evidence.map((item) => item.ref))];
} /** Rejects envelope claims that cannot be supported by frozen recovery evidence. */
export function validateRecoveryEvidence(
  knownRefs: readonly string[],
  result: {
    status: "recovered" | "partial" | "insufficient_evidence";
    unresolved: readonly string[];
    evidenceRefs: readonly string[];
  },
): void {
  if (result.status === "recovered" && result.unresolved.length) {
    throw new Error(
      "recovered status cannot include unresolved items; use partial.",
    );
  }
  if (
    (result.status === "recovered" || result.status === "partial") &&
    !result.evidenceRefs.length
  ) {
    throw new Error(
      "recovered or partial status requires owned evidence references.",
    );
  }
  const known = new Set(knownRefs);
  for (const ref of result.evidenceRefs) {
    if (!known.has(ref))
      throw new Error(
        `Recovery evidence is not owned by the frozen TaskCase: ${ref}.`,
      );
  }
}

/** Rechecks the evidence selected by the Agent at the Provider boundary. */ export async function verifyRecoveryEvidence(
  root: string,
  refs: readonly string[],
  evidence: readonly RecoveryEvidenceVerification[],
): Promise<void> {
  const selected = new Set(refs);
  const known = new Map(evidence.map((item) => [item.ref, item]));
  for (const ref of selected) {
    const item = known.get(ref);
    if (!item)
      throw new Error(
        `Recovery evidence is not owned by the frozen TaskCase: ${ref}.`,
      );
    if (
      item.kind === "git_commit" &&
      !(await gitObjectPresent(root, item.commit))
    )
      throw new Error(`Recovery Git evidence is unavailable: ${ref}.`);
    if (item.kind === "preimage" && sha256(item.source) !== item.hash)
      throw new Error(
        `Recovery preimage evidence failed verification: ${ref}.`,
      );
  }
}
function extractPatches(
  events: readonly Record<string, unknown>[],
): { eventIndex: number; targetPath: string; verifiableBase: boolean }[] {
  const patches: {
    eventIndex: number;
    targetPath: string;
    verifiableBase: boolean;
  }[] = [];
  events.forEach((event, eventIndex) => {
    const paths = new Set<string>();
    walk(event, (value, key, parent) => {
      if (typeof value !== "string" || !isRelativePath(value)) return;
      const marker =
        `${key ?? ""} ${typeof parent?.type === "string" ? parent.type : ""}`.toLowerCase();
      if (
        /path|file|target/.test(marker) &&
        /patch|apply|change|diff|edit|file/.test(
          JSON.stringify(event).slice(0, 4096).toLowerCase(),
        )
      )
        paths.add(value);
    });
    for (const targetPath of paths)
      patches.push({
        eventIndex,
        targetPath,
        verifiableBase: hasVerifiedPatchBase(event),
      });
  });
  return patches;
}
function extractPreimages(
  events: readonly Record<string, unknown>[],
): { path: string; source: string; hash: string }[] {
  const result: { path: string; source: string; hash: string }[] = [];
  for (const event of events)
    walk(event, (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const item = value as Record<string, unknown>;
      const path = stringField(item, ["path", "targetPath", "filePath"]);
      const hash = stringField(item, ["hash", "sha256", "contentHash"]);
      const source = stringField(item, ["source", "preimage", "content"]);
      if (
        path &&
        source &&
        hash &&
        /^[a-f0-9]{64}$/i.test(hash) &&
        isRelativePath(path) &&
        sha256(source) === hash.toLowerCase()
      )
        result.push({ path, source, hash: hash.toLowerCase() });
    });
  return result;
}
function walk(
  value: unknown,
  visit: (
    value: unknown,
    key?: string,
    parent?: Record<string, unknown>,
  ) => void,
  parent?: Record<string, unknown>,
  key?: string,
): void {
  visit(value, key, parent);
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [childKey, child] of Object.entries(value))
    walk(child, visit, value as Record<string, unknown>, childKey);
}
function stringField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys)
    if (typeof value[key] === "string" && value[key]) return value[key];
  return undefined;
}
function isRelativePath(value: string): boolean {
  return (
    Boolean(value) &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}
function hasVerifiedPatchBase(event: Record<string, unknown>): boolean {
  return extractPreimages([event]).length > 0;
}
function isNotRepository(error: unknown): boolean {
  return error instanceof Error && /not a git repository/i.test(error.message);
}
async function gitObjectPresent(
  root: string,
  object: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${object}^{commit}`], {
      cwd: root,
      windowsHide: true,
      maxBuffer: MAX_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}
/** Recovery has a separate observation reader because its evidence predates any candidate run. */ export function recoveryObservationTools(
  taskCase: TaskCase,
): readonly AgentToolDefinition[] {
  const parameters = Type.Object({
    source: Type.Union([
      Type.Literal("transcript"),
      Type.Literal("historical_events"),
    ]),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
  });
  return [
    {
      name: "read_observation",
      description:
        "Read a bounded page of the frozen historical transcript or historical events.",
      parameters,
      execute: async (params) => {
        const value = params as {
          source?: unknown;
          start?: unknown;
          maxItems?: unknown;
        };
        if (
          value.source !== "transcript" &&
          value.source !== "historical_events"
        )
          throw new Error("Observation source is invalid.");
        const start = integer(value.start, 0, "Observation cursor");
        const maxItems =
          value.maxItems === undefined
            ? 32
            : integer(value.maxItems, undefined, "maxItems", 1, 128);
        const facts =
          value.source === "transcript"
            ? taskCase.transcript
            : taskCase.historicalEvents;
        const page = facts.slice(start, start + maxItems);
        return {
          content: JSON.stringify(page),
          details: {
            source: value.source,
            start,
            returned: page.length,
            ...(start + page.length < facts.length
              ? { nextCursor: start + page.length }
              : {}),
          },
        };
      },
    },
  ];
}
/** Recovery gets a general shell in staging; structured tools keep common file operations auditable and bounded. */ export function recoveryTools(
  stagingRoot: string,
  maxToolCalls = 64,
  options: RecoveryToolOptions = {},
): readonly AgentToolDefinition[] {
  const root = resolve(stagingRoot);
  let calls = 0;
  let homeReady: Promise<string> | undefined;
  const limit =
    <T>(fn: () => Promise<T>) =>
    async (): Promise<T> => {
      calls += 1;
      if (calls > maxToolCalls)
        throw new Error(
          `Recovery tool-call budget of ${maxToolCalls} was exhausted.`,
        );
      return fn();
    };
  const homeRoot = options.homeRoot
    ? resolve(options.homeRoot)
    : resolve(root, ".reprise-recovery-home");
  const ensureHome = async (): Promise<string> => {
    homeReady ??= mkdir(homeRoot, { recursive: true }).then(() => homeRoot);
    return homeReady;
  };
  return [
    {
      name: "list_dir",
      description:
        "List a bounded directory within staging. Paths must be relative.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ maxLength: 512 })),
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as { path?: unknown; depth?: unknown };
          const requestedPath =
            value.path === undefined ? "" : requiredString(value.path, "path");
          const path = requestedPath
            ? pathIn(root, requestedPath)
            : { absolute: root, relative: "" };
          const depth =
            value.depth === undefined
              ? 1
              : integer(value.depth, undefined, "depth", 0, 4);
          await assertNoSymlinkAncestors(root, path.absolute);
          const entries = await listTree(root, path.relative, depth);
          return {
            content: JSON.stringify(entries.slice(0, MAX_LIST_ENTRIES)),
            details: {
              path: path.relative || ".",
              returned: Math.min(entries.length, MAX_LIST_ENTRIES),
              truncated: entries.length > MAX_LIST_ENTRIES,
            },
          };
        })(),
    },
    {
      name: "read_file",
      description: "Read a bounded byte range from a regular staging file.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512 }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxBytes: Type.Optional(
          Type.Integer({ minimum: 1, maximum: MAX_BYTES }),
        ),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as {
            path?: unknown;
            offset?: unknown;
            maxBytes?: unknown;
          };
          const path = pathIn(root, requiredString(value.path, "path"));
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertRegular(path.absolute);
          const bytes = await readFile(path.absolute);
          const offset = integer(value.offset, 0, "offset");
          const maxBytes =
            value.maxBytes === undefined
              ? DEFAULT_READ_BYTES
              : integer(value.maxBytes, undefined, "maxBytes", 1, MAX_BYTES);
          const slice = bytes.subarray(offset, offset + maxBytes);
          return {
            content: slice.toString("utf8"),
            details: {
              path: path.relative,
              offset,
              truncated: offset + slice.length < bytes.length,
              ...(offset + slice.length < bytes.length
                ? { nextCursor: offset + slice.length }
                : {}),
            },
          };
        })(),
    },
    {
      name: "write_file",
      description: "Write UTF-8 text to one explicit regular file in staging.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512 }),
        content: Type.String({ maxLength: MAX_BYTES }),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as { path?: unknown; content?: unknown };
          const path = pathIn(root, requiredString(value.path, "path"));
          const content = requiredString(value.content, "content");
          if (Buffer.byteLength(content) > MAX_BYTES)
            throw new Error(`content exceeds ${MAX_BYTES} bytes.`);
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertWritableFile(path.absolute);
          await mkdir(resolve(path.absolute, ".."), { recursive: true });
          await writeAtomic(path.absolute, content);
          return {
            content: `Wrote ${Buffer.byteLength(content)} bytes.`,
            details: {
              path: path.relative,
              byteLength: Buffer.byteLength(content),
            },
          };
        })(),
    },
    {
      name: "staging_shell",
      description:
        "Run one shell command with cwd locked to staging. Network is open; credentials and global configuration are not provided.",
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: MAX_COMMAND_BYTES }),
      }),
      execute: async (params, signal) =>
        limit(async () => {
          const command = requiredString(
            (params as { command?: unknown }).command,
            "command",
          );
          if (Buffer.byteLength(command) > MAX_COMMAND_BYTES)
            throw new Error(`command exceeds ${MAX_COMMAND_BYTES} bytes.`);
          const home = await ensureHome();
          return runShell(
            root,
            home,
            command,
            signal,
            options.shellTimeoutMs ?? RECOVERY_SHELL_TIMEOUT_MS,
          );
        })(),
    },
    {
      name: "write_recovery_report",
      description:
        "Write the final recovery.md report to the staging report sink.",
      parameters: Type.Object({
        content: Type.String({ minLength: 1, maxLength: MAX_BYTES }),
      }),
      execute: async (params) =>
        limit(async () => {
          const content = requiredString(
            (params as { content?: unknown }).content,
            "content",
          );
          await writeAtomic(resolve(root, "recovery.md"), content);
          return {
            content: `Wrote ${Buffer.byteLength(content)} bytes.`,
            details: { path: "recovery.md" },
          };
        })(),
    },
  ];
}
function runShell(
  root: string,
  home: string,
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ content: string; details: Record<string, unknown> }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Shell timeout must be a positive integer.");
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, {
      cwd: root,
      env: sanitizedEnvironment(home),
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = boundedOutput();
    const stderr = boundedOutput();
    let settled = false;
    let timedOut = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        const out = stdout.value();
        const err = stderr.value();
        const content = [out.text, err.text ? `stderr:\n${err.text}` : ""]
          .filter(Boolean)
          .join("\n");
        resolveResult({
          content: content || "ok",
          details: {
            command: redactCommand(command),
            cwd: ".",
            exitCode: child.exitCode,
            signal: child.signalCode,
            stdoutBytes: out.bytes,
            stderrBytes: err.bytes,
            truncated: out.truncated || err.truncated,
            networkAccess: looksLikeNetworkCommand(command),
            ...(timedOut ? { timedOut: true } : {}),
          },
        });
      }
    };
    const stop = () => stopShell(child);
    const abort = () => {
      stop();
      finish(new Error("staging_shell command was cancelled."));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
      setTimeout(
        () =>
          finish(
            new Error(`staging_shell command timed out after ${timeoutMs} ms.`),
          ),
        1_000,
      ).unref();
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(chunk));
    child.on("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    child.on("close", () =>
      finish(
        timedOut
          ? new Error(`staging_shell command timed out after ${timeoutMs} ms.`)
          : undefined,
      ),
    );
  });
}

function stopShell(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  killer.once("error", () => child.kill());
}
function boundedOutput(): {
  push(chunk: Buffer | string): void;
  value(): { text: string; bytes: number; truncated: boolean };
} {
  let bytes = 0;
  let truncated = false;
  const chunks: Buffer[] = [];
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.byteLength, remaining);
      if (buffer.byteLength > remaining) truncated = true;
    },
    value: () => ({
      text: Buffer.concat(chunks).toString("utf8"),
      bytes,
      truncated,
    }),
  };
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
    if (value !== undefined && (allowed.has(key) || key.startsWith("LC_")))
      env[key] = value;
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
    .replace(
      /(authorization\s*[=:]\s*)(?:"?)(?:Bearer\s+)?[^\s"]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}
function looksLikeNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget|fetch|invoke-webrequest|iwr|git\s+(?:clone|fetch|pull|ls-remote)|npm\s+(?:install|view|pack)|pnpm\s+(?:install|fetch)|yarn\s+(?:install|add)|pip\s+install)\b/i.test(
    command,
  );
}
async function assertNoSymlinkAncestors(
  root: string,
  target: string,
): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  )
    throw new Error("Path escapes staging.");
  let current = resolvedRoot;
  for (const part of relativeTarget.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Symbolic links are not supported in staging.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}
function pathIn(
  root: string,
  input: string,
): { absolute: string; relative: string } {
  if (
    !input ||
    isAbsolute(input) ||
    input.includes("\\") ||
    input.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(
      "Path must be a non-empty slash-separated relative path without . or ...",
    );
  const absolute = resolve(root, ...input.split("/"));
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("Path escapes staging.");
  return { absolute, relative: rel.replaceAll("\\", "/") };
}
async function listTree(
  root: string,
  prefix: string,
  depth: number,
): Promise<string[]> {
  const current = prefix ? resolve(root, ...prefix.split("/")) : root;
  const entries = await readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic link encountered: ${relativePath}`);
    output.push(
      `${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"} ${relativePath}`,
    );
    if (entry.isDirectory() && depth > 0 && output.length < MAX_LIST_ENTRIES)
      output.push(...(await listTree(root, relativePath, depth - 1)));
  }
  return output;
}
async function assertRegular(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Path must name a regular file.");
}
async function assertWritableFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Path must name a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}
function integer(
  value: unknown,
  fallback: number | undefined,
  label: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}
