import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonLinkRecord, HistoricalArtifactManifest, TaskCase } from "../core/schema.js";
import { HistoricalArtifactManifestSchema } from "../core/schema.js";
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
import { DERIVED_HISTORY_DIR } from "./prepare-historical-artifacts.js";

export type HistoricalDeliverableKind = "final" | "openable-baseline" | "image";

export type HistoricalSearchRoot = {
  root: string;
  mode: "direct-basename" | "recursive-basename";
  /** When true, files here are task start-state and need separate provenance to count as finals. */
  startStateOnly?: boolean;
};

export type HistoricalRootIndex = {
  pathsByBasename: ReadonlyMap<string, readonly string[]>;
};

export type BasenameLookup =
  | { status: "found"; path: string }
  | { status: "ambiguous"; paths: readonly string[] }
  | { status: "missing" };

export type HistoricalSourceResolution =
  | { kind: "manifest"; artifactId: string; logicalPath: string; absolutePath: string }
  | { kind: "basename-legacy"; basename: string; absolutePath: string }
  | { kind: "ambiguous"; basename: string; candidates: readonly string[] }
  | { kind: "unavailable"; reason: string };

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
    // Name clues from transcript alone are not openable sources; extract must
    // materialize refs/bytes first (empty artifactRefs stay empty).
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

type MutableHistoricalRootIndex = {
  pathsByBasename: Map<string, string[]>;
  claimedRootByBasename: Map<string, string>;
};

function recordBasename(
  index: MutableHistoricalRootIndex,
  name: string,
  absolutePath: string,
  root: string,
): void {
  const claimed = index.claimedRootByBasename.get(name);
  if (!claimed) {
    index.claimedRootByBasename.set(name, root);
    index.pathsByBasename.set(name, [absolutePath]);
    return;
  }
  if (claimed !== root) return;
  const existing = index.pathsByBasename.get(name)!;
  if (!existing.includes(absolutePath)) existing.push(absolutePath);
}

async function considerIndexedFile(
  file: Dirent,
  root: string,
  index: MutableHistoricalRootIndex,
  enrichImageNames?: Set<string>,
): Promise<void> {
  if (!file.isFile()) return;
  const absolutePath = join(root, file.name);
  recordBasename(index, file.name, absolutePath, root);
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
  index: MutableHistoricalRootIndex,
  enrichImageNames?: Set<string>,
): Promise<void> {
  if (!file.isFile()) return;
  const absolutePath = direntAbsolutePath(file, root);
  recordBasename(index, file.name, absolutePath, root);
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
  options?: { enrichImageNames?: Set<string>; includeStartState?: boolean },
): Promise<HistoricalRootIndex> {
  const index: MutableHistoricalRootIndex = {
    pathsByBasename: new Map(),
    claimedRootByBasename: new Map(),
  };
  const enrichImageNames = options?.enrichImageNames;
  for (const entry of roots) {
    if (entry.startStateOnly && !options?.includeStartState) continue;
    if (entry.mode === "direct-basename") {
      const files = await readdir(entry.root, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        await considerIndexedFile(file, entry.root, index, enrichImageNames);
      }
      continue;
    }
    const files = await readdir(entry.root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const file of files) {
      await considerIndexedRecursiveFile(file, entry.root, index, enrichImageNames);
    }
  }
  return { pathsByBasename: index.pathsByBasename };
}

export function lookupBasenameResult(index: HistoricalRootIndex, basenameTarget: string): BasenameLookup {
  const paths = index.pathsByBasename.get(basenameTarget) ?? [];
  if (paths.length === 0) return { status: "missing" };
  if (paths.length === 1) return { status: "found", path: paths[0]! };
  return { status: "ambiguous", paths };
}

/** @deprecated Prefer lookupBasenameResult; first-match is unsafe under ambiguity. */
export function lookupBasenameFromIndex(index: HistoricalRootIndex, basenameTarget: string): string | undefined {
  const result = lookupBasenameResult(index, basenameTarget);
  return result.status === "found" ? result.path : undefined;
}

