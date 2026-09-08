import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isFsAbsolute, pathContainedBy, relativeInside } from "../core/paths.js";
import { writeAtomic } from "../core/identity.js";
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

const IMPORTED_INPUTS_DIR = "imported-inputs";
const MAX_IMPORTED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORTED_TOTAL_BYTES = 32 * 1024 * 1024;

export type ImportedTaskInput = {
  readonly source: string;
  readonly relative: string;
  readonly bytes: number;
};

/** Copy files the frozen user sentence named that sit outside historical cwd. Does not grant all-disk tools. */
export async function importExternalTaskInputs(input: {
  workspaceRoot: string;
  taskCase: TaskCase;
  historicalCwd?: string;
}): Promise<readonly ImportedTaskInput[]> {
  const root = resolve(input.workspaceRoot);
  const cwd = input.historicalCwd ?? historicalCwdOf(input.taskCase);
  const destRoot = resolve(root, IMPORTED_INPUTS_DIR);
  const imported: ImportedTaskInput[] = [];
  let total = 0;
  const used = new Set<string>();
  for (const source of absolutePathsInText(input.taskCase.initialInput.text)) {
    if (cwd && pathContainedBy(cwd, source)) continue;
    if (isSensitiveInputName(basename(source))) continue;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(source);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_IMPORTED_FILE_BYTES) continue;
    if (total + info.size > MAX_IMPORTED_TOTAL_BYTES) continue;
    const name = uniqueImportedName(basename(source), used);
    used.add(name);
    await mkdir(destRoot, { recursive: true });
    const relative = `${IMPORTED_INPUTS_DIR}/${name}`;
    await copyFile(source, resolve(root, relative));
    total += info.size;
    imported.push({ source, relative, bytes: info.size });
  }
  if (imported.length) {
    const lines = ["source\trelative\tbytes", ...imported.map((row) => `${row.source}\t${row.relative}\t${row.bytes}`)];
    await writeAtomic(resolve(destRoot, "MANIFEST.tsv"), `${lines.join("\n")}\n`);
  }
  return imported;
}

export async function materializeIsolatedStart(input: {
  workspaceRoot: string;
  taskCase: TaskCase;
  historicalCwd?: string;
  sourceRootKind: string;
}): Promise<{ sourceRootKind: string; startMutated: boolean; imported: readonly ImportedTaskInput[] }> {
  let sourceRootKind = input.sourceRootKind;
  let startMutated = false;
  const cwd = input.historicalCwd ? { historicalCwd: input.historicalCwd } : {};
  if (sourceRootKind === "historical_cwd") {
    const rewind = await rewindIsolatedWorkspaceToStart({
      workspaceRoot: input.workspaceRoot,
      taskCase: input.taskCase,
      ...cwd,
    });
    if (rewind.removed.length) {
      sourceRootKind = "historical_start";
      startMutated = true;
    }
  }
  const imported = await importExternalTaskInputs({
    workspaceRoot: input.workspaceRoot,
    taskCase: input.taskCase,
    ...cwd,
  });
  return { sourceRootKind, startMutated, imported };
}

export function absolutePathsInText(text: string): readonly string[] {
  const found = new Set<string>();
  const windows = /\b[A-Za-z]:[\\/][^\s"'<>|*?\u0000]+/g;
  const posix = /(?:^|[\s"'=(])(\/(?:[^\s"'<>|*?\u0000]+))/g;
  for (const match of text.matchAll(windows)) {
    const raw = match[0]?.replace(/[.,;:]+$/, "") ?? "";
    if (raw) found.add(raw);
  }
  for (const match of text.matchAll(posix)) {
    const raw = match[1]?.replace(/[.,;:]+$/, "") ?? "";
    if (raw.length > 1) found.add(raw);
  }
  return [...found];
}

function uniqueImportedName(base: string, used: Set<string>): string {
  const safe = base.replace(/[^\w.\u4e00-\u9fff-]+/g, "_") || "input";
  if (!used.has(safe)) return safe;
  let index = 2;
  while (used.has(`${index}-${safe}`)) index += 1;
  return `${index}-${safe}`;
}

function isSensitiveInputName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === "auth.json" ||
    lower.includes("credential") ||
    /\.(pem|key|p12|pfx)$/.test(lower)
  );
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
  if (!isFsAbsolute(trimmed)) {
    return normalized.replace(/^\.\//, "").replace(/\/+$/, "");
  }
  if (!historicalCwd) return undefined;
  const rel = relativeInside(historicalCwd, trimmed);
  if (!rel) return undefined;
  return rel;
}

function insideRoot(root: string, target: string): boolean {
  return pathContainedBy(root, target);
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
