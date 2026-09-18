import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TaskCase } from "../core/schema.js";
import { sha256File } from "../core/identity.js";
import { sniffComparisonImageMediaType } from "./comparison-media.js";
import {
  addHistoricalDeliverableBasenames,
  addHistoricalImageBasenames,
  finalDeliverableRank,
  isHistoricalImagePath,
  isHistoricalVisualPath,
  isOpenableFinalPath,
} from "./openable-final-path.js";

export type HistoricalDeliverableKind = "final" | "openable-baseline" | "image";

export type HistoricalSearchRoot = {
  root: string;
  mode: "direct-basename" | "recursive-basename";
};

export function collectHistoricalDeliverableNames(taskCase: TaskCase, kind: HistoricalDeliverableKind): Set<string> {
  const names = new Set<string>();
  for (const ref of taskCase.baseline.artifactRefs) {
    if (ref.artifactId) names.add(ref.artifactId);
  }
  if (kind === "openable-baseline" || kind === "image") {
    for (const ref of taskCase.sourceRuntimeEvidence.artifactRefs) {
      if (ref.artifactId) names.add(ref.artifactId);
    }
  }
  if (kind === "final") {
    addHistoricalDeliverableBasenames(taskCase.baseline.finalMessage ?? "", names);
    for (const message of taskCase.transcript) addHistoricalDeliverableBasenames(message.text, names);
    return names;
  }
  if (kind === "image") {
    addHistoricalImageBasenames(taskCase.initialInput.text, names);
    addHistoricalImageBasenames(taskCase.baseline.finalMessage ?? "", names);
    for (const message of taskCase.transcript) addHistoricalImageBasenames(message.text, names);
  }
  return names;
}

export function collectHistoricalFinalNames(taskCase: TaskCase): Set<string> {
  return collectHistoricalDeliverableNames(taskCase, "final");
}

async function fileExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

async function findFileByBasename(root: string, basenameTarget: string): Promise<string | undefined> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== basenameTarget) continue;
    const parent = "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : root;
    return join(parent, entry.name);
  }
  return undefined;
}

export function historicalFinalSearchRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
}): HistoricalSearchRoot[] {
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: HistoricalSearchRoot[] = [];
  if (input.attemptRoot) {
    roots.push({ root: join(input.attemptRoot, "history", "finals"), mode: "direct-basename" });
  }
  roots.push({ root: join(controllerRoot, "history"), mode: "recursive-basename" });
  if (input.dataDir) {
    roots.push({ root: join(input.dataDir, "cases", input.caseId, "baseline-artifacts"), mode: "recursive-basename" });
  }
  roots.push({ root: join(input.experimentRoot, "environment", "baselines"), mode: "recursive-basename" });
  return roots;
}

export async function lookupBasename(
  roots: readonly HistoricalSearchRoot[],
  basenameTarget: string,
): Promise<string | undefined> {
  for (const entry of roots) {
    const absolutePath = entry.mode === "direct-basename"
      ? join(entry.root, basenameTarget)
      : await findFileByBasename(entry.root, basenameTarget);
    if (absolutePath && await fileExists(absolutePath)) return absolutePath;
  }
  return undefined;
}

export async function findFileInHistoricalRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  basename: string;
}): Promise<string | undefined> {
  return lookupBasename(historicalFinalSearchRoots(input), input.basename);
}

export async function resolveHistoricalFinalPath(input: {
  experimentRoot: string;
  runId: string;
  taskCase: TaskCase;
  dataDir?: string;
  attemptRoot?: string;
}): Promise<string | undefined> {
  const names = [...collectHistoricalDeliverableNames(input.taskCase, "final")].sort(
    (left, right) => finalDeliverableRank(left) - finalDeliverableRank(right),
  );
  if (!names.length) return undefined;
  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
  });
  for (const name of names) {
    const absolutePath = await lookupBasename(roots, name);
    if (!absolutePath || !isHistoricalVisualPath(absolutePath)) continue;
    return absolutePath;
  }
  return undefined;
}

export async function discoverBaselineOpenableSources(input: {
  attemptRoot: string;
  experimentRoot: string;
  runId: string;
  dataDir?: string;
  caseId: string;
  baselineArtifactNames: readonly string[];
}): Promise<{ inspectPath: string; absolutePath: string }[]> {
  const baselineSources: { inspectPath: string; absolutePath: string }[] = [];
  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    attemptRoot: input.attemptRoot,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  });
  for (const name of input.baselineArtifactNames) {
    const absolutePath = await lookupBasename(roots, name);
    if (!absolutePath || !isOpenableFinalPath(absolutePath)) continue;
    baselineSources.push({ inspectPath: sealedInspectPath(absolutePath, name), absolutePath });
  }
  return baselineSources;
}

export function sealedInspectPath(absolutePath: string, fallbackBasename?: string): string {
  const name = basename(absolutePath) || fallbackBasename || "artifact";
  return `history/finals/${name}`;
}

export async function sealBaselineOpenablePath(sealedRoot: string, absolutePath: string): Promise<string> {
  const name = basename(absolutePath);
  const dest = join(sealedRoot, name);
  if (await fileExists(dest)) {
    const [existingHash, incomingHash] = await Promise.all([sha256File(dest), sha256File(absolutePath)]);
    if (existingHash === incomingHash) return dest;
    throw new Error(`Duplicate baseline final basename "${name}" under ${sealedRoot}`);
  }
  await mkdir(sealedRoot, { recursive: true });
  await copyFile(absolutePath, dest);
  return dest;
}

export async function isHistoricalImageFile(path: string): Promise<boolean> {
  if (isHistoricalImagePath(path)) return true;
  return Boolean(await sniffComparisonImageMediaType(path));
}
