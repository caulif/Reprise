import { join, resolve } from "node:path";
import { writeAtomic } from "../../core/identity.js";
import type { CandidateLaunchContext } from "../../core/schema.js";
import { admitCandidateLaunch } from "./admission.js";

export function candidateLaunchFor(
  resolved: Pick<CandidateLaunchContext, "productId" | "requestedModel" | "resolvedModel">,
  environment: { runId: string; root: string },
  experimentId = "exp-1",
): CandidateLaunchContext {
  return {
    experimentId,
    runId: environment.runId,
    workspaceRoot: environment.root,
    productId: resolved.productId,
    requestedModel: resolved.requestedModel,
    resolvedModel: resolved.resolvedModel,
    permissions: { workspace: "isolated" },
  };
}

export async function commitCandidateLaunchContext(input: {
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
  const context = await admitCandidateLaunch(input);
  await writeAtomic(
    join(resolve(input.experimentRoot), "runs", input.runId, "candidate-launch.json"),
    `${JSON.stringify(context, null, 2)}\n`,
  );
  return context;
}
