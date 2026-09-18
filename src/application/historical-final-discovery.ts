import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ComparisonLinkRecord, TaskCase } from "../core/schema.js";
import { sha256File } from "../core/identity.js";
import { mediaTypeForComparisonPath, sniffComparisonImageMediaType } from "./comparison-media.js";
import {
  addHistoricalImageBasenames,
  addHistoricalDeliverableBasenames,
  finalDeliverableRank,
  isHistoricalImagePath,
  isHistoricalVisualPath,
  isImageDeliverableName,
  isOpenableFinalPath,
} from "./openable-final-path.js";

export type HistoricalDeliverableKind = "final" | "openable-baseline" | "image";

export type HistoricalSearchRoot = {
  root: string;
  mode: "direct-basename" | "recursive-basename";
};

export type HistoricalRootIndex = {
  pathsByBasename: ReadonlyMap<string, string>;
};

export function collectHistoricalDeliverableNames(taskCase: TaskCase, kind: HistoricalDeliverableKind): Set<string> {
  const names = new Set<string>();
  if (kind === "image") {
    for (const ref of taskCase.baseline.artifactRefs) {
      if (ref.artifactId && isImageDeliverableName(ref.artifactId)) names.add(ref.artifactId);
    }
    for (const ref of taskCase.sourceRuntimeEvidence.artifactRefs) {
      if (ref.artifactId && isImageDeliverableName(ref.artifactId)) names.add(ref.artifactId);
    }
    addHistoricalImageBasenames(taskCase.initialInput.text, names);
    addHistoricalImageBasenames(taskCase.baseline.finalMessage ?? "", names);
    for (const message of taskCase.transcript) addHistoricalImageBasenames(message.text, names);
    return names;
  }
  for (const ref of taskCase.baseline.artifactRefs) {
    if (ref.artifactId) names.add(ref.artifactId);
  }
  if (kind === "openable-baseline") {
    for (const ref of taskCase.sourceRuntimeEvidence.artifactRefs) {
      if (ref.artifactId) names.add(ref.artifactId);
    }
    return names;
  }
  addHistoricalDeliverableBasenames(taskCase.baseline.finalMessage ?? "", names);
  for (const message of taskCase.transcript) addHistoricalDeliverableBasenames(message.text, names);
  return names;
}

async function fileExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

function direntAbsolutePath(entry: Dirent, root: string): string {
  const parent = "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : root;
  return join(parent, entry.name);
}

async function considerIndexedFile(
  file: Dirent,
  root: string,
  pathsByBasename: Map<string, string>,
  enrichImageNames?: Set<string>,
): Promise<void> {
  if (!file.isFile()) return;
  const absolutePath = join(root, file.name);
  if (!pathsByBasename.has(file.name)) pathsByBasename.set(file.name, absolutePath);
  if (!enrichImageNames) return;
  if (file.name.endsWith(".txt")) {
    const body = await readFile(absolutePath, "utf8").catch(() => "");
    addHistoricalImageBasenames(body, enrichImageNames);
    return;
  }
  if (await isHistoricalImageFile(absolutePath)) enrichImageNames.add(file.name);
}

async function considerIndexedRecursiveFile(
  file: Dirent,
  root: string,
  pathsByBasename: Map<string, string>,
  enrichImageNames?: Set<string>,
): Promise<void> {
  if (!file.isFile()) return;
  const absolutePath = direntAbsolutePath(file, root);
  if (!pathsByBasename.has(file.name)) pathsByBasename.set(file.name, absolutePath);
  if (!enrichImageNames) return;
  if (file.name.endsWith(".txt")) {
    const body = await readFile(absolutePath, "utf8").catch(() => "");
    addHistoricalImageBasenames(body, enrichImageNames);
    return;
  }
  if (await isHistoricalImageFile(absolutePath)) enrichImageNames.add(file.name);
}

