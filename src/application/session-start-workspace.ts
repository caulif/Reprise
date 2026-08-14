import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { TaskCase } from "../core/schema.js";
import { historicalCwdOf } from "./replay-conditions.js";

export type SessionStartRewind = {
  readonly removed: readonly string[];
};

/** Host-owned start-state reconstruction. Never touches the user's original directory. */
export async function rewindIsolatedWorkspaceToStart(input: {
  workspaceRoot: string;
  taskCase: TaskCase;
  historicalCwd?: string;
}): Promise<SessionStartRewind> {
  const root = resolve(input.workspaceRoot);
  const cwd = input.historicalCwd ?? historicalCwdOf(input.taskCase);
  const removed: string[] = [];
  for (const raw of sessionWritePaths(input.taskCase, cwd)) {
    const target = resolve(root, raw);
    if (!insideRoot(root, target)) continue;
    try {
      await stat(target);
    } catch {
      continue;
    }
    await rm(target, { recursive: true, force: true });
    removed.push(raw.replaceAll("\\", "/"));
    await pruneEmptyParents(root, target);
  }
  return { removed };
}

export function sessionWritePaths(
  taskCase: TaskCase,
  historicalCwd?: string,
): readonly string[] {
  const behavior = record(taskCase.taskContext?.historicalBehavior);
  const listed = behavior.touchedPaths;
  const raw = Array.isArray(listed)
    ? listed.filter((item): item is string => typeof item === "string")
    : [];
  const cwd = historicalCwd ?? historicalCwdOf(taskCase);
  const unique = new Set<string>();
  for (const item of raw) {
    const relativePath = toReplicaRelative(item, cwd);
    if (relativePath) unique.add(relativePath);
  }
  return [...unique].sort();
}

function toReplicaRelative(
  value: string,
  historicalCwd: string | undefined,
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1_024) return undefined;
  const normalized = trimmed.replaceAll("\\", "/");
  if (normalized.includes("\0") || normalized.split("/").includes(".."))
    return undefined;
  if (!isAbsolute(trimmed)) {
    return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
  }
  if (!historicalCwd) return undefined;
  const rel = relative(resolve(historicalCwd), resolve(trimmed)).replaceAll(
    "\\",
    "/",
  );
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel;
}

function insideRoot(root: string, target: string): boolean {
  const base = resolve(root).toLowerCase();
  const next = resolve(target).toLowerCase();
  return next === base || next.startsWith(`${base}\\`) || next.startsWith(`${base}/`);
}

async function pruneEmptyParents(root: string, deleted: string): Promise<void> {
  let current = resolve(deleted, "..");
  const base = resolve(root);
  while (insideRoot(base, current) && current.toLowerCase() !== base.toLowerCase()) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    if (entries.length) return;
    await rm(current, { recursive: true, force: true });
    current = resolve(current, "..");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
