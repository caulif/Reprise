import { access, lstat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonInvocationSchema, RunRecordSchema, TaskCaseSchema, type RunRecord, type TaskCase } from "../core/schema.js";
import { readCommittedExperimentHistory } from "./experiment-history-read.js";
import { isPersistedExperimentMetadata, listPersistedRunIds } from "./experiment-layout.js";
import { comparisonDetailOf, selectComparisonArtifacts } from "./comparison-artifacts.js";
import { listPublishedFrozenCases } from "../products/shared/freeze.js";

export type HistoryCase = { readonly taskCase: TaskCase; readonly path: string };
export type HistoryExperiment = {
  readonly experimentId: string;
  readonly taskCaseId: string;
  readonly taskTitle?: string;
  readonly candidateProductId?: string;
  readonly candidateModel?: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly taskStatus?: string;
  readonly cleanupStatus?: string;
  readonly comparisonStatus?: string;
  readonly comparisonFailure?: string;
  /** Nested comparison value status when invocation completed (e.g. insufficient_evidence). */
  readonly comparisonDetail?: string;
  readonly startedAt?: string;
  readonly reportPath?: string;
  /** Prior successful report retained beside this attempt's diagnostic. */
  readonly previousReportPath?: string;
  /** True when an on-disk HTML exists but attempt ownership is not confirmed. */
  readonly reportAttemptUnconfirmed?: boolean;
  readonly path: string;
  readonly sizeBytes: number;
  readonly incompleteModelInput?: boolean;
  readonly formatError?: string;
};

/** Lists only schema-validated local objects beneath Reprise's configured data directory. */
export async function readLocalHistory(dataDir: string): Promise<{
  readonly cases: readonly HistoryCase[];
  readonly experiments: readonly HistoryExperiment[];
  readonly totalBytes: number;
  readonly invalidCaseCount: number;
}> {
  const root = resolve(dataDir);
  const [{ cases, invalidCount }, sized, totalBytes] = await Promise.all([readCases(root), readExperiments(root), directorySize(root)]);
  const titles = new Map(cases.map(({ taskCase }) => [taskCase.caseId, taskCase.initialInput.text.replace(/\s+/g, ' ').trim()]));
  const experiments = sized.map((item) => {
    const title = titles.get(item.taskCaseId);
    return title ? { ...item, taskTitle: title } : item;
  });
  return { cases, experiments, totalBytes, invalidCaseCount: invalidCount };
}

async function readCases(root: string): Promise<{ cases: readonly HistoryCase[]; invalidCount: number }> {
  const directory = join(root, "cases");
  const entries = await listPublishedFrozenCases(directory);
  const cases = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry, "case.json");
    const value = await readJson(path);
    return Value.Check(TaskCaseSchema, value) ? { taskCase: value, path } : undefined;
  }));
  const valid = cases.filter((item): item is HistoryCase => item !== undefined);
  return {
    cases: valid.sort((left, right) => right.taskCase.provenance.importedAt.localeCompare(left.taskCase.provenance.importedAt)),
    invalidCount: cases.length - valid.length,
  };
}

async function readExperiments(root: string): Promise<readonly HistoryExperiment[]> {
  const directory = join(root, "experiments");
  const entries = await safeDirectories(directory);
  const experiments = await Promise.all(entries.map((entry) => readExperiment(join(directory, entry), entry)));
  return experiments.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

async function readExperiment(path: string, experimentId: string): Promise<HistoryExperiment> {
  const metadataPath = join(path, "experiment.json");
  const metadata = await readJson(metadataPath);
  if (!isPersistedExperimentMetadata(metadata)) return {
    experimentId, taskCaseId: experimentId, path, sizeBytes: await directorySize(path),
    formatError: await exists(metadataPath) ? 'invalid_metadata' : 'missing_metadata',
  };
  const runIds = await listPersistedRunIds(path, metadata);
  const runId = runIds.at(-1);
  const recordPath = runId ? join(path, "runs", runId, "record.json") : undefined;
  const record = recordPath ? await readRunRecord(recordPath) : undefined;
  const unread = Boolean(recordPath && !record && await exists(recordPath));
  const comparisonValue = await readJson(join(path, "comparison.json"));
  const comparison = Value.Check(ComparisonInvocationSchema, comparisonValue) ? comparisonValue : undefined;
  const diagnostic = await exists(join(path, "comparison-failure.html")) ? join(path, "comparison-failure.html") : undefined;
  const success = await exists(join(path, "report.html")) ? join(path, "report.html") : undefined;
  const artifacts = selectComparisonArtifacts({
    ...(comparison ? { comparisonStatus: comparison.status } : {}),
    ...(diagnostic ? { diagnosticPath: diagnostic } : {}),
    ...(success ? { successPath: success } : {}),
    ...(comparisonValue !== undefined ? { comparisonReadable: comparison !== undefined } : {}),
  });
  const comparisonDetail = comparisonDetailOf(comparison);
  const committed = await readCommittedExperimentHistory(path);
  const outcome = record ? record.outcome.termination.kind : unread ? "record unread" : committed.runStatus;
  return {
    experimentId, taskCaseId: metadata.spec.taskCaseId,
    ...(runId ? { runId } : {}),
    outcome,
    ...(record
      ? {
          taskStatus: record.outcome.task.status,
          cleanupStatus: record.outcome.cleanup.status,
          startedAt: record.attempt.createdAt,
          candidateProductId: record.attempt.candidate.productId,
          candidateModel: record.attempt.candidate.requestedModel,
        }
      : {}),
    ...artifacts,
    ...(comparison
      ? {
          comparisonStatus: comparison.status,
          ...(comparison.status === "failed"
            ? { comparisonFailure: comparison.failure.kind ?? comparison.failure.code }
            : {}),
        }
      : {}),
    ...(comparisonDetail ? { comparisonDetail } : {}),
    ...(committed.incompleteModelInput ? { incompleteModelInput: true } : {}),
    ...(unread ? { formatError: 'unreadable_record' } : committed.diagnosticCode === "unsupported_schema" ? { formatError: committed.diagnosticCode } : {}),
    path,
    sizeBytes: await directorySize(path),
  };
}

async function readRunRecord(path: string): Promise<RunRecord | undefined> {
  const value = await readJson(path);
  return Value.Check(RunRecordSchema, value) ? value : undefined;
}

export async function readJsonFile(path: string): Promise<unknown> {
  let content: string;
  try { content = await readFile(path, "utf8"); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  try { return JSON.parse(content); } catch { return undefined; }
}

const readJson = readJsonFile;

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
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
