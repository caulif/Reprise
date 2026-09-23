import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonLinkRecord, HistoricalArtifactManifest, TaskCase } from "../core/schema.js";
import { HistoricalArtifactManifestSchema } from "../core/schema.js";
import { sha256File } from "../core/identity.js";
import { pathContainedBy, relativeInside } from "../core/paths.js";
import { mediaTypeForComparisonPath, sniffComparisonImageMediaType } from "./comparison-media.js";
import {
  ATTEMPT_FINALS_DIR,
  CASE_BASELINE_ARTIFACTS_DIR,
  DERIVED_HISTORY_DIR,
  attemptFinalsRoot,
} from "./prepare-historical-artifacts.js";
import { validateLogicalPath } from "../products/shared/historical-artifact-apply.js";
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
  | { kind: "unavailable"; reason: string };

/**
 * Post-prepare discovery context. `finalsRoot` is always `attemptRoot/finals` when
 * an attempt is present — callers never spray an optional override.
 */
export type HistoricalFinalsContext = {
  readonly experimentRoot: string;
  readonly runId: string;
  readonly caseId: string;
  readonly attemptRoot?: string;
  readonly dataDir?: string;
  readonly finalsRoot?: string;
  readonly derivedRoot?: string;
  readonly caseArtifactsRoot?: string;
};

export function historicalFinalsContext(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  attemptRoot?: string;
  dataDir?: string;
}): HistoricalFinalsContext {
  return {
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    ...(input.attemptRoot
      ? {
          attemptRoot: input.attemptRoot,
          finalsRoot: attemptFinalsRoot(input.attemptRoot),
          derivedRoot: join(input.attemptRoot, DERIVED_HISTORY_DIR),
        }
      : {}),
    ...(input.dataDir
      ? {
          dataDir: input.dataDir,
          caseArtifactsRoot: join(input.dataDir, "cases", input.caseId, CASE_BASELINE_ARTIFACTS_DIR),
        }
      : {}),
  };
}

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

