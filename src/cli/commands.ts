import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ComparisonResultSchema as ComparisonSchema, type ComparisonAgentPort, type ComparisonResult } from '../agents/comparison-agent.js';
import { comparePersistedFacts } from '../application/comparison.js';
import { CandidateRun } from '../application/candidate-run.js';
import {
  ExperimentSpecSchema,
  RunRecordSchema,
  TaskCaseSchema,
  type ExperimentSpec,
  type RunAttempt,
  type RunManifest,
  type RunPolicy,
  type RunRecord,
  type TaskCase,
} from '../core/schema.js';
import type { MessageIdentity, TargetEventSink, UserMessage } from '../core/runtime.js';
import { freezeCodexFixture } from '../products/codex/pack.js';
import { assertCodexSmokeAcceptanceRecord, type CodexSmokeAcceptanceRecord } from '../products/codex/smoke-gate.js';
import { buildComparisonProjection, renderComparisonReport } from '../report/comparison-report.js';
import { ScriptedRuntime } from '../infrastructure/scripted-runtime.js';
import { ExperimentStore, writeImmutableJson } from '../infrastructure/store/experiment-store.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONFIG_FILE = 'config.json';
const EXPERIMENT_FILE = 'experiment.json';
const COMPARISON_FILE = 'comparison.json';
const REPORT_FILE = 'report.html';

export type HarnessConfig = {
  schemaVersion: 1;
  providerId: string;
  model: string;
  dataDir: string;
  privacy: { allowModelText: boolean; allowBinary: boolean; redactions: string[] };
};

type PersistedExperiment = { spec: ExperimentSpec; runIds: readonly string[] };

export async function setup(input: { dataDir: string; providerId: string; model: string; fixture?: string; now: string }): Promise<string> {
  assertSafeText(input.providerId, 'provider');
  assertSafeText(input.model, 'model');
  const dataDir = resolve(input.dataDir);
  const config: HarnessConfig = { schemaVersion: 1, providerId: input.providerId, model: input.model, dataDir, privacy: { allowModelText: false, allowBinary: false, redactions: [] } };
  await mkdir(dataDir, { recursive: true });
  await writeJson(join(dataDir, CONFIG_FILE), config);
  if (input.fixture) await mkdir(join(dataDir, 'cases'), { recursive: true });
  const caseMessage = input.fixture ? await freezeCodexFixture(resolve(input.fixture), join(dataDir, 'cases'), input.now) : undefined;
  return caseMessage ? `Setup complete. Imported case ${caseMessage.taskCase.caseId}.` : 'Setup complete.';
}

export async function listCases(dataDir: string): Promise<string> {
  const casesRoot = join(resolve(dataDir), 'cases');
  let entries;
  try {
    entries = await readdir(casesRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissing(error)) return 'No frozen cases found.';
    throw error;
  }
  const cases = [] as Array<{ caseId: string; input: string; baseline: string }>;
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskCase = await readTaskCase(join(casesRoot, entry.name));
    cases.push({ caseId: taskCase.caseId, input: taskCase.initialInput.text, baseline: taskCase.baseline.status });
  }
  if (!cases.length) return 'No frozen cases found.';
  return cases.map((item) => `${item.caseId}\t${item.baseline}\t${compact(item.input)}`).join('\n');
}

