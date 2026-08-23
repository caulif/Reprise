import { access, lstat, readdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { isRecord } from '../core/json.js';
import { ExperimentSpecSchema, RunRecordSchema, TaskCaseSchema, type RunRecord, type TaskCase } from '../core/schema.js';

export type HistoryCase = { readonly taskCase: TaskCase; readonly path: string };
export type HistoryExperiment = { readonly experimentId: string; readonly taskCaseId: string; readonly runId?: string; readonly outcome?: string; readonly startedAt?: string; readonly reportPath?: string; readonly path: string; readonly sizeBytes: number };

/** Lists only schema-validated local objects beneath Reprise's configured data directory. */
export async function readLocalHistory(dataDir: string): Promise<{ readonly cases: readonly HistoryCase[]; readonly experiments: readonly HistoryExperiment[]; readonly totalBytes: number }> {
  const root = resolve(dataDir);
  const experiments = await readExperiments(root);
  await Promise.all(experiments.map((item) => reclaimReleasedBaselineCopies(item.path)));
  const [cases, sized, totalBytes] = await Promise.all([readCases(root), readExperiments(root), directorySize(root)]);
  return { cases, experiments: sized, totalBytes };
}

async function readCases(root: string): Promise<readonly HistoryCase[]> {
  const directory = join(root, 'cases');
  const entries = await safeDirectories(directory);
  const cases = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry, 'case.json');
    const value = await readJson(path);
    return Value.Check(TaskCaseSchema, value) ? { taskCase: value, path } : undefined;
  }));
  return cases.filter(isDefined).sort((left, right) => right.taskCase.provenance.importedAt.localeCompare(left.taskCase.provenance.importedAt));
}

async function readExperiments(root: string): Promise<readonly HistoryExperiment[]> {
  const directory = join(root, 'experiments');
  const entries = await safeDirectories(directory);
  const experiments = await Promise.all(entries.map((entry) => readExperiment(join(directory, entry), entry)));
  return experiments.filter(isDefined).sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? ''));
}

async function readExperiment(path: string, experimentId: string): Promise<HistoryExperiment | undefined> {
  const metadata = await readJson(join(path, 'experiment.json'));
  if (!isPersistedExperiment(metadata)) return undefined;
  const runId = metadata.runIds[0];
  const record = runId ? await readRunRecord(join(path, 'runs', runId, 'record.json')) : undefined;
  const unread = Boolean(runId && !record && await readJson(join(path, 'runs', runId, 'record.json')));
  const reportPath = await exists(join(path, 'report.html')) ? join(path, 'report.html') : await exists(join(path, 'comparison-failure.html')) ? join(path, 'comparison-failure.html') : undefined;
  return {
    experimentId, taskCaseId: metadata.spec.taskCaseId,
    ...(runId ? { runId } : {}),
    ...(record
      ? { outcome: record.outcome.termination.kind, startedAt: record.attempt.createdAt }
      : unread ? { outcome: 'record unread' } : {}),
    ...(reportPath ? { reportPath } : {}),
    path,
    sizeBytes: await directorySize(path),
  };
}

function isPersistedExperiment(value: unknown): value is { readonly spec: { readonly taskCaseId: string }; readonly runIds: readonly string[] } {
  return isRecord(value) && Value.Check(ExperimentSpecSchema, value.spec) && Array.isArray(value.runIds) && value.runIds.every((id) => typeof id === 'string');
}

/** Finished experiments keep the source fingerprint marker, not a second copy of the isolated tree. */
async function reclaimReleasedBaselineCopies(experimentPath: string): Promise<void> {
  const runDirs = await safeDirectories(join(experimentPath, 'environment', 'runs'));
  if (runDirs.length > 0) return;
  const baselinesRoot = join(experimentPath, 'environment', 'baselines');
  let entries;
  try {
    entries = await readdir(baselinesRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => (
    rm(join(baselinesRoot, entry.name), { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined)
  )));
}

async function readRunRecord(path: string): Promise<RunRecord | undefined> {
  const value = await readJson(path);
  return Value.Check(RunRecordSchema, value) ? value : undefined;
}

async function readJson(path: string): Promise<unknown> {
  let content: string;
  try { content = await readFile(path, 'utf8'); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  try { return JSON.parse(content); } catch { return undefined; }
}


async function directorySize(path: string): Promise<number> {
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (isMissing(error)) return 0; throw error; }
  const sizes = await Promise.all(entries.map(async (entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return directorySize(child);
    if (!entry.isFile()) return 0;
    return (await lstat(child)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function safeDirectories(path: string): Promise<readonly string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }
