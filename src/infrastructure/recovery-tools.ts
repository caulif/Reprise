import { lstat, mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sha256, writeAtomic } from "../core/identity.js";
import {
  journalControlledRecoveryRename,
  journalControlledRecoveryWrite,
  type RecoveryControlledWriteHook,
} from "./recovery-write-journal.js";
import {
  RecoveryManifestSchema,
  RecoveryPlanSchema,
  type RecoveryPlan,
  type TaskCase,
} from "../core/schema.js";
import type { AgentToolDefinition } from "./pi-agent-host.js";
import { ProcessBoundaryError, runProcess } from "./process-runner.js";
const MAX_BYTES = 262_144;
const DEFAULT_READ_BYTES = 65_536;
const MAX_LIST_ENTRIES = 256;
const MAX_COMMAND_BYTES = 32_768;
const RECOVERY_SHELL_TIMEOUT_MS = 60_000;
const RECOVERY_SINKS = new Set(["recovery-manifest.json", "recovery.md"]);
export type RecoveryToolOperation = {
  operation: "workspace_tree" | "directory_list" | "file_read";
  availability: "available" | "unavailable";
  attempts: 1 | 2;
  /** Redacted reason; it deliberately excludes a source path and filesystem error text. */
  reason?: "filesystem_error";
};
type RecoveryDirectoryEntry = {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
};
export type RecoveryToolFilesystem = {
  /** Test seam for bounded directory reads; production uses node:fs/promises. */
  readDirectory?: (path: string) => Promise<readonly RecoveryDirectoryEntry[]>;
  /** Test seam for bounded regular-file reads; production uses node:fs/promises. */
  readRegularFile?: (path: string) => Promise<Buffer>;
};
export type RecoveryToolOptions = {
  shellTimeoutMs?: number;
  /** Test-only process-boundary seam; production remains pinned to PowerShell 7 on Windows. */
  shellExecutable?: string;
  /** Harness-owned directory used for HOME and tool configuration. */ homeRoot?: string;
  /** Disabled by default: structured tools are the auditable Recovery mutation surface. */
  allowShell?: boolean;
  /** Host callback used to persist a schema-validated plan before any write. */
  onPlan?: (plan: RecoveryPlan) => Promise<void>;
  /** Host callback that persists before/after facts for direct Recovery sink writes. */
  onControlledWrite?: RecoveryControlledWriteHook;
  /** Host-owned audit callback for bounded workspace reads and their degraded outcomes. */
  onOperation?: (operation: RecoveryToolOperation) => Promise<void>;
  /** Injectable bounded readers for failure-path tests; never exposed to the Recovery model. */
  filesystem?: RecoveryToolFilesystem;
};
export type RecoveryEvidenceVerification =
  | { ref: string; kind: "historical_event" | "case_artifact" }
  | { ref: string; kind: "git_commit"; commit: string }
  | {
      /** Provider-validated, pre-interruption checkpoint evidence. */
      ref: string;
      kind: "checkpoint";
      path: string;
      entryKind?: "file" | "directory";
      hash?: string;
    }
  | {
      ref: string;
      kind: "preimage";
      path: string;
      source: string;
      hash: string;
    };
export type RecoveryEvidenceCatalogEntry = {
  ref: string;
  source: "transcript" | "historical_events";
  index: number;
  contentHash: string;
};
/** Identifies an envelope/evidence rejection without masking unknown runner failures. */
export class RecoveryEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryEvidenceValidationError";
  }
}

export type RecoveryFactOperation = {
  operation:
    "repository" | "head" | "status" | "historical_commit" | "evidence_catalog";
  availability: "available" | "unavailable";
  attempts: 1 | 2;
  /** A redacted reason; never includes a command line, source path, or process output. */
  reason?: "not_repository" | "unborn_head" | "nonzero_exit" | "process_error";
};