async function considerIndexedEntry(
  file: Dirent,
  root: string,
  absolutePath: string,
  index: MutableHistoricalRootIndex,
  enrichImageNames?: Set<string>,
): Promise<void> {
  if (!file.isFile()) return;
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
        await considerIndexedEntry(file, entry.root, join(entry.root, file.name), index, enrichImageNames);
      }
      continue;
    }
    const files = await readdir(entry.root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const file of files) {
      await considerIndexedEntry(file, entry.root, direntAbsolutePath(file, entry.root), index, enrichImageNames);
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

/** Ordered search roots from a post-prepare context. Attempt finals appear once (recursive). */
export function historicalFinalSearchRoots(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
}): HistoricalSearchRoot[] {
  const ctx = historicalFinalsContext(input);
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: HistoricalSearchRoot[] = [];
  if (ctx.finalsRoot) {
    roots.push({ root: ctx.finalsRoot, mode: "recursive-basename" });
  }
  if (ctx.derivedRoot) {
    roots.push({ root: ctx.derivedRoot, mode: "recursive-basename" });
  }
  if (input.attemptRoot) {
    // Legacy seal location retained for already-materialized attempts.
    roots.push({ root: join(input.attemptRoot, "history", ATTEMPT_FINALS_DIR), mode: "direct-basename" });
  }
  roots.push({ root: join(controllerRoot, "history"), mode: "recursive-basename" });
  if (ctx.caseArtifactsRoot) {
    roots.push({ root: ctx.caseArtifactsRoot, mode: "recursive-basename" });
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

async function collectHistoricalImageNames(input: {
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

async function loadManifestFromRoot(root: string): Promise<HistoricalArtifactManifest | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as unknown;
    if (!Value.Check(HistoricalArtifactManifestSchema, raw)) return undefined;
    return raw;
  } catch {
    // Missing/unreadable/invalid JSON at this root is a normal miss; try the next root.
    return undefined;
  }
}

async function absolutePathForManifestArtifact(
  root: string,
  artifact: { bundleId: string; logicalPath: string },
): Promise<string | undefined> {
  const pathCheck = validateLogicalPath(artifact.logicalPath);
  if (!pathCheck.ok) return undefined;
  const logical = pathCheck.path;
  const segments = logical.split("/");
  // Attempt-local finals use flat logicalPath; case/derived keep files/<bundleId>/…
  const flat = join(root, ...segments);
  if (await fileExists(flat)) return flat;
  const nested = join(root, "files", artifact.bundleId, ...segments);
  if (await fileExists(nested)) return nested;
  return undefined;
}

type ManifestCandidate = {
  artifactId: string;
  logicalPath: string;
  absolutePath: string;
};

async function resolveFromHistoricalManifest(input: {
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
    const exact: ManifestCandidate[] = [];
    const byBasename: ManifestCandidate[] = [];
    const missingLogical: string[] = [];
    for (const artifact of manifest.artifacts) {
      if (artifact.finality !== "final") continue;
      const pathCheck = validateLogicalPath(artifact.logicalPath);
      if (!pathCheck.ok) continue;
      const logical = pathCheck.path;
      const base = basename(logical);
      const exactHit = artifact.artifactId === input.nameOrLogicalPath || logical === input.nameOrLogicalPath;
      const baseHit = base === input.nameOrLogicalPath;
      if (!exactHit && !baseHit) continue;
      const absolutePath = await absolutePathForManifestArtifact(root, artifact);
      if (!absolutePath) {
        missingLogical.push(logical);
        continue;
      }
      const candidate = { artifactId: artifact.artifactId, logicalPath: logical, absolutePath };
      if (exactHit) exact.push(candidate);
      else byBasename.push(candidate);
    }
    if (exact.length === 1) {
      return { kind: "manifest", ...exact[0]! };
    }
    if (exact.length > 1) {
      return { kind: "unavailable", reason: `ambiguous manifest match for ${input.nameOrLogicalPath}` };
    }
    if (byBasename.length === 1) {
      return { kind: "manifest", ...byBasename[0]! };
    }
    if (byBasename.length > 1) {
      // Same basename under nested logicalPaths — refuse first-match; index path also fail-closes.
      return { kind: "unavailable", reason: `ambiguous basename "${input.nameOrLogicalPath}" in manifest` };
    }
    if (missingLogical.length > 0) {
      return { kind: "unavailable", reason: `manifest entry missing on disk: ${missingLogical[0]}` };
    }
  }
  return undefined;
}

async function resolveHistoricalImagePath(input: {
  experimentRoot: string;
  runId: string;
  caseId: string;
  dataDir?: string;
  attemptRoot?: string;
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

  const ctx = historicalFinalsContext({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
  });

  for (const name of names) {
    const fromManifest = await resolveFromHistoricalManifest({
      nameOrLogicalPath: name,
      ...(ctx.finalsRoot ? { finalsRoot: ctx.finalsRoot } : {}),
      ...(ctx.caseArtifactsRoot ? { caseArtifactsRoot: ctx.caseArtifactsRoot } : {}),
      ...(ctx.derivedRoot ? { derivedRoot: ctx.derivedRoot } : {}),
    });
    if (fromManifest?.kind === "manifest" && isHistoricalVisualPath(fromManifest.absolutePath)) {
      return fromManifest.absolutePath;
    }
    if (fromManifest?.kind === "unavailable") continue;
  }

  const roots = historicalFinalSearchRoots({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.taskCase.caseId,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
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
}): Promise<{ inspectPath: string; absolutePath: string }[]> {
  const baselineSources: { inspectPath: string; absolutePath: string }[] = [];
  const ctx = historicalFinalsContext({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    attemptRoot: input.attemptRoot,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  });
  const seen = new Set<string>();

  for (const name of input.baselineArtifactNames) {
    const fromManifest = await resolveFromHistoricalManifest({
      nameOrLogicalPath: name,
      ...(ctx.finalsRoot ? { finalsRoot: ctx.finalsRoot } : {}),
      ...(ctx.caseArtifactsRoot ? { caseArtifactsRoot: ctx.caseArtifactsRoot } : {}),
      ...(ctx.derivedRoot ? { derivedRoot: ctx.derivedRoot } : {}),
    });
    if (fromManifest?.kind === "manifest") {
      if (!isOpenableFinalPath(fromManifest.absolutePath)) continue;
      if (seen.has(fromManifest.absolutePath)) continue;
      seen.add(fromManifest.absolutePath);
      baselineSources.push({
        inspectPath: sealedInspectPath(fromManifest.absolutePath, fromManifest.logicalPath),
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

export function sealedInspectPath(absolutePath: string, logicalOrBasename?: string): string {
  const relative = (logicalOrBasename ?? basename(absolutePath)).replace(/\\/g, "/").replace(/^\/+/, "");
  return `finals/${relative || "artifact"}`;
}

/**
 * Seal an openable baseline into `sealedRoot/<logicalPath>` (default: basename).
 * Sources already under `sealedRoot` are left in place — prepare materializes the tree.
 */
export async function sealBaselineOpenablePath(
  sealedRoot: string,
  absolutePath: string,
  logicalPath?: string,
): Promise<string> {
  if (pathContainedBy(sealedRoot, absolutePath) && !sameLeafAsRoot(sealedRoot, absolutePath)) {
    return absolutePath;
  }
  let relativeDest: string;
  if (logicalPath) {
    const pathCheck = validateLogicalPath(logicalPath);
    if (!pathCheck.ok) {
      throw new Error(`Rejected seal logicalPath "${logicalPath}": ${pathCheck.reason}`);
    }
    relativeDest = pathCheck.path;
  } else {
    relativeDest = basename(absolutePath);
  }
  const dest = join(sealedRoot, ...relativeDest.split("/"));
  if (await fileExists(dest)) {
    const [existingHash, incomingHash] = await Promise.all([sha256File(dest), sha256File(absolutePath)]);
    if (existingHash === incomingHash) return dest;
    throw new Error(`Duplicate baseline final path "${relativeDest}" under ${sealedRoot}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(absolutePath, dest);
  return dest;
}

function sameLeafAsRoot(root: string, target: string): boolean {
  return relativeInside(root, target) === "";
}

async function isHistoricalImageFile(path: string): Promise<boolean> {
  if (isHistoricalImagePath(path)) return true;
  return Boolean(await sniffComparisonImageMediaType(path));
}
