import { isAbsolute } from "node:path";
import { sha256 } from "../core/identity.js";
import { sameFsPath } from "../core/paths.js";
import { type TaskCase } from "../core/schema.js";
import { ProcessBoundaryError, runProcess } from "./process-runner.js";

const MAX_BYTES = 262_144;
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
export function recoveryEvidenceCatalog(
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
  if (!inside.ok || inside.stdout.trim() !== "true") return unavailableGit(operations, historicalCommit);
  const toplevel = await gitProbe(root, ["rev-parse", "--show-toplevel"], "toplevel", true);
  if (!toplevel.ok || !sameFsPath(toplevel.stdout.trim(), root)) return unavailableGit(operations, historicalCommit);
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

function unavailableGit(
  operations: RecoveryFactOperation[],
  historicalCommit: string | undefined,
): {
  git: NonNullable<ResolvedRecoveryFacts["git"]>;
  operations: RecoveryFactOperation[];
} {
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
export function ownedRecoveryRefs(
  refs: readonly string[],
  evidence: readonly { ref: string }[],
): string[] {
  const known = new Set(evidence.map((item) => item.ref));
  const owned = refs.filter((ref) => known.has(ref));
  if (refs.length > 0 && owned.length === 0) {
    throw new RecoveryEvidenceValidationError(
      `Recovery evidence is not owned by the frozen TaskCase: ${refs[0]}.`,
    );
  }
  return owned;
}

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
  const owned = ownedRecoveryRefs(
    result.evidenceRefs,
    knownRefs.map((ref) => ({ ref })),
  );
  if (result.status === "recovered" && !owned.length) {
    throw new RecoveryEvidenceValidationError(
      "recovered status requires owned evidence references.",
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
export function isRelativePath(value: string): boolean {
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

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  return value;
}
export function integer(
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


export { recoveryObservationTools, type RecoveryObservationOperation, type RecoveryObservationOptions } from "./recovery-observation-tools.js";
export { recoveryTools, type RecoveryToolOptions, type RecoveryToolFilesystem, type RecoveryToolOperation } from "./recovery-workspace-tools.js";