export function historicalFinalSearchRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  finalsRoot?: string;
}): HistoricalSearchRoot[] {
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: HistoricalSearchRoot[] = [];
  if (input.finalsRoot) {
    roots.push({ root: input.finalsRoot, mode: "recursive-basename" });
  }
  if (input.attemptRoot) {
    roots.push({ root: join(input.attemptRoot, "finals"), mode: "direct-basename" });
    roots.push({ root: join(input.attemptRoot, DERIVED_HISTORY_DIR), mode: "recursive-basename" });
    // Legacy seal location retained for already-materialized attempts.
    roots.push({ root: join(input.attemptRoot, "history", "finals"), mode: "direct-basename" });
  }
  roots.push({ root: join(controllerRoot, "history"), mode: "recursive-basename" });
  if (input.dataDir) {
    roots.push({ root: join(input.dataDir, "cases", input.caseId, "baseline-artifacts"), mode: "recursive-basename" });
  }
  roots.push({
    root: join(input.experimentRoot, "environment", "baselines"),
    mode: "recursive-basename",
    startStateOnly: true,
  });
  return roots;
}

export async function lookupBasename(
  roots: readonly HistoricalSearchRoot[],
  basenameTarget: string,
  index?: HistoricalRootIndex,
): Promise<string | undefined> {
  const resolvedIndex = index ?? await indexHistoricalRoots(roots);
  const result = lookupBasenameResult(resolvedIndex, basenameTarget);
  if (result.status !== "found") return undefined;
  if (!(await fileExists(result.path))) return undefined;
  return result.path;
}

export async function findFileInHistoricalRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  finalsRoot?: string;
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
  finalsRoot?: string;
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
  finalsRoot?: string;
}): Promise<{ names: Set<string>; index: HistoricalRootIndex }> {
  const names = collectHistoricalDeliverableNames(input.taskCase, "image");
  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
  });
  const index = await indexHistoricalRoots(roots, { enrichImageNames: names });
  return { names, index };
}

async function loadManifestFromRoot(root: string): Promise<HistoricalArtifactManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown;
    if (!Value.Check(HistoricalArtifactManifestSchema, raw)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export async function resolveFromHistoricalManifest(input: {
  finalsRoot?: string;
  caseArtifactsRoot?: string;
  derivedRoot?: string;
  nameOrLogicalPath: string;
}): Promise<HistoricalSourceResolution | undefined> {
  const roots = [input.finalsRoot, input.derivedRoot, input.caseArtifactsRoot].filter(
    (value): value is string => Boolean(value),
  );
  for (const root of roots) {
    const manifest = await loadManifestFromRoot(root);
    if (!manifest) continue;
    for (const artifact of manifest.artifacts) {
      if (artifact.finality !== "final") continue;
      const logical = artifact.logicalPath.replace(/\\/g, "/");
      const base = basename(logical);
      if (
        artifact.artifactId !== input.nameOrLogicalPath
        && logical !== input.nameOrLogicalPath
        && base !== input.nameOrLogicalPath
      ) {
        continue;
      }
      const absolutePath = join(root, "files", artifact.bundleId, ...logical.split("/"));
      if (!(await fileExists(absolutePath))) {
        return { kind: "unavailable", reason: `manifest entry missing on disk: ${logical}` };
      }
      return {
        kind: "manifest",
        artifactId: artifact.artifactId,
        logicalPath: logical,
        absolutePath,
      };
    }
  }
  return undefined;
}

export async function resolveHistoricalImagePath(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
  finalsRoot?: string;
  basename: string;
  index?: HistoricalRootIndex;
}): Promise<string | undefined> {
  const roots = historicalFinalSearchRoots(input);
  const result = input.index
    ? lookupBasenameResult(input.index, input.basename)
    : lookupBasenameResult(await indexHistoricalRoots(roots), input.basename);
  if (result.status !== "found") return undefined;
  return (await isHistoricalImageFile(result.path)) ? result.path : undefined;
}

