import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { SAFE_ID } from "../core/identity.js";
import { sameFsPath } from "../core/paths.js";
import type { RunInspection } from "./comparison.js";
import type { ExperimentResult } from "./experiment.js";
import { resolveHistoricalFinalPath } from "./historical-final-discovery.js";
import { finalDeliverableRank, isHistoricalVisualPath } from "./openable-final-path.js";
import type { TaskCase } from "../core/schema.js";

export type ResultPathLinks = {
  readonly report?: string;
  readonly historyFinal?: string;
  readonly candidateFinal?: string;
  readonly trace?: string;
  readonly replica?: string;
};

/** Accepts only the two Host-owned Provider layouts recorded for this candidate run. */
export function replicaWorkspaceLocation(experimentRoot: string, runId: string, workspaceRoot: string): { providerRoot: string; workspaceRoot: string } | undefined {
  if (!SAFE_ID.test(runId)) return undefined;
  const environmentRoot = resolve(experimentRoot, 'environment');
  const workspacePath = resolve(workspaceRoot);
  if (sameFsPath(workspacePath, join(environmentRoot, 'runs', runId))) {
    return { providerRoot: environmentRoot, workspaceRoot: workspacePath };
  }
  const parts = relative(join(environmentRoot, 'recovery'), workspacePath).split(sep);
  if (parts.length !== 3 || !SAFE_ID.test(parts[0] ?? '') || parts[1] !== 'runs' || parts[2] !== runId) return undefined;
  return { providerRoot: join(environmentRoot, 'recovery', parts[0]!), workspaceRoot: workspacePath };
}

export async function buildResultPathLinks(input: {
  experimentRoot: string;
  runId: string;
  reportPath?: string;
  taskCase: TaskCase;
  inspection: RunInspection;
  workspaceRoot: string;
  dataDir?: string;
  attemptRoot?: string;
}): Promise<ResultPathLinks> {
  const historyFinal = await resolveHistoricalFinalPath({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    taskCase: input.taskCase,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    ...(input.attemptRoot ? { attemptRoot: input.attemptRoot } : {}),
  });
  const candidateFinal = await resolveCandidateFinal(input);
  const report = presentableReportPath(input.reportPath, input.experimentRoot);
  return {
    ...(report ? { report } : {}),
    ...(historyFinal ? { historyFinal } : {}),
    ...(candidateFinal ? { candidateFinal } : {}),
    trace: join(input.experimentRoot, "runs", input.runId),
    ...(replicaWorkspaceLocation(input.experimentRoot, input.runId, input.workspaceRoot)
      ? { replica: resolve(input.workspaceRoot) } : {}),
  };
}

/** Report file path, or undefined when the stored path is the experiment root (skipped comparison). */
export function presentableReportPath(
  report: string | undefined,
  experimentRoot: string | undefined,
): string | undefined {
  if (!report?.trim()) return undefined;
  if (experimentRoot && sameFsPath(report, experimentRoot)) return undefined;
  return report.trim();
}

export function resolveResultPathLinks(result: ExperimentResult): ResultPathLinks {
  if (result.pathLinks) {
    const { report: storedReport, ...rest } = result.pathLinks;
    const report = presentableReportPath(storedReport, result.experimentRoot);
    return { ...rest, ...(report ? { report } : {}) };
  }
  const runId = result.record.attempt?.runId;
  const report = presentableReportPath(result.reportPath, result.experimentRoot);
  if (!runId || !result.experimentRoot) {
    return { ...(report ? { report } : {}) };
  }
  return {
    ...(report ? { report } : {}),
    trace: join(result.experimentRoot, "runs", runId),
    ...(replicaWorkspaceLocation(result.experimentRoot, runId,
      result.record.manifest?.environment.workspacePath ?? join(result.experimentRoot, "environment", "runs", runId))
      ? { replica: resolve(result.record.manifest?.environment.workspacePath ?? join(result.experimentRoot, "environment", "runs", runId)) } : {}),
  };
}

async function resolveCandidateFinal(input: {
  experimentRoot: string;
  runId: string;
  inspection: RunInspection;
  workspaceRoot: string;
}): Promise<string | undefined> {
  const ranked = [...input.inspection.changedPaths]
    .filter((path) => isHistoricalVisualPath(path))
    .sort((left, right) => finalDeliverableRank(left) - finalDeliverableRank(right));
  for (const path of ranked) {
    const absolutePath = join(input.workspaceRoot, ...path.split("/"));
    if (await access(absolutePath, constants.F_OK).then(() => true, () => false)) return absolutePath;
  }
  return undefined;
}