export async function indexHistoricalRoots(
  roots: readonly HistoricalSearchRoot[],
  options?: { enrichImageNames?: Set<string> },
): Promise<HistoricalRootIndex> {
  const pathsByBasename = new Map<string, string>();
  const enrichImageNames = options?.enrichImageNames;
  for (const entry of roots) {
    if (entry.mode === "direct-basename") {
      const files = await readdir(entry.root, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        await considerIndexedFile(file, entry.root, pathsByBasename, enrichImageNames);
      }
      continue;
    }
    const files = await readdir(entry.root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const file of files) {
      await considerIndexedRecursiveFile(file, entry.root, pathsByBasename, enrichImageNames);
    }
  }
  return { pathsByBasename };
}

export function lookupBasenameFromIndex(index: HistoricalRootIndex, basenameTarget: string): string | undefined {
  return index.pathsByBasename.get(basenameTarget);
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
  index?: HistoricalRootIndex,
): Promise<string | undefined> {
  const resolved = index
    ? lookupBasenameFromIndex(index, basenameTarget)
    : lookupBasenameFromIndex(await indexHistoricalRoots(roots), basenameTarget);
  if (!resolved || !(await fileExists(resolved))) return undefined;
  return resolved;
}

export async function findFileInHistoricalRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  basename: string;
}): Promise<string | undefined> {
  const roots = historicalFinalSearchRoots(input);
  const index = await indexHistoricalRoots(roots);
  return lookupBasename(roots, input.basename, index);
}

export async function enrichHistoricalImageNamesFromRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  names: Set<string>;
}): Promise<void> {
  await indexHistoricalRoots(historicalFinalSearchRoots(input), { enrichImageNames: input.names });
}

export async function collectHistoricalImageNames(input: {
  taskCase: TaskCase;
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
}): Promise<{ names: Set<string>; index: HistoricalRootIndex }> {
  const names = collectHistoricalDeliverableNames(input.taskCase, "image");
  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  });
  const index = await indexHistoricalRoots(roots, { enrichImageNames: names });
  return { names, index };
}

export async function resolveHistoricalImagePath(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  basename: string;
  index?: HistoricalRootIndex;
}): Promise<string | undefined> {
  const roots = historicalFinalSearchRoots(input);
  const absolutePath = input.index
    ? lookupBasenameFromIndex(input.index, input.basename)
    : await lookupBasename(roots, input.basename);
  if (!absolutePath) return undefined;
  return (await isHistoricalImageFile(absolutePath)) ? absolutePath : undefined;
}

export async function buildSealedBaselineImageLinks(input: {
  attemptRoot: string;
  experimentRoot: string;
  dataDir?: string;
  taskCase: TaskCase;
  runId: string;
}): Promise<ComparisonLinkRecord[]> {
  const { names, index } = await collectHistoricalImageNames({
    taskCase: input.taskCase,
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    attemptRoot: input.attemptRoot,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  });
  if (names.size === 0) return [];
  const mediaRoot = join(input.attemptRoot, "history", "media");
  await mkdir(mediaRoot, { recursive: true });
  const links: ComparisonLinkRecord[] = [];
  for (const name of names) {
    const source = await resolveHistoricalImagePath({
      attemptRoot: input.attemptRoot,
      experimentRoot: input.experimentRoot,
      runId: input.runId,
      caseId: input.taskCase.caseId,
      basename: name,
      index,
      ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    });
    if (!source) continue;
    const dest = join(mediaRoot, name);
    await copyFile(source, dest);
    const info = await stat(dest).catch(() => undefined);
    const mediaType = await sniffComparisonImageMediaType(source) ?? mediaTypeForComparisonPath(name);
    links.push({
      side: "baseline",
      inspectPath: `history/media/${name}`,
      ...(mediaType ? { mediaType } : {}),
      ...(info?.isFile() ? { byteLength: info.size } : {}),
    });
  }
  return links;
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
  const index = await indexHistoricalRoots(roots);
  for (const name of names) {
    const absolutePath = lookupBasenameFromIndex(index, name);
    if (!absolutePath || !isHistoricalVisualPath(absolutePath)) continue;
    if (!(await fileExists(absolutePath))) continue;
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
  const index = await indexHistoricalRoots(roots);
  for (const name of input.baselineArtifactNames) {
    const absolutePath = lookupBasenameFromIndex(index, name);
    if (!absolutePath || !(await fileExists(absolutePath)) || !isOpenableFinalPath(absolutePath)) continue;
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
