import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
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
  return {
    ...(input.reportPath?.trim() ? { report: input.reportPath.trim() } : {}),
    ...(historyFinal ? { historyFinal } : {}),
    ...(candidateFinal ? { candidateFinal } : {}),
    trace: join(input.experimentRoot, "runs", input.runId),
    replica: join(input.experimentRoot, "environment", "runs", input.runId),
  };
}

export function resolveResultPathLinks(result: ExperimentResult): ResultPathLinks {
  if (result.pathLinks) return result.pathLinks;
  const runId = result.record.attempt?.runId;
  if (!runId || !result.experimentRoot) {
    return { ...(result.reportPath ? { report: result.reportPath } : {}) };
  }
  return {
    ...(result.reportPath ? { report: result.reportPath } : {}),
    trace: join(result.experimentRoot, "runs", runId),
    replica: join(result.experimentRoot, "environment", "runs", runId),
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