export async function compare(input: { dataDir: string; caseId: string; productId: string; model: string; now: string }): Promise<string> {
  assertId(input.caseId, 'case');
  assertId(input.model, 'model');
  if (input.productId !== 'codex') throw new Error(`Product ${input.productId} is unavailable in fixture mode.`);
  const config = await readConfig(input.dataDir);
  const taskCase = await readTaskCase(join(config.dataDir, 'cases', input.caseId));
  const experimentId = `experiment-${shortHash(`${input.caseId}:${input.model}:${input.now}`)}`;
  const runId = `run-${shortHash(`${experimentId}:${input.model}`)}`;
  const root = join(config.dataDir, 'experiments', experimentId);
  const policy = runPolicy();
  const candidate = { candidateId: `fixture-${input.model}`, productId: input.productId, requestedModel: input.model };
  const spec: ExperimentSpec = {
    experimentId, taskCaseId: taskCase.caseId, candidates: [candidate],
    controller: agentConfig(config), comparison: agentConfig(config), runPolicy: policy, outputRoot: root,
  };
  await writeJson(join(root, EXPERIMENT_FILE), { spec, runIds: [runId] } satisfies PersistedExperiment);
  const runtime = new ScriptedRuntime();
  const resolved = await runtime.resolve({ productId: input.productId, requestedModel: input.model });
  const attempt: RunAttempt = { schemaVersion: 1, runId, experimentId, caseId: taskCase.caseId, candidate, policy, createdAt: input.now };
  const manifest = manifestFor(attempt, resolved, config, input.now, root);
  const store = await ExperimentStore.open(root, experimentId);
  let record: RunRecord;
  try {
    await store.acquireWriter();
    const runner = await runtime.createRunner(resolved, { environmentId: `environment-${runId}`, runId, root: join(root, 'workspace') }, emptySink());
    const run = new CandidateRun({ runner, policy: { turnTimeoutMs: policy.turnTimeoutMs, maxTargetTurns: policy.maxTargetTurns }, persistence: { journal: store, attempt, manifest } });
    const state = await run.start(toUserMessage(taskCase), initialIdentity(runId));
    if (state === 'awaiting_controller') await run.complete();
    const result = run.result();
    if (!result.record || !Value.Check(RunRecordSchema, result.record)) throw new Error('Scripted run did not persist a valid RunRecord.');
    record = result.record;
  } finally {
    await store.close();
  }
  const comparison = await offlineComparison(taskCase, record, input.now);
  await writeJson(join(root, COMPARISON_FILE), comparison);
  await writeReport(root, taskCase, record, comparison);
  return `Comparison complete.\nExperiment: ${experimentId}\nRun: ${runId}\nReport: ${join('experiments', experimentId, REPORT_FILE)}`;
}

export async function recordSmokeAcceptance(input: { dataDir: string; experimentId: string; recordPath: string }): Promise<string> {
  assertId(input.experimentId, 'experiment');
  const dataDir = resolve(input.dataDir);
  const root = join(dataDir, 'experiments', input.experimentId);
  const persisted = await readPersistedExperiment(root);
  const record = await readJson(resolve(input.recordPath));
  assertCodexSmokeAcceptanceRecord(record);
  assertAcceptanceBelongsToExperiment(record, persisted.spec, persisted.runIds);
  const target = join(root, 'runs', record.runId, 'codex-smoke-acceptance.json');
  await writeImmutableJson(target, record);
  return `Smoke acceptance record saved: ${join('experiments', input.experimentId, 'runs', record.runId, 'codex-smoke-acceptance.json')}`;
}

export async function report(input: { dataDir: string; experimentId: string }): Promise<string> {
  assertId(input.experimentId, 'experiment');
  const dataDir = resolve(input.dataDir);
  const persisted = await readPersistedExperiment(join(dataDir, 'experiments', input.experimentId));
  const taskCase = await readTaskCase(join(dataDir, 'cases', persisted.spec.taskCaseId));
  const root = join(dataDir, 'experiments', input.experimentId);
  const store = await ExperimentStore.open(root, input.experimentId);
  try {
    const records = persisted.runIds.map((runId) => readRunRecord(store.replay(runId).finishedPayload, runId));
    const record = records[0];
    if (!record) throw new Error(`Experiment ${input.experimentId} has no persisted runs.`);
    const comparison = await readComparison(root);
    await writeReport(root, taskCase, record, comparison);
    return `Report generated: ${join('experiments', input.experimentId, REPORT_FILE)}`;
  } finally {
    await store.close();
  }
}

async function writeReport(root: string, taskCase: TaskCase, record: RunRecord, comparison: ComparisonResult | undefined): Promise<void> {
  const projection = buildComparisonProjection({ taskCase, runs: [record], ...(comparison ? { comparison } : {}) });
  await writeFile(join(root, REPORT_FILE), renderComparisonReport(projection), { encoding: 'utf8' });
}

async function readTaskCase(caseRoot: string): Promise<TaskCase> {
  const taskCase = await readJson(join(caseRoot, 'case.json'));
  if (!Value.Check(TaskCaseSchema, taskCase)) throw new Error(`Invalid frozen TaskCase: ${caseRoot}.`);
  return taskCase;
}

async function readConfig(dataDir: string): Promise<HarnessConfig> {
  const value = await readJson(join(resolve(dataDir), CONFIG_FILE));
  if (!isConfig(value)) throw new Error('Invalid setup config. Run setup again.');
  return value;
}

async function readPersistedExperiment(root: string): Promise<PersistedExperiment> {
  const value = await readJson(join(root, EXPERIMENT_FILE));
  if (!isPersistedExperiment(value)) throw new Error('Invalid experiment metadata.');
  return value;
}

