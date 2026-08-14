import { join, resolve } from "node:path";
import type { CandidateSpec, TaskCase } from "../core/schema.js";
import type { ResolvedRuntime, RuntimePort } from "../core/runtime.js";
import { LocalWorkspaceProvider, type EnvironmentBaseline } from "../environment/local-workspace-provider.js";
import {
  contaminationWarnings,
  detectContamination,
} from "../environment/contamination.js";
import { findProductPack } from "../products/index.js";
import type { CodexExperimentInput, CodexExperimentPreflight } from "./experiment.js";
import { assertPaths } from "./experiment-helpers.js";

/** Read-only admission check. It never creates a Candidate workspace or calls a target model. */
export async function preflightCodexExperiment(
  input: Pick<
    CodexExperimentInput,
    | "candidate"
    | "runtime"
    | "sourceRoot"
    | "dataDir"
    | "experimentId"
    | "caseId"
  > & { taskCase: TaskCase },
): Promise<CodexExperimentPreflight> {
  assertPaths(input.dataDir, input.sourceRoot);
  findProductPack(input.candidate.productId);
  if (input.caseId !== input.taskCase.caseId)
    throw new Error("Experiment caseId must match TaskCase.caseId.");
  const resolved = await resolveVerifiedCandidate(
    input.runtime,
    input.candidate,
  );
  const provider = new LocalWorkspaceProvider(
    join(
      resolve(input.dataDir),
      "experiments",
      input.experimentId,
      "environment",
    ),
  );
  const baseline = await provider.inspectBaseline(
    { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
    [],
    {},
  );
  const contamination = await detectContamination(
    input.sourceRoot,
    input.taskCase,
  );
  const preflight = preflightFromBaseline(baseline, resolved);
  return Object.keys(contamination).length
    ? {
        ...preflight,
        contamination,
        limitations: [
          ...preflight.limitations,
          ...contaminationWarnings(contamination),
        ],
      }
    : preflight;
}

export async function resolveVerifiedCandidate(
  runtime: RuntimePort,
  candidate: CandidateSpec,
): Promise<ResolvedRuntime> {
  const resolved = await runtime.validateCandidate(candidate);
  if (resolved.resolvedModel === "unknown")
    throw new Error("Candidate model is not verified by the target runtime.");
  return resolved;
}

export function preflightFromBaseline(
  baseline: EnvironmentBaseline,
  resolved: ResolvedRuntime,
): CodexExperimentPreflight {
  if (baseline.readiness.runnable === "unsupported")
    return {
      sourceBaseline: "unavailable",
      resolved,
      comparisonClass: "observational",
      limitations: baseline.warnings,
    };
  const limitation =
    "Replay starts from the selected directory's current state, not the historical start; historical results may already be present.";
  const comparisonClass =
    baseline.match === "recovered"
      ? "recovered"
      : baseline.match === "recovered_partial"
        ? "recovered_partial"
        : "observational";
  const limitations = baseline.recovery
    ? [...baseline.warnings]
    : [limitation, ...baseline.warnings];
  return {
    sourceBaseline:
      baseline.readiness.runnable === "blocked" ? "partial" : "available",
    resolved,
    sourceFingerprint:
      baseline.recovery?.sourceDigest ?? baseline.fingerprint.digest,
    workspace: baseline.budget,
    comparisonClass,
    limitations,
  };
}
