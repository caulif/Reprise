import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { RunInspection } from "./comparison.js";
import type { ExperimentResult } from "./experiment.js";
import { isComparisonImagePath } from "./comparison-media.js";
import { isOpenableFinalPath, resolveHistoricalFinalPath } from "./comparison-openable-media.js";
import type { TaskCase } from "../core/schema.js";

export type ResultPathLinks = {
  readonly report?: string;
  readonly historyFinal?: string;
  readonly candidateFinal?: string;
  readonly trace?: string;
  readonly replica?: string;
};

const FINAL_RANK = (path: string): number => {
  const lower = path.toLowerCase();
  if (/\.(html|htm|xhtml)$/.test(lower)) return 0;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) return 1;
  return 2;
};

export async function buildResultPathLinks(input: {
  experimentRoot: string;
  runId: string;
  reportPath?: string;
  taskCase: TaskCase;
  inspection: RunInspection;
  workspaceRoot: string;
  dataDir?: string;
}): Promise<ResultPathLinks> {
  const historyFinal = await resolveHistoricalFinalPath({
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    taskCase: input.taskCase,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
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
    .filter((path) => isOpenableFinalPath(path) || isComparisonImagePath(path))
    .sort((left, right) => FINAL_RANK(left) - FINAL_RANK(right));
  for (const path of ranked) {
    const absolutePath = join(input.workspaceRoot, ...path.split("/"));
    if (await access(absolutePath, constants.F_OK).then(() => true, () => false)) return absolutePath;
  }
  return undefined;
}
