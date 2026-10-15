import { readFile } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { PersistedExperimentMetadataSchema, ExperimentPreflightSchema, RunPreflightRecordSchema,
  type PersistedExperimentMetadata, type ExperimentPreflight, type TaskCase, type ExperimentSpec } from '../core/schema.js';
import { canonicalJson, validateTaskCase } from '../core/task-case-identity.js';
import { sha256 } from '../core/identity.js';
import { isRecord } from '../core/json.js';

export type PersistedRead<T> = { kind: 'current'; value: T } | { kind: 'legacy'; value: T }
  | { kind: 'missing' | 'corrupt' | 'unsupported'; diagnostic: string };

async function readPersistedJson(path: string): Promise<{ kind: 'json'; value: unknown } | { kind: 'missing' | 'corrupt'; diagnostic: string }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing', diagnostic: 'missing_file' };
    throw error;
  }
  try { return { kind: 'json', value: JSON.parse(text) as unknown }; }
  catch { return { kind: 'corrupt', diagnostic: 'invalid_json' }; }
}

export async function readExperimentMetadata(path: string, experimentId: string): Promise<PersistedRead<PersistedExperimentMetadata>> {
  const read = await readPersistedJson(path);
  if (read.kind !== 'json') return read;
  const raw = read.value;
  const spec = isRecord(raw) && isRecord(raw.spec) ? raw.spec : undefined;
  if (spec?.schemaVersion !== undefined && !validVersion(spec.schemaVersion)) return { kind: 'corrupt', diagnostic: 'malformed_experiment_version' };
  if (spec?.schemaVersion !== undefined && spec.schemaVersion !== 1 && spec.schemaVersion !== 2) return { kind: 'unsupported', diagnostic: 'unsupported_experiment_schema' };
  if (!Value.Check(PersistedExperimentMetadataSchema, raw) || raw.spec.experimentId !== experimentId) {
    return { kind: 'corrupt', diagnostic: 'invalid_experiment_metadata' };
  }
  return { kind: raw.spec.schemaVersion === 2 ? 'current' : 'legacy', value: raw };
}

export function fixedExperimentSpec(experimentId: string, task: TaskCase): Extract<ExperimentSpec, { schemaVersion: 2 }> {
  validateTaskCase(task);
  const { importedAt: _importedAt, ...provenance } = task.provenance;
  const taskCaseIdentity = task.schemaVersion === 2 ? { kind: 'frozen-v2' as const, contentHash: task.contentHash }
    : { kind: 'legacy-v1' as const, legacyContentHash: task.contentHash, observedCanonicalHash: sha256(canonicalJson({ ...task, provenance })) };
  return { schemaVersion: 2, experimentId, taskCaseId: task.caseId, taskCaseIdentity };
}

export function assertExperimentTaskIdentity(spec: ExperimentSpec, task: TaskCase): void {
  const actual = fixedExperimentSpec(spec.experimentId, task);
  if (spec.taskCaseId !== task.caseId || (spec.schemaVersion === 2 && canonicalJson(spec.taskCaseIdentity) !== canonicalJson(actual.taskCaseIdentity))) {
    throw new Error(`Experiment ${spec.experimentId} conflicts with its fixed TaskCase identity.`);
  }
}

export async function readPreflightRecord(path: string, experimentId: string, runId: string): Promise<PersistedRead<ExperimentPreflight>> {
  const read = await readPersistedJson(path);
  if (read.kind !== 'json') return read;
  const raw = read.value;
  if (isRecord(raw) && raw.schemaVersion !== undefined) {
    if (!validVersion(raw.schemaVersion)) return { kind: 'corrupt', diagnostic: 'malformed_preflight_version' };
    if (raw.schemaVersion !== 1) return { kind: 'unsupported', diagnostic: 'unsupported_preflight_schema' };
    if (!Value.Check(RunPreflightRecordSchema, raw) || raw.experimentId !== experimentId || raw.runId !== runId) {
      return { kind: 'corrupt', diagnostic: 'invalid_preflight_owner_or_content' };
    }
    return { kind: 'current', value: raw.preflight };
  }
  return Value.Check(ExperimentPreflightSchema, raw) ? { kind: 'legacy', value: raw }
    : { kind: 'corrupt', diagnostic: 'invalid_legacy_preflight' };
}

function validVersion(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
