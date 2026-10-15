import { mkdir, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SAFE_ID } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import { FixedExperimentSpecSchema, RunPreflightRecordSchema, type ExperimentSpec, type ExperimentPreflight, type PersistedExperimentMetadata } from "../core/schema.js";
import { writeImmutableJson } from "../infrastructure/store/experiment-store.js";
import { CliError } from "./cli-error.js";
import { isMissing } from "./experiment-helpers.js";
import { committedRunOrder, legacyRunOrder, readCommittedRunEvents } from "./experiment-run-history.js";
import { readExperimentMetadata, readPreflightRecord, type PersistedRead } from './experiment-metadata.js';
import { canonicalJson } from '../core/task-case-identity.js';

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

export async function persistExperimentSpec(experimentRoot: string, spec: Extract<ExperimentSpec, { schemaVersion: 2 }>): Promise<void> {
  const path = join(experimentRoot, "experiment.json");
  if (!Value.Check(FixedExperimentSpecSchema, spec)) throw new Error('Invalid fixed experiment metadata.');
  const existing = await readExperimentMetadata(path, spec.experimentId);
  if (existing.kind === 'current' || existing.kind === 'legacy') {
    if (existing.value.spec.taskCaseId !== spec.taskCaseId || (existing.value.spec.schemaVersion === 2 && canonicalJson(existing.value.spec) !== canonicalJson(spec))) {
      throw new Error(`Experiment ${spec.experimentId} metadata does not match the sealed scene.`);
    }
    return;
  }
  if (existing.kind !== 'missing') throw new Error(`${existing.diagnostic}: ${path}.`);
  await writeImmutableJson(path, { spec });
}

export async function listPersistedRunIds(experimentRoot: string, metadata?: PersistedExperimentMetadata): Promise<readonly string[]> {
  const { events } = await readCommittedRunEvents(experimentRoot);
  const committed = committedRunOrder(experimentRoot, events);
  let legacy = metadata?.runIds ?? [];
  try {
    const names = await readdir(join(experimentRoot, "runs"), { withFileTypes: true });
    const ids = names.filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name)).map((entry) => entry.name).sort();
    if (ids.length) legacy = ids;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return [...await legacyRunOrder(experimentRoot, legacy.filter((id) => !committed.includes(id))), ...committed];
}

export async function persistRunPreflight(experimentRoot: string, runId: string, preflight: ExperimentPreflight): Promise<void> {
  if (!SAFE_ID.test(runId)) throw new Error("runId must be a safe identifier.");
  const record = { schemaVersion: 1 as const, experimentId: basename(experimentRoot), runId, preflight };
  if (!Value.Check(RunPreflightRecordSchema, record)) throw new Error('Invalid run preflight.');
  const directory = join(experimentRoot, "runs", runId);
  await mkdir(directory, { recursive: true });
  await writeImmutableJson(join(directory, "preflight.json"), record);
}

export async function readRunPreflight(experimentRoot: string, runId: string): Promise<PersistedRead<ExperimentPreflight>> {
  const owner = basename(experimentRoot);
  const nested = await readPreflightRecord(join(experimentRoot, 'runs', runId, 'preflight.json'), owner, runId);
  if (nested.kind !== 'missing') return nested;
  const root = await readPreflightRecord(join(experimentRoot, 'preflight.json'), owner, runId);
  if (root.kind === 'current') return { kind: 'corrupt', diagnostic: 'versioned_preflight_at_legacy_path' };
  return root;
}