export type ResolvedRecoveryFacts = {
  git?: {
    isRepo: boolean;
    headState: "present" | "unborn";
    head?: string;
    historicalCommitPresent?: boolean;
    dirtyPaths: string[];
    untrackedPaths: string[];
    statusAvailable: boolean;
  };
  patches: {
    eventIndex: number;
    targetPath: string;
    verifiableBase: boolean;
  }[];
  preimages: { path: string; source: string; hash: string }[];
  /** Only these frozen, Harness-owned references may appear in the thin Agent envelope. */ evidenceRefs: string[];
  catalog: RecoveryEvidenceCatalogEntry[];
  verifiedEvidence: RecoveryEvidenceVerification[];
  /** Redacted per-operation outcomes make degraded forensics reviewable and replayable. */
  operations: RecoveryFactOperation[];
};
/** Resolves frozen evidence and probes Git states independently so an unborn HEAD remains a valid repository. */
export async function resolvedRecoveryFacts(
  root: string,
  taskCase: TaskCase,
): Promise<ResolvedRecoveryFacts> {
  const historicalCommit =
    typeof taskCase.taskContext?.historicalCommit === "string"
      ? taskCase.taskContext.historicalCommit
      : undefined;
  const preimages = extractPreimages(taskCase.historicalEvents);
  const catalog = recoveryEvidenceCatalog(taskCase);
  const verifiedEvidence = taskCaseEvidence(taskCase, preimages, catalog);
  const probed = await probeGit(root, historicalCommit, verifiedEvidence);
  return {
    git: probed.git,
    patches: extractPatches(taskCase.historicalEvents),
    preimages,
    evidenceRefs: uniqueRefs(verifiedEvidence),
    catalog,
    verifiedEvidence,
    operations: [
      { operation: "evidence_catalog", availability: "available", attempts: 1 },
      ...probed.operations,
    ],
  };
}

/** Creates deterministic Host-owned refs even when imported history rows have no product event id. */
function recoveryEvidenceCatalog(
  taskCase: TaskCase,
): RecoveryEvidenceCatalogEntry[] {
  return [
    ...taskCase.transcript.map((value, index) =>
      catalogEntry("transcript", index, value),
    ),
    ...taskCase.historicalEvents.map((value, index) =>
      catalogEntry("historical_events", index, value),
    ),
  ];
}

function catalogEntry(
  source: RecoveryEvidenceCatalogEntry["source"],
  index: number,
  value: unknown,
): RecoveryEvidenceCatalogEntry {
  const contentHash = sha256(JSON.stringify(value));
  return {
    ref: `event:${source === "transcript" ? "transcript" : "history"}-${index}-${contentHash.slice(0, 16)}`,
    source,
    index,
    contentHash,
  };
}

async function probeGit(
  root: string,
  historicalCommit: string | undefined,
  evidence: RecoveryEvidenceVerification[],
): Promise<{
  git: NonNullable<ResolvedRecoveryFacts["git"]>;
  operations: RecoveryFactOperation[];
}> {
  const inside = await gitProbe(
    root,
    ["rev-parse", "--is-inside-work-tree"],
    "repository",
    true,
  );
  const operations: RecoveryFactOperation[] = [
    probeOperation("repository", inside),
  ];
  if (!inside.ok || inside.stdout.trim() !== "true") {
    operations.push({
      operation: "head",
      availability: "unavailable",
      attempts: 1,
      reason: "not_repository",
    });
    operations.push({
      operation: "status",
      availability: "unavailable",
      attempts: 1,
      reason: "not_repository",
    });
    if (historicalCommit)
      operations.push({
        operation: "historical_commit",
        availability: "unavailable",
        attempts: 1,
        reason: "not_repository",
      });
    return {
      git: {
        isRepo: false,
        headState: "unborn",
        dirtyPaths: [],
        untrackedPaths: [],
        statusAvailable: false,
      },
      operations,
    };
  }
  const head = await gitProbe(
    root,
    ["rev-parse", "--verify", "HEAD"],
    "HEAD",
    true,
  );
  const status = await gitProbe(
    root,
    ["status", "--porcelain"],
    "status",
    true,
  );
  operations.push(
    probeOperation("head", head, head.ok ? undefined : "unborn_head"),
  );
  operations.push(probeOperation("status", status));
  const historicalCommitProbe = historicalCommit
    ? await gitObjectProbe(root, historicalCommit)
    : undefined;
  if (historicalCommitProbe)
    operations.push(probeOperation("historical_commit", historicalCommitProbe));
  const historicalCommitPresent = historicalCommitProbe?.ok;
  if (historicalCommit && historicalCommitPresent)
    evidence.push({
      ref: "artifact:historical-commit",
      kind: "git_commit",
      commit: historicalCommit,
    });
  const lines = status.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
  return {
    git: {
      isRepo: true,
      headState: head.ok ? "present" : "unborn",
      ...(head.ok && head.stdout.trim() ? { head: head.stdout.trim() } : {}),
      ...(historicalCommitPresent === undefined
        ? {}
        : { historicalCommitPresent }),
      dirtyPaths: lines
        .filter((line) => !line.startsWith("?? "))
        .map((line) => line.slice(3)),
      untrackedPaths: lines
        .filter((line) => line.startsWith("?? "))
        .map((line) => line.slice(3)),
      statusAvailable: status.ok,
    },
    operations,
  };
}

type GitProbe = {
  ok: boolean;
  stdout: string;
  attempts: 1 | 2;
  failure?: "nonzero_exit" | "process_error";
};

