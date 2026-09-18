import { join } from "node:path";
import type { RunInspection } from "./comparison.js";
import type { ExperimentResult } from "./experiment.js";
import { isComparisonImagePath } from "./comparison-media.js";
import { isOpenableFinalPath } from "./comparison-openable-media.js";
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

export function buildResultPathLinks(input: {
  experimentRoot: string;
  runId: string;
  reportPath?: string;
  taskCase: TaskCase;
  inspection: RunInspection;
  workspaceRoot: string;
}): ResultPathLinks {
  const historyFinal = resolveHistoricalFinal(input);
  const candidateFinal = resolveCandidateFinal(input);
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

function resolveHistoricalFinal(input: {
  experimentRoot: string;
  runId: string;
  taskCase: TaskCase;
}): string | undefined {
  const names = collectHistoricalFinalNames(input.taskCase);
  const ranked = [...names].sort((left, right) => FINAL_RANK(left) - FINAL_RANK(right));
  const best = ranked[0];
  if (!best) return undefined;
  const roots = [
    join(input.experimentRoot, "runs", input.runId, "controller-briefing", "history", best),
    join(input.experimentRoot, "environment", "baselines", best),
  ];
  return roots[0];
}

function resolveCandidateFinal(input: {
  experimentRoot: string;
  runId: string;
  inspection: RunInspection;
  workspaceRoot: string;
}): string | undefined {
  const ranked = [...input.inspection.changedPaths]
    .filter((path) => isOpenableFinalPath(path) || isComparisonImagePath(path))
    .sort((left, right) => FINAL_RANK(left) - FINAL_RANK(right));
  const best = ranked[0];
  if (!best) return undefined;
  return join(input.workspaceRoot, ...best.split("/"));
}

function collectHistoricalFinalNames(taskCase: TaskCase): Set<string> {
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
