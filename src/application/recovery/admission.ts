import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { pathContainedBy } from "../../core/paths.js";
import {
  CandidateLaunchContextSchema,
  type CandidateLaunchContext,
} from "../../core/schema.js";

export async function admitCandidateLaunch(input: {
  experimentRoot: string;
  experimentId: string;
  runId: string;
  workspaceRoot: string;
  productId: string;
  requestedModel: string;
  resolvedModel: string;
  permissions?: Record<string, string>;
  requireObservations?: boolean;
}): Promise<CandidateLaunchContext> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const experimentRoot = resolve(input.experimentRoot);
  if (!pathContainedBy(experimentRoot, workspaceRoot)) {
    throw new Error("Candidate launch workspace is outside the experiment isolation root.");
  }
  if (input.requireObservations) {
    const index = await findObservationIndex(experimentRoot);
    if (!index) {
      throw new Error("Candidate was not started because recovery observations are missing.");
    }
  }
  const context: CandidateLaunchContext = {
    schemaVersion: 1,
    experimentId: input.experimentId,
    runId: input.runId,
    workspaceRoot,
    productId: input.productId,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    permissions: input.permissions ?? { workspace: "isolated" },
  };
  if (!Value.Check(CandidateLaunchContextSchema, context)) {
    throw new Error("CandidateLaunchContext failed schema check.");
  }
  return context;
}

async function findObservationIndex(experimentRoot: string): Promise<string | undefined> {
  const runs = join(experimentRoot, "runs");
  let names: string[];
  try {
    names = await readdir(runs);
  } catch {
    // No runs directory yet: Recovery has not materialized observations.
    return undefined;
  }
  for (const name of names) {
    const index = join(runs, name, "observations", "INDEX.md");
    try {
      await stat(index);
      return index;
    } catch {
      // This run folder is not an observations tree; keep scanning siblings.
      continue;
    }
  }
  return undefined;
}
