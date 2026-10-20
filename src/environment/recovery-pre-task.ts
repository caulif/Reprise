import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import {
  RecoveryPreTaskDiagnosisSchema,
  RecoveryFrozenGitSchema, type RecoveryFrozenGit,
  type RecoveryPreTaskDiagnosis,
  type TaskCase,
  type RecoveryGitStart,
} from "../core/schema.js";
import { sha256 } from '../core/identity.js';
import { recoveryPath, assertNoSymlinkAncestors } from './local-workspace-fs.js';
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { runProcess, ProcessBoundaryError } from "../infrastructure/process-runner.js";
import { spawnCancelOptions, terminateProcessTree } from "../infrastructure/platform.js";

const GIT_SHA = /^[0-9a-f]{7,40}$/i;
const DEPENDENCY_PREFIXES = [
  "node_modules/",
  ".venv/",
  "venv/",
  "vendor/",
  "target/",
  "__pycache__/",
  ".pnpm-store/",
  ".cargo/",
  ".npm/",
];

export type RecoveryPreTaskCheck = RecoveryPreTaskDiagnosis;

/** Host facts for whether staging HEAD is the pre-task commit and post-task dirt is gone. */
export async function evaluateRecoveryPreTaskConditions(
  root: string,
  taskCase: TaskCase,
  gitStart?: RecoveryGitStart,
  evidenceRoot: string = root,
  frozen?: RecoveryFrozenGit,
): Promise<RecoveryPreTaskCheck> {
  if (gitStart) return checkConfirmedGitStart(root, gitStart);
  if (frozen?.state === "unavailable") return diagnosis({ schemaVersion: 1, readyAllowed: false, reasons: ["Protected source Git evidence was unavailable before recovery."], dirtyPaths: [] });
  if (frozen?.state === "unborn") {
    const reasons: string[] = [];
    if (!(await isUnbornRepository(root))) reasons.push("Work copy no longer matches the protected source's unborn Git state.");
    const dirtyPaths = reasons.length ? [] : await postTaskDirtyPaths(root, evidenceRoot);
    if (dirtyPaths.length) reasons.push("Work copy contains added or modified inputs not present in the protected source.");
    return diagnosis({ schemaVersion: 1, readyAllowed: reasons.length === 0, reasons, dirtyPaths });
  }
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (!head) {
    const isRepo = await gitOutput(evidenceRoot, ["rev-parse", "--is-inside-work-tree"]);
    return diagnosis({ schemaVersion: 1, readyAllowed: isRepo !== "true", reasons: isRepo === "true" ? ["Git HEAD is unavailable; a missing or corrupt repository cannot satisfy a known Git source."] : [], dirtyPaths: [] });
  }
  const recorded = frozen?.taskCommits ?? recordedEventCommits(taskCase.historicalEvents);
  const existingRecorded: string[] = [];
  for (const commit of recorded) {
    const full = await peelCommit(evidenceRoot, commit);
    if (full) existingRecorded.push(full);
  }
  const taskCommit = existingRecorded.length ? await earliestCommit(evidenceRoot, existingRecorded) : undefined;
  const historical = recordedHistoricalCommit(taskCase);
  const historicalFull = historical ? await peelCommit(evidenceRoot, historical) : undefined;
  const parentOfTask = taskCommit ? await gitOutput(evidenceRoot, ["rev-parse", `${taskCommit}~1`]) : undefined;
  const preTaskCommit = historicalFull && historicalFull !== taskCommit
    ? historicalFull
    : parentOfTask;
  const reasons: string[] = [];
  const knownSourceHead = !frozen || Boolean(frozen.commits[head]);
  if (taskCommit && (head === taskCommit || knownSourceHead && await isAncestor(evidenceRoot, taskCommit, head))) {
    reasons.push(`Work-copy HEAD already contains historical task commit ${taskCommit}.`);
  }
  if (evidenceRoot !== root) {
    const originalTree = frozen ? frozen.commits[head] : await gitOutput(evidenceRoot, ["rev-parse", `${head}:`]);
    const currentTree = await gitOutput(root, ["rev-parse", `${head}:`]);
    if (!originalTree || originalTree !== currentTree) reasons.push("Selected HEAD is absent from the protected source or its tree differs.");
    if (originalTree) for (const commit of existingRecorded) if (await isAncestor(evidenceRoot, commit, head)) reasons.push(`Selected HEAD contains historical task commit ${commit}.`);
  }
  const rebasePaths = await retainedRebasePaths(root, taskCase, frozen);
  const dirtyPaths = await postTaskDirtyPaths(root, evidenceRoot, rebasePaths);
  if (dirtyPaths.length) {
    reasons.push(`Post-task dirty paths remain visible: ${dirtyPaths.slice(0, 8).join(", ")}.`);
  }
  return diagnosis({
    schemaVersion: 1,
    readyAllowed: reasons.length === 0,
    reasons,
    dirtyPaths,
    ...(head ? { head } : {}),
    ...(preTaskCommit ? { preTaskCommit } : {}),
    ...(taskCommit ? { taskCommit } : {}),
  });
}