function probeOperation(
  operation: Exclude<RecoveryFactOperation["operation"], "evidence_catalog">,
  probe: GitProbe,
  unavailableReason?: RecoveryFactOperation["reason"],
): RecoveryFactOperation {
  return probe.ok
    ? { operation, availability: "available", attempts: probe.attempts }
    : {
        operation,
        availability: "unavailable",
        attempts: probe.attempts,
        reason: unavailableReason ?? probe.failure ?? "process_error",
      };
}

/** Retries only a supplemental Git process failure once; semantic non-zero exits are facts, not transient errors. */
async function gitProbe(
  root: string,
  args: string[],
  label: string,
  allowFailure = false,
): Promise<GitProbe> {
  for (const attempt of [1, 2] as const) {
    try {
      const result = await runProcess({
        operation: `git_${label}_probe`,
        executableKind: "git",
        command: "git",
        args,
        cwd: root,
        timeoutMs: 5_000,
        maxOutputBytes: MAX_BYTES,
      });
      return { ok: true, stdout: result.stdout, attempts: attempt };
    } catch (error) {
      if (gitNonzeroExit(error)) {
        if (allowFailure)
          return {
            ok: false,
            stdout: "",
            attempts: attempt,
            failure: "nonzero_exit",
          };
        throw new Error(`Git ${label} probe failed.`, { cause: error });
      }
      if (attempt === 2) {
        if (allowFailure)
          return {
            ok: false,
            stdout: "",
            attempts: attempt,
            failure: "process_error",
          };
        throw new Error(`Git ${label} probe failed.`, { cause: error });
      }
    }
  }
  throw new Error(`Git ${label} probe exhausted unexpectedly.`);
}

async function gitObjectProbe(root: string, object: string): Promise<GitProbe> {
  return gitProbe(
    root,
    ["cat-file", "-e", `${object}^{commit}`],
    "object",
    true,
  );
}
function gitNonzeroExit(error: unknown): boolean {
  return (
    error instanceof ProcessBoundaryError &&
    error.exitCategory === "nonzero_exit"
  );
}

function gitExit(error: unknown, exitCode: number): boolean {
  return (
    error instanceof ProcessBoundaryError &&
    error.exitCategory === "nonzero_exit" &&
    error.exitCode === exitCode
  );
}
function taskCaseEvidence(
  taskCase: TaskCase,
  preimages: readonly { path: string; source: string; hash: string }[],
  catalog: readonly RecoveryEvidenceCatalogEntry[],
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
  for (const entry of catalog)
    evidence.push({ ref: entry.ref, kind: "historical_event" });
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
    throw new RecoveryEvidenceValidationError(
      "recovered status cannot include unresolved items; use partial.",
    );
  }
  if (
    (result.status === "recovered" || result.status === "partial") &&
    !result.evidenceRefs.length
  ) {
    throw new RecoveryEvidenceValidationError(
      "recovered or partial status requires owned evidence references.",
    );
  }
  const known = new Set(knownRefs);
  for (const ref of result.evidenceRefs) {
    if (!known.has(ref))
      throw new RecoveryEvidenceValidationError(
        `Recovery evidence is not owned by the frozen TaskCase: ${ref}.`,
      );
  }
}

/** Rechecks the evidence selected by the Agent at the Provider boundary. */ /** Returns a Git blob's content digest for path-level recovery verification. */
export async function gitFileHash(
  root: string,
  commit: string,
  path: string,
): Promise<string | undefined> {
  if (!isRelativePath(path))
    throw new Error("Recovery path must be a staging-relative slash path.");
  try {
    const result = await runProcess({
      operation: "git_path_verification",
      executableKind: "git",
      command: "git",
      args: ["show", `${commit}:${path}`],
      cwd: root,
      timeoutMs: 5_000,
      maxOutputBytes: MAX_BYTES,
    });
    return sha256(result.stdout);
  } catch (error) {
    if (gitExit(error, 128)) return undefined;
    throw new Error(`Git path verification failed for ${path}.`, {
      cause: error,
    });
  }
}

/** A manifest path is always a candidate-visible, slash-relative staging path. */
export function isRecoveryPath(path: string): boolean {
  return isRelativePath(path) && !path.startsWith(".git/") && path !== ".git";
}

