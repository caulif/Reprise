import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import { SceneDescriptorSchema, TaskCaseSchema, type SceneDescriptor, type TaskCase } from "../core/schema.js";
import { LocalWorkspaceProvider, type RecoveryStaging } from "../environment/local-workspace-provider.js";
import { loadSealedBaseline, readBaselineMarker } from "../environment/local-workspace-fs.js";
import { persistTaskCase } from "./experiment-helpers.js";
import { CliError } from "./cli-error.js";
import { readJsonFile } from "./experiment-history-list.js";
import { resolvedExperimentRoot } from "./experiment-layout.js";
import { candidateStartBlocked, candidateGateFromAttempt } from "./candidate-start.js";
import type { RecoveryAttempt } from "./recovery/types.js";

export async function persistPreparedScene(attempt: RecoveryAttempt, sourceRoot: string, taskCase: TaskCase): Promise<SceneDescriptor> {
  const sealed = attempt.baseline
    ? candidateStartBlocked(candidateGateFromAttempt(attempt, Boolean(taskCase.initialInput?.text))) === undefined
    : false;
  const descriptor: SceneDescriptor = {
    schemaVersion: 1,
    experimentId: attempt.experimentId || "pending",
    caseId: taskCase.caseId || "pending",
    runId: attempt.experimentId || "pending",
    sourceRoot: resolve(sourceRoot),
    sealed,
  };
  if (!Value.Check(SceneDescriptorSchema, descriptor)) throw new Error("Generated scene descriptor does not satisfy SceneDescriptorSchema.");
  if (!attempt.experimentRoot || !taskCase.caseId) return descriptor;
  if (Value.Check(TaskCaseSchema, taskCase)) {
    await persistTaskCase(join(resolve(attempt.experimentRoot, "..", ".."), "cases", taskCase.caseId, "case.json"), taskCase);
  }
  await writeAtomic(join(attempt.experimentRoot, "scene.json"), `${JSON.stringify(descriptor)}\n`);
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
  const provider = new LocalWorkspaceProvider(join(experimentRoot, "environment"));
  const baselineRoot = join(experimentRoot, "environment", "baselines", descriptorValue.caseId);
  const recorded = await readBaselineMarker(join(experimentRoot, "environment", "baselines", `${descriptorValue.caseId}.marker.json`));
  if (!recorded) throw new CliError("failed", `Sealed baseline for ${descriptorValue.caseId} is missing.`, experimentId);
  const baseline = await loadSealedBaseline(descriptorValue.caseId, baselineRoot, recorded);
  const attempt: RecoveryAttempt = {
    baseline,
    recovery: { status: "completed", sessionId: `scene-${experimentId}`, value: { status: "ready", reportPath: "recovery.md", unresolved: [] } },
    experimentRoot,
    experimentId,
    provider,
    accept: async () => baseline,
    staging: { recoveryId: "sealed-scene", caseId: descriptorValue.caseId, sourceRoot: descriptorValue.sourceRoot, root: baselineRoot } as RecoveryStaging,
  };
  return { descriptor: descriptorValue, taskCase: taskCaseValue, attempt };
}
