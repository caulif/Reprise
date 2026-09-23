import { basename, dirname, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import { isFsAbsolute } from "../core/paths.js";
import { SceneDescriptorSchema, TaskCaseSchema, type SceneDescriptor, type TaskCase } from "../core/schema.js";
import { LocalWorkspaceProvider, type RecoveryStaging } from "../environment/local-workspace-provider.js";
import { loadSealedBaseline, readBaselineMarker } from "../environment/local-workspace-fs.js";
import { persistTaskCase } from "./experiment-helpers.js";
import { CliError } from "./cli-error.js";
import { readJsonFile } from "./experiment-history-list.js";
import { resolvedExperimentRoot } from "./experiment-layout.js";
import { candidateStartBlocked, candidateGateFromAttempt } from "./candidate-start.js";
import type { RecoveryAttempt } from "./recovery/types.js";

function recordedFsPath(path: string): string {
  const trimmed = path.trim();
  return isFsAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function casesRootForExperiment(experimentRoot: string): string | undefined {
  if (!isFsAbsolute(experimentRoot)) return undefined;
  const experimentsDir = dirname(experimentRoot);
  if (basename(experimentsDir) !== "experiments") return undefined;
  return join(dirname(experimentsDir), "cases");
}

export async function persistPreparedScene(attempt: RecoveryAttempt, sourceRoot: string, taskCase: TaskCase): Promise<SceneDescriptor> {
  const sealed = attempt.baseline
    ? candidateStartBlocked(candidateGateFromAttempt(attempt, Boolean(taskCase.initialInput?.text))) === undefined
    : false;
  const descriptor: SceneDescriptor = {
    schemaVersion: 1,
    experimentId: attempt.experimentId || "pending",
    caseId: taskCase.caseId || "pending",
    runId: attempt.runId ?? attempt.experimentId ?? "pending",
    ...(attempt.runId && attempt.baseline.root &&
      resolve(attempt.baseline.root) === resolve(attempt.experimentRoot, "environment", "recovery", attempt.runId, "baselines", taskCase.caseId)
      ? { recoveryProviderRunId: attempt.runId } : {}),
    sourceRoot: recordedFsPath(sourceRoot),
    sealed,
  };
  if (!Value.Check(SceneDescriptorSchema, descriptor)) throw new Error("Generated scene descriptor does not satisfy SceneDescriptorSchema.");
  const experimentRoot = attempt.experimentRoot?.trim() ?? "";
  if (!isFsAbsolute(experimentRoot) || !taskCase.caseId) return descriptor;
  const casesRoot = casesRootForExperiment(experimentRoot);
  if (casesRoot && Value.Check(TaskCaseSchema, taskCase)) {
    await persistTaskCase(join(casesRoot, taskCase.caseId, "case.json"), taskCase);
  }
  await writeAtomic(join(experimentRoot, "scene.json"), `${JSON.stringify(descriptor)}\n`);
  return descriptor;
}

export async function loadSealedScene(dataDir: string, experimentId: string): Promise<{
  readonly descriptor: SceneDescriptor;
  readonly taskCase: TaskCase;
  readonly attempt: RecoveryAttempt;
}> {
  const experimentRoot = resolvedExperimentRoot(dataDir, experimentId);
  const descriptorValue = await readJsonFile(join(experimentRoot, "scene.json"));
  if (!Value.Check(SceneDescriptorSchema, descriptorValue)) {
    throw new CliError("not_found", `Scene ${experimentId} was not found.`, experimentId);
  }
  if (!descriptorValue.sealed) throw new CliError("failed", `${experimentId} is not a sealed scene.`, experimentId);
  const taskCaseValue = await readJsonFile(join(resolve(dataDir), "cases", descriptorValue.caseId, "case.json"));
  if (!Value.Check(TaskCaseSchema, taskCaseValue)) {
    throw new CliError("not_found", `TaskCase ${descriptorValue.caseId} was not found.`, descriptorValue.caseId);
  }
  const providerRoot = descriptorValue.recoveryProviderRunId
    ? join(experimentRoot, "environment", "recovery", descriptorValue.recoveryProviderRunId)
    : join(experimentRoot, "environment");
  const provider = new LocalWorkspaceProvider(providerRoot);
  const baselineRoot = join(providerRoot, "baselines", descriptorValue.caseId);
  const recorded = await readBaselineMarker(join(providerRoot, "baselines", `${descriptorValue.caseId}.marker.json`));
  if (!recorded) throw new CliError("failed", `Sealed baseline for ${descriptorValue.caseId} is missing.`, experimentId);
  const baseline = await loadSealedBaseline(descriptorValue.caseId, baselineRoot, recorded);
  const attempt: RecoveryAttempt = {
    baseline,
    recovery: { status: "completed", sessionId: `scene-${experimentId}`, value: { status: "ready", summary: baseline.recovery?.summary ?? "Sealed baseline is ready for the original task.", reportPath: "recovery.md", unresolved: [] } },
    experimentRoot,
    experimentId,
    runId: descriptorValue.runId,
    provider,
    accept: async () => baseline,
    staging: { recoveryId: "sealed-scene", caseId: descriptorValue.caseId, sourceRoot: descriptorValue.sourceRoot, root: baselineRoot } as RecoveryStaging,
  };
  return { descriptor: descriptorValue, taskCase: taskCaseValue, attempt };
}