export async function verifyRecoveryEvidence(
  root: string,
  refs: readonly string[],
  evidence: readonly RecoveryEvidenceVerification[],
): Promise<void> {
  const selected = new Set(refs);
  const known = new Map(evidence.map((item) => [item.ref, item]));
  for (const ref of selected) {
    const item = known.get(ref);
    if (!item)
      throw new RecoveryEvidenceValidationError(
        `Recovery evidence is not owned by the frozen TaskCase: ${ref}.`,
      );
    if (
      item.kind === "git_commit" &&
      !(await gitObjectPresent(root, item.commit))
    )
      throw new RecoveryEvidenceValidationError(
        `Recovery Git evidence is unavailable: ${ref}.`,
      );
    if (item.kind === "preimage" && sha256(item.source) !== item.hash)
      throw new RecoveryEvidenceValidationError(
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
async function gitObjectPresent(
  root: string,
  object: string,
): Promise<boolean> {
  return (await gitObjectProbe(root, object)).ok;
}
export type RecoveryObservationOperation = {
  operation: "derive_task_footprint" | "search_recovery_artifacts" | "read_observation";
  availability: "available" | "unavailable";
  attempts: 1 | 2;
  reason?: "frozen_evidence_error";
};
export type RecoveryObservationOptions = {
  /** Persists a redacted, Host-owned outcome for frozen evidence access. */
  onOperation?: (operation: RecoveryObservationOperation) => Promise<void>;
  /** Test seam for frozen-evidence access failures; not available to the model. */
  beforeRead?: (operation: RecoveryObservationOperation["operation"]) => Promise<void>;
};
/** Recovery has a separate observation reader because its evidence predates any candidate run. */
export function recoveryObservationTools(
  taskCase: TaskCase,
  options: RecoveryObservationOptions = {},
): readonly AgentToolDefinition[] {
  const boundedObservation = async <T>(
    operation: RecoveryObservationOperation["operation"],
    read: () => T,
  ): Promise<T | undefined> => {
    for (const attempt of [1, 2] as const) {
      try {
        await options.beforeRead?.(operation);
        const value = read();
        await options.onOperation?.({ operation, availability: "available", attempts: attempt });
        return value;
      } catch {
        if (attempt === 2)
          await options.onOperation?.({
            operation,
            availability: "unavailable",
            attempts: attempt,
            reason: "frozen_evidence_error",
          });
      }
    }
    return undefined;
  };
  const unavailable = (
    operation: RecoveryObservationOperation["operation"],
    details: Record<string, unknown> = {},
  ) => ({
    content: "[]",
    details: { operation, available: false, reason: "frozen_evidence_error", ...details },
  });
  const parameters = Type.Object({
    source: Type.Union([Type.Literal("transcript"), Type.Literal("historical_events")]),
    start: Type.Optional(Type.Integer({ minimum: 0 })),
    maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
  });
  return [
    {
      name: "derive_task_footprint",
      description:
        "Derive bounded path, command, and test clues from frozen observations without treating inferred clues as verified facts.",
      parameters: Type.Object({}),
      execute: async () => {
        const footprint = await boundedObservation("derive_task_footprint", () =>
          recoveryEvidenceCatalog(taskCase)
            .map((entry) => ({
              ref: entry.ref,
              source: entry.source,
              paths: footprintMatches(taskCaseObservation(taskCase, entry)),
              commands: footprintCommands(taskCaseObservation(taskCase, entry)),
            }))
            .filter((entry) => entry.paths.length || entry.commands.length),
        );
        if (!footprint) return unavailable("derive_task_footprint");
        return {
          content: JSON.stringify(footprint.slice(0, 128)),
          details: { available: true, returned: Math.min(footprint.length, 128), inferred: true },
        };
      },
    },
    {
      name: "search_recovery_artifacts",
      description:
        "Search frozen transcript and historical observations by a bounded term; returns Host refs and hashes, not unregistered artifacts.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 256 }) }),
      execute: async (params) => {
        const query = requiredString((params as { query?: unknown }).query, "query").toLowerCase();
        const matches = await boundedObservation("search_recovery_artifacts", () =>
          recoveryEvidenceCatalog(taskCase).filter((entry) =>
            JSON.stringify(taskCaseObservation(taskCase, entry)).toLowerCase().includes(query),
          ),
        );
        const redactedQuery = redactSearchQuery(query);
        if (!matches) return unavailable("search_recovery_artifacts", { query: redactedQuery });
        return {
          content: JSON.stringify(matches.slice(0, 64)),
          details: { query: redactedQuery, available: true, returned: Math.min(matches.length, 64), truncated: matches.length > 64 },
        };
      },
    },
    {
      name: "read_observation",
      description: "Read a bounded page of the frozen historical transcript or historical events.",
      parameters,
      execute: async (params) => {
        const value = params as { source?: unknown; start?: unknown; maxItems?: unknown };
        if (value.source !== "transcript" && value.source !== "historical_events")
          throw new Error("Observation source is invalid.");
        const start = integer(value.start, 0, "Observation cursor");
        const maxItems = value.maxItems === undefined ? 32 : integer(value.maxItems, undefined, "maxItems", 1, 128);
        const facts = value.source === "transcript" ? taskCase.transcript : taskCase.historicalEvents;
        const page = await boundedObservation("read_observation", () => {
          const catalog = recoveryEvidenceCatalog(taskCase).filter((entry) => entry.source === value.source);
          return facts.slice(start, start + maxItems).map((observation, offset) => ({
            ref: catalog[start + offset]?.ref,
            observation,
          }));
        });
        if (!page) return unavailable("read_observation", { source: value.source, start });
        return {
          content: JSON.stringify(page),
          details: {
            source: value.source,
            start,
            available: true,
            refs: page.map((item) => item.ref),
            returned: page.length,
            ...(start + page.length < facts.length ? { nextCursor: start + page.length } : {}),
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
        await options.onOperation?.({
          operation,
          availability: "available",
          attempts: attempt,
        });
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
  const tools: AgentToolDefinition[] = [
    {
      name: "inspect_workspace",
      description:
        "Inspect the selected candidate workspace at bounded depth; use this before guessing paths or edits.",
      parameters: Type.Object({
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
      }),
      execute: async (params) =>
        limit(async () => {
          const depth = integer(
            (params as { depth?: unknown }).depth,
            2,
            "depth",
            0,
            4,
          );
          const entries = await boundedRead("workspace_tree", async () => {
            await assertNoSymlinkAncestors(root, root);
            return listTree(root, "", depth, readDirectory);
          });
          return workspaceReadResult(".", depth, entries);
        })(),
    },
    {
      name: "inspect_git_history",
      description:
        "Inspect bounded Git log, reflog, and unreachable-object summaries in the selected candidate; never returns object contents.",
      parameters: Type.Object({
        paths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
            maxItems: 32,
          }),
        ),
        depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        includeReflog: Type.Optional(Type.Boolean()),
        includeDangling: Type.Optional(Type.Boolean()),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as {
            paths?: unknown;
            depth?: unknown;
            includeReflog?: unknown;
            includeDangling?: unknown;
          };
          const depth = integer(value.depth, 10, "depth", 1, 50);
          const paths = Array.isArray(value.paths)
            ? value.paths.map((path) => requiredString(path, "path"))
            : [];
          if (paths.some((path) => !isRecoveryPath(path)))
            throw new Error("Git history paths must be staging-relative.");
          const suffix = paths.length ? ["--", ...paths] : [];
          const log = await gitSummary(root, [
            "log",
            `-${depth}`,
            "--date=iso",
            "--format=%H %ad %s",
            ...suffix,
          ]);
          const result: Record<string, unknown> = { log };
          if (value.includeReflog === true)
            result.reflog = await gitSummary(root, [
              "reflog",
              "-n",
              String(depth),
              "--format=%H %gs",
            ]);
          if (value.includeDangling === true)
            result.dangling = await gitSummary(root, [
              "fsck",
              "--no-reflogs",
              "--unreachable",
              "--no-progress",
            ]);
          return {
            content: JSON.stringify(result),
            details: {
              depth,
              paths,
              includesReflog: value.includeReflog === true,
              includesDangling: value.includeDangling === true,
            },
          };
        })(),
    },
    {
      name: "submit_recovery_plan",
      description:
        "Submit a revised, Host-validated RecoveryPlan before further writes. Use only fact refs from investigation and keep competing hypotheses when evidence is uncertain.",
      parameters: RecoveryPlanSchema,
      execute: async (params) =>
        limit(async () => {
          if (!Value.Check(RecoveryPlanSchema, params))
            throw recoveryToolError(
              "recovery_plan_invalid",
              "The plan must match the RecoveryPlan schema.",
              {
                planId: "plan-1",
                factsUsed: ["fact:workspace-current"],
                hypotheses: [
                  {
                    hypothesisId: "hypothesis-1",
                    rationale: "inspect and compare",
                    paths: ["."],
                    supportingFactRefs: ["fact:workspace-current"],
                    counterFactRefs: [],
                    expectedChecks: ["compare candidate"],
                    confidence: "low",
                  },
                ],
                candidates: [{ hypothesisId: "hypothesis-1", operations: [] }],
                verificationPlan: ["inspect changed paths"],
              },
            );
          if (options.onPlan) await options.onPlan(params);
          return {
            content: "Recovery plan accepted by Host.",
            details: {
              planId: params.planId,
              hypothesisCount: params.hypotheses.length,
            },
          };
        })(),
    },
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
          const entries = await boundedRead("directory_list", async () => {
            await assertNoSymlinkAncestors(root, path.absolute);
            return listTree(root, path.relative, depth, readDirectory);
          });
          return directoryReadResult(path.relative || ".", entries);
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
          if (isSensitiveRecoveryPath(path.relative))
            throw recoveryToolError(
              "credential_read_denied",
              "Known credential files are not readable by the Recovery model.",
              { path: "<credential-file>" },
            );
          const offset = integer(value.offset, 0, "offset");
          const maxBytes =
            value.maxBytes === undefined
              ? DEFAULT_READ_BYTES
              : integer(value.maxBytes, undefined, "maxBytes", 1, MAX_BYTES);
          const bytes = await boundedRead("file_read", async () => {
            await assertNoSymlinkAncestors(root, path.absolute);
            await assertRegular(path.absolute);
            return readRegularFile(path.absolute);
          });
          if (!bytes)
            return unavailableFileReadResult(path.relative, offset);
          const slice = bytes.subarray(offset, offset + maxBytes);
          return {
            content: slice.toString("utf8"),
            details: {
              path: path.relative,
              offset,
              available: true,
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
          if (isRecoverySink(path.relative))
            throw recoveryToolError(
              "recovery_sink_reserved",
              `${path.relative} must be written with its dedicated structured tool.`,
              path.relative === "recovery-manifest.json"
                ? {
                    actions: [
                      {
                        operation: "restore",
                        path: "input.txt",
                        evidenceRefs: ["event:history-1"],
                      },
                    ],
                    unresolved: [],
                  }
                : { content: "# Recovery report" },
            );
          const content = requiredString(value.content, "content");
          if (Buffer.byteLength(content) > MAX_BYTES)
            throw new Error(`content exceeds ${MAX_BYTES} bytes.`);
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertWritableFile(path.absolute);
          await mkdir(resolve(path.absolute, ".."), { recursive: true });
          await journalControlledRecoveryWrite(
            {
              tool: "write_file",
              relativePath: path.relative,
              absolutePath: path.absolute,
              write: () => writeAtomic(path.absolute, content),
            },
            options.onControlledWrite,
          );
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
      name: "write_binary_file",
      description: "Write canonical base64 bytes to one explicit regular file in staging.",
      parameters: Type.Object({
        path: Type.String({ minLength: 1, maxLength: 512 }),
        base64: Type.String({ maxLength: Math.ceil((MAX_BYTES * 4) / 3) + 4 }),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as { path?: unknown; base64?: unknown };
          const path = pathIn(root, requiredString(value.path, "path"));
          if (isRecoverySink(path.relative))
            throw recoveryToolError(
              "recovery_sink_reserved",
              `${path.relative} must be written with its dedicated structured tool.`,
              { path: "output.bin", base64: "AA==" },
            );
          const bytes = canonicalBase64(requiredString(value.base64, "base64"));
          if (bytes.byteLength > MAX_BYTES)
            throw new Error(`base64 decodes to more than ${MAX_BYTES} bytes.`);
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertWritableFile(path.absolute);
          await mkdir(resolve(path.absolute, ".."), { recursive: true });
          await journalControlledRecoveryWrite(
            {
              tool: "write_binary_file",
              relativePath: path.relative,
              absolutePath: path.absolute,
              write: () => writeAtomic(path.absolute, bytes),
            },
            options.onControlledWrite,
          );
          return { content: `Wrote ${bytes.byteLength} bytes.`, details: { path: path.relative, byteLength: bytes.byteLength } };
        })(),
    },
    {
      name: "rename_file",
      description: "Rename one regular staging file without overwriting the target, with a Host-owned paired journal.",
      parameters: Type.Object({
        from: Type.String({ minLength: 1, maxLength: 512 }),
        to: Type.String({ minLength: 1, maxLength: 512 }),
      }),
      execute: async (params) =>
        limit(async () => {
          const value = params as { from?: unknown; to?: unknown };
          const source = pathIn(root, requiredString(value.from, "from"));
          const target = pathIn(root, requiredString(value.to, "to"));
          if (source.relative === target.relative)
            throw new Error("from and to must name different paths.");
          if (isRecoverySink(source.relative) || isRecoverySink(target.relative))
            throw recoveryToolError(
              "recovery_sink_reserved",
              "Recovery sinks cannot be renamed.",
              { from: "input.txt", to: "renamed.txt" },
            );
          await assertNoSymlinkAncestors(root, source.absolute);
          await assertNoSymlinkAncestors(root, target.absolute);
          await assertRegular(source.absolute);
          await assertAbsent(target.absolute);
          await mkdir(resolve(target.absolute, ".."), { recursive: true });
          await journalControlledRecoveryRename(
            {
              relativeSourcePath: source.relative,
              sourceAbsolutePath: source.absolute,
              relativeTargetPath: target.relative,
              targetAbsolutePath: target.absolute,
              rename: () => rename(source.absolute, target.absolute),
            },
            options.onControlledWrite,
          );
          return { content: "Renamed file.", details: { from: source.relative, to: target.relative } };
        })(),
    },
    {
      name: "delete_file",
      description: "Delete one explicit regular staging file with a Host-owned before/after journal.",
      parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) }),
      execute: async (params) =>
        limit(async () => {
          const path = pathIn(root, requiredString((params as { path?: unknown }).path, "path"));
          await assertNoSymlinkAncestors(root, path.absolute);
          await assertRegular(path.absolute);
          await journalControlledRecoveryWrite(
            {
              tool: "delete_file",
              relativePath: path.relative,
              absolutePath: path.absolute,
              write: () => unlink(path.absolute),
              expectAfter: false,
            },
            options.onControlledWrite,
          );
          return { content: "Deleted file.", details: { path: path.relative } };
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
    },
    {
      name: "write_recovery_manifest",
      description:
        "Write the final recovery-manifest.json through the structured sink. Use only staging-relative paths and Host-owned evidence refs.",
      parameters: RecoveryManifestSchema,
      execute: async (params) =>
        limit(async () => {
          if (!Value.Check(RecoveryManifestSchema, params))
            throw recoveryToolError(
              "recovery_manifest_invalid",
              "actions must contain operation, path, and at least one evidenceRef; unresolved must be an array.",
              {
                actions: [
                  {
                    operation: "restore",
                    path: "input.txt",
                    evidenceRefs: ["event:history-1"],
                  },
                ],
                unresolved: [],
              },
            );
          const manifest = params;
          if (manifest.actions.some((action) => !isRecoveryPath(action.path)))
            throw recoveryToolError(
              "recovery_manifest_unsafe_path",
              "Manifest paths must be staging-relative slash paths outside .git.",
              {
                actions: [
                  {
                    operation: "restore",
                    path: "input.txt",
                    evidenceRefs: ["event:history-1"],
                  },
                ],
                unresolved: [],
              },
            );
          const manifestPath = resolve(root, "recovery-manifest.json");
          await journalControlledRecoveryWrite(
            {
              tool: "write_recovery_manifest",
              relativePath: "recovery-manifest.json",
              absolutePath: manifestPath,
              write: () => writeAtomic(manifestPath, JSON.stringify(manifest)),
            },
            options.onControlledWrite,
          );
          return {
            content: "Wrote recovery manifest.",
            details: { path: "recovery-manifest.json" },
          };
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
          const reportPath = resolve(root, "recovery.md");
          await journalControlledRecoveryWrite(
            {
              tool: "write_recovery_report",
              relativePath: "recovery.md",
              absolutePath: reportPath,
              write: () => writeAtomic(reportPath, content),
            },
            options.onControlledWrite,
          );
          return {
            content: `Wrote ${Buffer.byteLength(content)} bytes.`,
            details: { path: "recovery.md" },
          };
        })(),
    },
  ];
  const enabledTools = options.allowShell ? tools : tools.filter((tool) => tool.name !== "staging_shell");
  const seen = new Set<string>();
  let mutationVersion = 0;
  const mutatingTools = new Set(["write_file", "write_binary_file", "rename_file", "delete_file", "staging_shell", "write_recovery_manifest", "write_recovery_report"]);
  return enabledTools.map((tool) => ({
    ...tool,
    execute: async (params: unknown, signal: AbortSignal) => {
      const key = `${mutationVersion}:${tool.name}:${JSON.stringify(params)}`;
      if (seen.has(key)) throw new Error("recovery_no_information_gain: repeated tool call with identical inputs.");
      seen.add(key);
      const result = await tool.execute(params, signal);
      if (mutatingTools.has(tool.name)) mutationVersion += 1;
      return result;
    },
  }));
}

function taskCaseObservation(
  taskCase: TaskCase,
  entry: RecoveryEvidenceCatalogEntry,
): unknown {
  return entry.source === "transcript"
    ? taskCase.transcript[entry.index]
    : taskCase.historicalEvents[entry.index];
}

function footprintMatches(value: unknown): string[] {
  const text = JSON.stringify(value);
  const candidates =
    text.match(/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?:\.[A-Za-z0-9_-]{1,32})/g) ??
    [];
  return [
    ...new Set(
      candidates.filter(
        (item) => isRelativePath(item) && !item.startsWith("event:"),
      ),
    ),
  ].slice(0, 32);
}

function footprintCommands(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(
      ([key, item]) =>
        /command|test|script/i.test(key) && typeof item === "string",
    )
    .map(([, item]) => String(item).slice(0, 512))
    .slice(0, 16);
}

function redactSearchQuery(query: string): string {
  return query.replace(
    /(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  );
}

async function gitSummary(
  root: string,
  args: string[],
): Promise<{ available: boolean; lines: string[] }> {
  try {
    const result = await runProcess({
      operation: "git_summary",
      executableKind: "git",
      command: "git",
      args,
      cwd: root,
      timeoutMs: 5_000,
      maxOutputBytes: MAX_BYTES,
    });
    return {
      available: true,
      lines: result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, MAX_LIST_ENTRIES),
    };
  } catch {
    return { available: false, lines: [] };
  }
}

function isRecoverySink(path: string): boolean {
  return !path.includes("/") && RECOVERY_SINKS.has(basename(path));
}
function isSensitiveRecoveryPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name === ".env" || name.startsWith(".env.") ||
    name === "auth.json" || name === ".credentials.json" ||
    name === "credentials.json" || /\.(pem|key|p12|pfx)$/.test(name) ||
    name.includes("credential");
}

/** Stable, repairable errors keep the model on the structured recovery protocol. */
function recoveryToolError(
  code: string,
  detail: string,
  example: unknown,
): Error {
  return new Error(`${code}: ${detail} Example: ${JSON.stringify(example)}`);
}


function assertShellCommandDoesNotTargetSensitiveFiles(command: string): void {
  // This is intentionally a lexical deny rule: shell syntax is too expressive for a
  // reliable read allowlist, so known credential names are rejected before spawning.
  if (/(?:^|[\s"'/\\])(?:\.env(?:\.[A-Za-z0-9_-]+)?|auth\.json|credentials?\.json|[^\s"'/\\]*credential[^\s"'/\\]*|[^\s"'/\\]+\.(?:pem|key|p12|pfx))(?:$|[\s"'/\\])/i.test(command))
    throw new Error('credential_read_denied: sensitive file category.');
}

function runShell(
  root: string,
  home: string,
  command: string,
  signal: AbortSignal,
  timeoutMs: number,
  executableOverride?: string,
): Promise<{ content: string; details: Record<string, unknown> }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("Shell timeout must be a positive integer.");
  const windows = process.platform === "win32";
  const powershell = executableOverride ?? "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  return runProcess({
    operation: "staging_shell",
    executableKind: windows ? "powershell_7" : "shell",
    // Windows uses the fixed PowerShell 7 executable rather than Node's implicit
    // shell parsing. A missing executable becomes a classified spawn error.
    command: windows ? powershell : command,
    args: windows
      ? ["-NoProfile", "-NonInteractive", "-Command", "& $env:ComSpec /d /s /c $env:REPRISE_RECOVERY_COMMAND; exit $LASTEXITCODE"]
      : [],
    cwd: root,
    env: windows
      ? { ...sanitizedEnvironment(home), REPRISE_RECOVERY_COMMAND: command }
      : sanitizedEnvironment(home),
    shell: !windows,
    allowNonzeroExit: windows,
    killTree: true,
    signal,
    timeoutMs,
    maxOutputBytes: MAX_BYTES,
    truncateOutput: true,
  }).then((result) => {
    const content = [
      result.stdout,
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
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
function recoveryReadBoundaryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /symbolic link|regular file/i.test(error.message)
  );
}

function workspaceReadResult(
  scope: string,
  depth: number,
  entries: string[] | undefined,
): { content: string; details: Record<string, unknown> } {
  if (!entries)
    return {
      content: "[]",
      details: { scope, depth, available: false, reason: "filesystem_error" },
    };
  return {
    content: JSON.stringify(entries.slice(0, MAX_LIST_ENTRIES)),
    details: {
      scope,
      depth,
      available: true,
      returned: Math.min(entries.length, MAX_LIST_ENTRIES),
      truncated: entries.length > MAX_LIST_ENTRIES,
    },
  };
}
function directoryReadResult(
  path: string,
  entries: string[] | undefined,
): { content: string; details: Record<string, unknown> } {
  if (!entries)
    return {
      content: "[]",
      details: { path, available: false, reason: "filesystem_error" },
    };
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
function unavailableFileReadResult(
  path: string,
  offset: number,
): { content: string; details: Record<string, unknown> } {
  return {
    content: "",
    details: { path, offset, available: false, reason: "filesystem_error" },
  };
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
    if (entry.isSymbolicLink())
      throw new Error(`Symbolic link encountered: ${relativePath}`);
    output.push(
      `${entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"} ${relativePath}`,
    );
    if (entry.isDirectory() && depth > 0 && output.length < MAX_LIST_ENTRIES)
      output.push(...(await listTree(root, relativePath, depth - 1, readDirectory)));
  }
  return output;
}
function canonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value)
    throw new Error("base64 must use canonical standard encoding without whitespace.");
  return bytes;
}
async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Rename target must not already exist.");
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
