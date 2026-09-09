import type { TaskCase } from "../../core/schema.js";
import { resolvedRecoveryFacts } from "../../infrastructure/recovery-tools.js";

export function forensicsFact(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): Record<string, unknown> {
  return {
    git: facts.git
      ? {
          isRepo: facts.git.isRepo,
          headState: facts.git.headState,
          statusAvailable: facts.git.statusAvailable,
        }
      : { isRepo: false, headState: "unavailable", statusAvailable: false },
    transcriptEntries: facts.catalog.filter(
      (entry) => entry.source === "transcript",
    ).length,
    historicalEventEntries: facts.catalog.filter(
      (entry) => entry.source === "historical_events",
    ).length,
    preimageCount: facts.preimages.length,
    patchCount: facts.patches.length,
    verifiedEvidenceCount: facts.verifiedEvidence.length,
    evidenceQuality: recoveryEvidenceQuality(facts),
    operations: facts.operations,
  };
}

function recoveryEvidenceQuality(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): {
  sourceReachability: { available: number; attempted: number };
  taskRelevantEvidence: number;
  strongEvidence: number;
  operationBearingEvidence: number;
  conflictRate: number;
} {
  const attempted = 4;
  const available = [
    true,
    facts.git !== undefined,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events") || facts.verifiedEvidence.length > 0,
  ].filter(Boolean).length;
  const taskRelevant = [
    facts.preimages.length > 0,
    facts.patches.length > 0,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events"),
  ].filter(Boolean).length;
  const strong = facts.verifiedEvidence.filter((evidence) => evidence.kind === "checkpoint" || evidence.kind === "preimage" || evidence.kind === "git_commit").length;
  return {
    sourceReachability: { available, attempted },
    taskRelevantEvidence: taskRelevant,
    strongEvidence: strong,
    operationBearingEvidence: facts.operations.filter((operation) => operation.availability === "available" && operation.operation !== "evidence_catalog").length,
    conflictRate: 0,
  };
}

export function recoveryClues(taskCase: TaskCase): {
  cwd?: string;
  historicalCommit?: string;
  sourceVersion?: string;
} {
  const context = taskCase.taskContext ?? {};
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.length ? value : undefined;
  const cwd = string(context.cwd);
  const historicalCommit = string(context.historicalCommit);
  const sourceVersion = string(context.sourceVersion);
  return {
    ...(cwd ? { cwd } : {}),
    ...(historicalCommit ? { historicalCommit } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}
