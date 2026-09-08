import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SAFE_ID } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import { ExperimentSpecSchema, type ExperimentSpec } from "../core/schema.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import { CliError } from "./cli-error.js";
import { isMissing } from "./experiment-helpers.js";

export type PersistedExperimentMetadata = {
  readonly spec: ExperimentSpec;
  readonly runIds?: readonly string[];
};

export function resolvedExperimentRoot(dataDir: string, experimentId: string): string {
  if (!SAFE_ID.test(experimentId)) {
    throw new CliError("usage", `experimentId '${experimentId}' is not a safe identifier.`, experimentId);
  }
  const experiments = resolve(dataDir, "experiments");
  const root = resolve(experiments, experimentId);
  if (!pathContainedBy(experiments, root) || basename(root) !== experimentId) {
    throw new CliError("usage", `experimentId '${experimentId}' escapes the experiments directory.`, experimentId);
  }
  return root;
}

export function isPersistedExperimentMetadata(value: unknown): value is PersistedExperimentMetadata {
  if (typeof value !== "object" || value === null || !("spec" in value)) return false;
  const record = value as { spec: unknown; runIds?: unknown };
  if (!Value.Check(ExperimentSpecSchema, record.spec)) return false;
  if (record.runIds === undefined) return true;
  return Array.isArray(record.runIds) && record.runIds.every((id) => typeof id === "string" && SAFE_ID.test(id));
}

export async function persistExperimentSpec(experimentRoot: string, spec: ExperimentSpec): Promise<void> {
  const path = join(experimentRoot, "experiment.json");
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPersistedExperimentMetadata(existing)) {
      throw new Error(`Corrupt experiment metadata: ${path}.`);
    }
    if (existing.spec.experimentId !== spec.experimentId || existing.spec.taskCaseId !== spec.taskCaseId) {
      throw new Error(`Experiment ${spec.experimentId} metadata does not match the sealed scene.`);
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await writeImmutableJson(path, { spec });
}

export async function listPersistedRunIds(experimentRoot: string, metadata?: PersistedExperimentMetadata): Promise<readonly string[]> {
  try {
    const names = await readdir(join(experimentRoot, "runs"));
    const ids = names.filter((name) => SAFE_ID.test(name)).sort();
    if (ids.length) return ids;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return metadata?.runIds ?? [];
}

export async function persistRunPreflight(experimentRoot: string, runId: string, preflight: unknown): Promise<void> {
  if (!SAFE_ID.test(runId)) throw new Error("runId must be a safe identifier.");
  const directory = join(experimentRoot, "runs", runId);
  await mkdir(directory, { recursive: true });
  await writeImmutableJson(join(directory, "preflight.json"), preflight);
}

export async function readRunPreflight(experimentRoot: string, runId: string): Promise<unknown> {
  const nested = await readOptionalJson(join(experimentRoot, "runs", runId, "preflight.json"));
  if (nested !== undefined) return nested;
  return readOptionalJson(join(experimentRoot, "preflight.json"));
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