async function readComparison(root: string): Promise<ComparisonResult | undefined> {
  try {
    const value = await readJson(join(root, COMPARISON_FILE));
    if (!isComparison(value)) throw new Error('Invalid persisted ComparisonResult.');
    return value;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function assertAcceptanceBelongsToExperiment(record: CodexSmokeAcceptanceRecord, spec: ExperimentSpec, runIds: readonly string[]): void {
  if (record.experimentId !== spec.experimentId || record.taskCaseId !== spec.taskCaseId || !runIds.includes(record.runId)) {
    throw new Error(`Smoke acceptance record does not belong to experiment ${spec.experimentId}.`);
  }
}

function readRunRecord(value: unknown, runId: string): RunRecord {
  if (!Value.Check(RunRecordSchema, value)) throw new Error(`Run ${runId} has no valid persisted RunRecord.`);
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

async function offlineComparison(taskCase: TaskCase, record: RunRecord, now: string): Promise<ComparisonResult> {
  const agent: ComparisonAgentPort = { compare: async () => ({ value: { summary: 'Offline fixture comparison; persisted facts are shown without an external model.', observations: [], limitations: ['ScriptedRuntime does not call a provider.'], generatedAt: now }, usedFallback: true }) };
  return (await comparePersistedFacts({ taskCase, runs: [record], agent })).result.value;
}

function agentConfig(config: HarnessConfig) {
  return { providerId: config.providerId, requestedModel: config.model, budget: { callTimeoutMs: 1_000, maxStructuredRepairAttempts: 0, maxProviderRetries: 0 } };
}

function manifestFor(attempt: RunAttempt, runtime: { productId: string; executable: string; version?: string; requestedModel: string; resolvedModel: string | 'unknown' }, config: HarnessConfig, now: string, root: string): RunManifest {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  return {
    schemaVersion: 1, attempt, resolvedModel: { requested: runtime.requestedModel, resolved: runtime.resolvedModel },
    runtime: { productId: runtime.productId, executable: runtime.executable, ...(runtime.version ? { version: runtime.version } : {}) },
    environment: { environmentId: `environment-${attempt.runId}`, workspacePath: join(root, 'workspace') },
    controller: { ...agentConfig(config), resolvedModel: config.model, optionsHash: hash('fixture-options'), promptHash: hash('fixture-prompt'), toolPolicyHash: hash('fixture-tools'), contextPolicyHash: hash('fixture-context') },
    startedAt: now,
  };
}

function runPolicy(): RunPolicy {
  return { wallClockMs: 30_000, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1_000, heartbeatTimeoutMs: 1_000, maxConsecutiveNoProgress: 1 };
}

function toUserMessage(taskCase: TaskCase): UserMessage { return { id: taskCase.initialInput.id, text: taskCase.initialInput.text }; }
function initialIdentity(runId: string): MessageIdentity { return { runId, turnIndex: 0, clientMessageId: `initial-${runId}` }; }
function emptySink(): TargetEventSink { return { append: async () => undefined }; }
function shortHash(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }
function compact(value: string): string { return value.replace(/\s+/g, ' ').slice(0, 120); }
function assertId(value: string, label: string): void { if (!SAFE_ID.test(value)) throw new Error(`${label} must be a safe identifier.`); }
function assertSafeText(value: string, label: string): void { if (!value.trim() || value.length > 200 || /[\r\n]/.test(value)) throw new Error(`${label} must be a single non-empty value.`); }
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function isConfig(value: unknown): value is HarnessConfig { return typeof value === 'object' && value !== null && Value.Check(ConfigSchema, value); }
function isPersistedExperiment(value: unknown): value is PersistedExperiment {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { spec?: unknown; runIds?: unknown };
  return Value.Check(ExperimentSpecSchema, candidate.spec)
    && Array.isArray(candidate.runIds)
    && candidate.runIds.every((id: unknown) => typeof id === 'string' && SAFE_ID.test(id));
}
function isComparison(value: unknown): value is ComparisonResult { return Value.Check(ComparisonSchema, value); }

const ConfigSchema = Type.Object({ schemaVersion: Type.Literal(1), providerId: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), dataDir: Type.String({ minLength: 1 }), privacy: Type.Object({ allowModelText: Type.Boolean(), allowBinary: Type.Boolean(), redactions: Type.Array(Type.String()) }) });