export async function buildSealedBaselineImageLinks(input: {
  attemptRoot: string;
  experimentRoot: string;
  dataDir?: string;
  taskCase: TaskCase;
  runId: string;
  finalsRoot?: string;
}): Promise<ComparisonLinkRecord[]> {
  const { names, index } = await collectHistoricalImageNames({
    taskCase: input.taskCase,
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    attemptRoot: input.attemptRoot,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
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
      ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
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
  finalsRoot?: string;
}): Promise<string | undefined> {
  const names = [...collectHistoricalDeliverableNames(input.taskCase, "final")].sort(
    (left, right) => finalDeliverableRank(left) - finalDeliverableRank(right),
  );
  if (!names.length) return undefined;

  const caseArtifactsRoot = input.dataDir
    ? join(input.dataDir, "cases", input.taskCase.caseId, "baseline-artifacts")
    : undefined;
  const derivedRoot = input.attemptRoot ? join(input.attemptRoot, DERIVED_HISTORY_DIR) : undefined;

  for (const name of names) {
    const fromManifest = await resolveFromHistoricalManifest({
      nameOrLogicalPath: name,
      ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
      ...(caseArtifactsRoot ? { caseArtifactsRoot } : {}),
      ...(derivedRoot ? { derivedRoot } : {}),
    });
    if (fromManifest?.kind === "manifest" && isHistoricalVisualPath(fromManifest.absolutePath)) {
      return fromManifest.absolutePath;
    }
    if (fromManifest?.kind === "unavailable" || fromManifest?.kind === "ambiguous") continue;
  }

  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
    ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
  });
  const index = await indexHistoricalRoots(roots);
  for (const name of names) {
    const result = lookupBasenameResult(index, name);
    if (result.status === "ambiguous") continue;
    if (result.status !== "found") continue;
    if (!isHistoricalVisualPath(result.path)) continue;
    if (!(await fileExists(result.path))) continue;
    return result.path;
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
  finalsRoot?: string;
}): Promise<{ inspectPath: string; absolutePath: string }[]> {
  const baselineSources: { inspectPath: string; absolutePath: string }[] = [];
  const caseArtifactsRoot = input.dataDir
    ? join(input.dataDir, "cases", input.caseId, "baseline-artifacts")
    : undefined;
  const derivedRoot = join(input.attemptRoot, DERIVED_HISTORY_DIR);
  const seen = new Set<string>();

  for (const name of input.baselineArtifactNames) {
    const fromManifest = await resolveFromHistoricalManifest({
      nameOrLogicalPath: name,
      ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
      ...(caseArtifactsRoot ? { caseArtifactsRoot } : {}),
      derivedRoot,
    });
    if (fromManifest?.kind === "manifest") {
      if (!isOpenableFinalPath(fromManifest.absolutePath)) continue;
      if (seen.has(fromManifest.absolutePath)) continue;
      seen.add(fromManifest.absolutePath);
      baselineSources.push({
        inspectPath: sealedInspectPath(fromManifest.absolutePath, basename(fromManifest.logicalPath)),
        absolutePath: fromManifest.absolutePath,
      });
      continue;
    }
  }

  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    attemptRoot: input.attemptRoot,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.finalsRoot ? { finalsRoot: input.finalsRoot } : {}),
  });
  const index = await indexHistoricalRoots(roots);
  for (const name of input.baselineArtifactNames) {
    const result = lookupBasenameResult(index, name);
    if (result.status !== "found") continue;
    if (!(await fileExists(result.path)) || !isOpenableFinalPath(result.path)) continue;
    if (seen.has(result.path)) continue;
    seen.add(result.path);
    baselineSources.push({ inspectPath: sealedInspectPath(result.path, name), absolutePath: result.path });
  }
  return baselineSources;
}

export function sealedInspectPath(absolutePath: string, fallbackBasename?: string): string {
  const name = basename(absolutePath) || fallbackBasename || "artifact";
  return `finals/${name}`;
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