async function checkConfirmedGitStart(root: string, start: RecoveryGitStart): Promise<RecoveryPreTaskCheck> {
  const head = await gitOutput(root, ['rev-parse', 'HEAD']);
  const reasons: string[] = [];
  if (head !== start.commit) reasons.push('Work-copy HEAD is not the explicitly confirmed task-before commit.');
  for (const input of start.inputs) {
    await assertNoSymlinkAncestors(root, input.path);
    const bytes = await readFile(recoveryPath(root, input.path));
    if (sha256(bytes) !== input.sha256) reasons.push(`Confirmed input changed: ${input.path}.`);
  }
  const tracked = await git(root, ['diff', '--name-only', '-z', start.commit]);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  const allowed = new Set(start.inputs.map((input) => input.path));
  const dirtyPaths = `${tracked}\0${untracked}`.split('\0').filter((path) => path && !allowed.has(path));
  if (dirtyPaths.length) reasons.push('Unexpected paths changed after confirmed Git start restoration.');
  return diagnosis({ schemaVersion: 1, readyAllowed: reasons.length === 0, reasons, dirtyPaths,
    preTaskCommit: start.commit, ...(head ? { head } : {}) });
}

function diagnosis(value: RecoveryPreTaskCheck): RecoveryPreTaskCheck {
  if (!Value.Check(RecoveryPreTaskDiagnosisSchema, value)) {
    throw new Error("Recovery pre-task diagnosis does not match RecoveryPreTaskDiagnosisSchema.");
  }
  return value;
}

function recordedHistoricalCommit(taskCase: TaskCase): string | undefined {
  const value = taskCase.taskContext?.historicalCommit;
  return typeof value === "string" && GIT_SHA.test(value) ? value : undefined;
}

function recordedEventCommits(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) recordedEventCommits(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  if (record.type === "session_meta" || record.type === "turn_context") return found;
  for (const [key, child] of Object.entries(value)) {
    if (/commit/i.test(key) && typeof child === "string" && GIT_SHA.test(child)) found.push(child);
    else if (typeof child === "string") {
      // Git commit command receipts have [branch shortSHA] headers; arbitrary SHAs are not task commits.
      for (const match of child.matchAll(/\[[^\]\r\n]+\s([0-9a-f]{7,40})\] [^\r\n]+/gi)) found.push(match[1]!);
    } else recordedEventCommits(child, found);
  }
  return found;
}

async function earliestCommit(root: string, commits: string[]): Promise<string | undefined> {
  let earliest = commits[0];
  if (!earliest) return undefined;
  for (const commit of commits.slice(1)) {
    if (await isAncestor(root, commit, earliest)) earliest = commit;
  }
  return earliest;
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof ProcessBoundaryError && error.exitCategory === "nonzero_exit" && error.exitCode === 1) return false;
    throw error;
  }
}

async function retainedRebasePaths(root: string, taskCase: TaskCase, frozen?: RecoveryFrozenGit): Promise<Set<string>> {
  const input = taskCase.initialInput?.text ?? "";
  if (!/\brebase\b/i.test(input) || !/\bconflicts?\b|冲突/i.test(input)) return new Set();
  const active = ["rebase-merge", "rebase-apply"].some(name => existsSync(join(root, ".git", name)));
  if (!active) return new Set();
  const applying = await gitOutput(root, ["rev-parse", "--verify", "REBASE_HEAD"]);
  if (!applying || frozen && !frozen.commits[applying]) return new Set();
  // Only tracked changes belonging to the interrupted commit are rebase inputs.
  const affected = await git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", applying]);
  return new Set(affected.split("\0").filter(Boolean));
}

async function postTaskDirtyPaths(root: string, evidenceRoot: string, rebasePaths: Set<string>): Promise<string[]> {
  const output = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const rows = output.split("\0");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row) continue;
    const code = row.slice(0, 2);
    const relative = row.slice(3).replaceAll("\\", "/");
    // Rename/copy -z rows are "XY dest\0source\0"; inspect both paths as possible dirt.
    const paired = (code.includes("R") || code.includes("C")) ? (rows[++i] ?? "").replaceAll("\\", "/") : "";
    for (const candidate of paired ? [relative, paired] : [relative]) {
      if (!candidate || isDependencyPath(candidate)) continue;
      if (code !== "??" && rebasePaths.has(candidate)) continue;
      // Only source dirt with identical bytes can be a retained original input.
      if (evidenceRoot !== root) {
        const sourceDirty = await git(evidenceRoot, ["status", "--porcelain=v1", "-z", "--", candidate]);
        if (sourceDirty) {
          await assertNoSymlinkAncestors(root, candidate);
          await assertNoSymlinkAncestors(evidenceRoot, candidate);
          const before = await readFile(recoveryPath(evidenceRoot, candidate)).catch(() => undefined);
          const after = await readFile(recoveryPath(root, candidate)).catch(() => undefined);
          if (before && after && sha256(before) === sha256(after)) continue;
        }
      }
      paths.push(candidate);
    }
  }
  return paths.slice(0, 64);
}

