import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  RecoveryPreTaskDiagnosisSchema,
  type RecoveryPreTaskDiagnosis,
  type TaskCase,
} from "../core/schema.js";
import { RecoveryValidationError } from "./local-workspace-provider.js";
import { runProcess } from "../infrastructure/process-runner.js";

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
): Promise<RecoveryPreTaskCheck> {
  const head = await gitOutput(root, ["rev-parse", "HEAD"]);
  if (!head) return diagnosis({ schemaVersion: 1, readyAllowed: true, reasons: [], dirtyPaths: [] });
  const recorded = recordedEventCommits(taskCase.historicalEvents);
  const existingRecorded: string[] = [];
  for (const commit of recorded) {
    const full = await gitOutput(root, ["rev-parse", "--verify", `${commit}^{commit}`]);
    if (full) existingRecorded.push(full);
  }
  const taskCommit = existingRecorded.length ? await earliestCommit(root, existingRecorded) : undefined;
  const historical = recordedHistoricalCommit(taskCase);
  const historicalFull = historical
    ? await gitOutput(root, ["rev-parse", "--verify", `${historical}^{commit}`])
    : undefined;
  const parentOfTask = taskCommit ? await gitOutput(root, ["rev-parse", `${taskCommit}^`]) : undefined;
  const preTaskCommit = historicalFull && historicalFull !== taskCommit
    ? historicalFull
    : parentOfTask;
  const reasons: string[] = [];
  if (taskCommit && (head === taskCommit || await isAncestor(root, taskCommit, head))) {
    reasons.push(`Work-copy HEAD already contains historical task commit ${taskCommit}.`);
  } else if (preTaskCommit && head !== preTaskCommit) {
    reasons.push(`Work-copy HEAD ${head} is not the pre-task commit ${preTaskCommit}.`);
  }
  const sessionEndedAt = latestHistoricalTime(taskCase);
  const dirtyPaths = sessionEndedAt ? await postTaskDirtyPaths(root, sessionEndedAt) : [];
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

export async function assertRecoveryReadyPreconditions(root: string, taskCase: TaskCase): Promise<void> {
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase);
  if (check.readyAllowed) return;
  throw new RecoveryValidationError(
    "provider_validation_failed",
    check.reasons.join(" ") || "Work-copy HEAD is not the pre-task commit.",
  );
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
  for (const [key, child] of Object.entries(value)) {
    if (/commit/i.test(key) && typeof child === "string" && GIT_SHA.test(child)) found.push(child);
    else recordedEventCommits(child, found);
  }
  return found;
}

function latestHistoricalTime(taskCase: TaskCase): string | undefined {
  const values = taskCase.historicalEvents.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    const record = event as Record<string, unknown>;
    return typeof record.timestamp === "string"
      ? [record.timestamp]
      : typeof record.time === "string"
        ? [record.time]
        : [];
  });
  return values.filter((value) => /^\d{4}-\d{2}-\d{2}T/.test(value)).sort().at(-1);
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
  } catch {
    return false;
  }
}

async function postTaskDirtyPaths(root: string, sessionEndedAt: string): Promise<string[]> {
  const status = await gitOutput(root, ["status", "--porcelain"]);
  if (status === undefined) return [];
  const ended = Date.parse(sessionEndedAt);
  if (!Number.isFinite(ended)) return [];
  const paths: string[] = [];
  for (const line of status.split("\n").map((item) => item.replace(/\r$/, "")).filter(Boolean)) {
    const relative = line.startsWith("?? ") ? line.slice(3) : line.slice(3);
    const posix = relative.replaceAll("\\", "/");
    if (!posix || isDependencyPath(posix)) continue;
    const info = await lstat(resolve(root, ...posix.split("/"))).catch(() => undefined);
    if (!info) continue;
    if (info.mtimeMs > ended) paths.push(posix);
  }
  return paths;
}

function isDependencyPath(posix: string): boolean {
  const normalized = posix.toLowerCase();
  return DEPENDENCY_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

async function gitOutput(root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const stdout = (await git(root, args)).trim();
    return stdout.length ? stdout : undefined;
  } catch {
    return undefined;
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  return (await runProcess({
    operation: "recovery_pre_task_git",
    executableKind: "git",
    command: "git",
    args,
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  })).stdout;
}
