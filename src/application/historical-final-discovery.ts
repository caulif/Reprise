import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TaskCase } from "../core/schema.js";
import { isOpenableFinalPath } from "./comparison-openable-media.js";
import { isComparisonImagePath } from "./comparison-media.js";

const FINAL_RANK = (path: string): number => {
  const lower = path.toLowerCase();
  if (/\.(html|htm|xhtml)$/.test(lower)) return 0;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) return 1;
  return 2;
};

export function collectHistoricalFinalNames(taskCase: TaskCase): Set<string> {
  const names = new Set<string>();
  for (const ref of taskCase.baseline.artifactRefs) {
    if (ref.artifactId) names.add(ref.artifactId);
  }
  addDeliverableNames(taskCase.baseline.finalMessage ?? "", names);
  for (const message of taskCase.transcript) addDeliverableNames(message.text, names);
  return names;
}

function addDeliverableNames(text: string, names: Set<string>): void {
  for (const match of text.matchAll(/([^\\/\s:"<>|]+\.(?:html|htm|xhtml|png|jpe?g|gif|webp|svg|avif))/gi)) {
    const base = match[1]?.split(/[/\\]/).pop();
    if (base && !base.startsWith(".")) names.add(base);
  }
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

export async function resolveHistoricalFinalPath(input: {
  experimentRoot: string;
  runId: string;
  taskCase: TaskCase;
  dataDir?: string;
  attemptRoot?: string;
}): Promise<string | undefined> {
  const names = [...collectHistoricalFinalNames(input.taskCase)].sort((left, right) => FINAL_RANK(left) - FINAL_RANK(right));
  if (!names.length) return undefined;
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: string[] = [];
  if (input.attemptRoot) roots.push(join(input.attemptRoot, "history", "finals"));
  roots.push(join(controllerRoot, "history"));
  if (input.dataDir) roots.push(join(input.dataDir, "cases", input.taskCase.caseId, "baseline-artifacts"));
  roots.push(join(input.experimentRoot, "environment", "baselines"));
  for (const name of names) {
    for (const root of roots) {
      const absolutePath = root.endsWith("finals")
        ? join(root, name)
        : await findFileByBasename(root, name);
      if (!absolutePath || !(await fileExists(absolutePath))) continue;
      if (!isOpenableFinalPath(absolutePath) && !isComparisonImagePath(absolutePath)) continue;
      return absolutePath;
    }
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
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: string[] = [join(input.attemptRoot, "history", "finals"), join(controllerRoot, "history")];
  if (input.dataDir) roots.push(join(input.dataDir, "cases", input.caseId, "baseline-artifacts"));
  roots.push(join(input.experimentRoot, "environment", "baselines"));
  for (const name of input.baselineArtifactNames) {
    for (const root of roots) {
      const absolutePath = root.endsWith("finals")
        ? join(root, name)
        : await findFileByBasename(root, name);
      if (!absolutePath || !(await fileExists(absolutePath)) || !isOpenableFinalPath(absolutePath)) continue;
      baselineSources.push({ inspectPath: sealedInspectPath(absolutePath, name), absolutePath });
      break;
    }
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
    const existing = await stat(dest);
    const incoming = await stat(absolutePath);
    if (existing.size === incoming.size && existing.mtimeMs === incoming.mtimeMs) return dest;
    throw new Error(`Duplicate baseline final basename "${name}" under ${sealedRoot}`);
  }
  const { copyFile, mkdir } = await import("node:fs/promises");
  await mkdir(sealedRoot, { recursive: true });
  await copyFile(absolutePath, dest);
  return dest;
}