function isDependencyPath(posix: string): boolean {
  const normalized = posix.toLowerCase();
  return DEPENDENCY_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

async function peelCommit(root: string, object: string): Promise<string | undefined> {
  const kind = await gitOutput(root, ["cat-file", "-t", object]);
  if (kind !== "commit") return undefined;
  return gitOutput(root, ["rev-parse", "--verify", object]);
}

async function gitOutput(root: string, args: readonly string[]): Promise<string | undefined> {
  const result = await runProcess({ operation: "recovery_pre_task_git_probe", executableKind: "git", command: "git", args,
    cwd: root, timeoutMs: 5000, maxOutputBytes: 16 * 1024 * 1024, allowNonzeroExit: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (result.exitCode === 0) return result.stdout.trim() || undefined;
  if (/not a git repository|unknown revision|ambiguous argument|bad object|Not a valid object name|Needed a single revision/i.test(result.stderr)) return undefined;
  throw new ProcessBoundaryError({ operation: "recovery_pre_task_git_probe", executableKind: "git", exitCategory: "nonzero_exit", exitCode: result.exitCode });
}

async function git(root: string, args: readonly string[], signal?: AbortSignal, timeoutMs = 5_000): Promise<string> {
  return (await runProcess({
    operation: "recovery_pre_task_git",
    executableKind: "git",
    command: "git",
    args,
    cwd: root,
    timeoutMs,
    ...(signal ? { signal } : {}),
    maxOutputBytes: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  })).stdout;
}


/** Stream cat-file --batch-all-objects and keep only commit ids absent from `known`. */
async function listCommitObjectsMissingFromMap(
  root: string,
  known: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<string[]> {
  if (signal?.aborted) {
    throw new ProcessBoundaryError({ operation: "recovery_pre_task_git", executableKind: "git", exitCategory: "cancelled" });
  }
  const child = spawn("git", ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"], {
    ...spawnCancelOptions(false),
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const missing: string[] = [];
  let timedOut = false;
  // Drain stderr so a full pipe cannot stall git; contents are intentionally unused.
  child.stderr?.on("data", () => undefined);
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessTree(child, false);
  }, 15_000);
  const onAbort = () => terminateProcessTree(child, false);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (!child.stdout) {
      throw new ProcessBoundaryError({ operation: "recovery_pre_task_git", executableKind: "git", exitCategory: "stdio_disconnected" });
    }
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const row of lines) {
      if (signal?.aborted) {
        throw new ProcessBoundaryError({ operation: "recovery_pre_task_git", executableKind: "git", exitCategory: "cancelled" });
      }
      if (!row.endsWith(" commit")) continue;
      const id = row.slice(0, row.indexOf(" "));
      if (id && !known[id]) missing.push(id);
    }
    const code = await closed;
    if (code !== 0) {
      throw new ProcessBoundaryError({
        operation: "recovery_pre_task_git",
        executableKind: "git",
        exitCategory: signal?.aborted ? "cancelled" : timedOut ? "timed_out" : "nonzero_exit",
        ...(typeof code === "number" ? { exitCode: code } : {}),
      });
    }
    return missing;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function freezeRecoveryGitEvidence(root: string, taskCase: TaskCase, sourceDigest: string, signal?: AbortSignal): Promise<RecoveryFrozenGit> {
  const commits: Record<string, string> = {};
  let state: RecoveryFrozenGit["state"] = "unavailable";
  try {
    const probe = await runProcess({ operation: "recovery_git_presence", executableKind: "git", command: "git", args: ["rev-parse", "--is-inside-work-tree"], cwd: root, timeoutMs: 15000, allowNonzeroExit: true, ...(signal ? { signal } : {}) });
    if (probe.exitCode !== 0) {
      state = existsSync(join(root, ".git")) ? "unavailable" : "non-git";
    } else if (await isUnbornRepository(root, signal)) {
      state = recordedHistoricalCommit(taskCase) || recordedEventCommits(taskCase.historicalEvents).length ? "unavailable" : "unborn";
    } else {
      const output = await git(root, ["log", "--all", "HEAD", "--format=%H %T"], signal, 15000);
      for (const row of output.trim().split("\n")) { const [commit, tree] = row.trim().split(" "); if (commit && tree) commits[commit] = tree; }
      // Ref traversal misses historical tips left behind by a rebase or deleted branch.
      // Stream object types so blob/tree names never fill the 16 MiB git() stdout cap.
      const missing = await listCommitObjectsMissingFromMap(root, commits, signal);
      for (let offset = 0; offset < missing.length; offset += 128) {
        const extra = await git(root, ["log", "--no-walk", "--format=%H %T", ...missing.slice(offset, offset + 128)], signal, 15000);
        for (const row of extra.trim().split("\n")) { const [commit, tree] = row.trim().split(" "); if (commit && tree) commits[commit] = tree; }
      }
      state = "git";
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Failed probes and corrupt repositories remain unavailable, never non-Git or unborn.
  }
  const taskCommits: string[] = [];
  for (const candidate of state === "git" ? recordedEventCommits(taskCase.historicalEvents) : []) {
    const matches = Object.keys(commits).filter(commit => commit.startsWith(candidate.toLowerCase()));
    if (matches.length === 1 && !taskCommits.includes(matches[0]!)) taskCommits.push(matches[0]!);
  }
  const result = { schemaVersion: 2 as const, state, commits, taskCommits, sourceDigest };
  if (!Value.Check(RecoveryFrozenGitSchema, result)) throw new Error("Frozen Git evidence failed schema validation.");
  return result;
}

async function isUnbornRepository(root: string, signal?: AbortSignal): Promise<boolean> {
  if (await gitOutput(root, ["rev-parse", "HEAD"])) return false;
  if ((await git(root, ["rev-parse", "--is-inside-work-tree"], signal)).trim() !== "true") return false;
  const ref = (await git(root, ["symbolic-ref", "-q", "HEAD"], signal)).trim();
  if (!ref.startsWith("refs/heads/")) return false;
  const head = await runProcess({ operation: "recovery_unborn_head", executableKind: "git", command: "git",
    args: ["show-ref", "--verify", "--quiet", ref], cwd: root, timeoutMs: 5000, allowNonzeroExit: true,
    ...(signal ? { signal } : {}) });
  if (head.exitCode !== 1) return false;
  if ((await git(root, ["log", "--all", "--reflog", "--format=%H"], signal)).trim()) return false;
  const objects = await git(root, ["fsck", "--full", "--no-reflogs"], signal);
  return !/\bcommit\b/.test(objects);
}
