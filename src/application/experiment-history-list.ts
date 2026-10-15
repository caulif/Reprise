import { readTaskCase } from '../products/shared/task-case-reader.js';
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import { readCommittedExperimentHistory } from "./experiment-history-read.js";
import { isPersistedExperimentMetadata, listPersistedRunIds } from "./experiment-layout.js";
import { comparisonDetailOf } from "./comparison-artifacts.js";
import { listPublishedFrozenCases } from "../products/shared/freeze.js";
import { actualModelName } from "./actual-model-name.js";
import { committedRunOrder, committedStartupFailure, latestCommittedAttempt, legacyOrderingKind, matchingRunRecord, readCommittedRunEvents } from "./experiment-run-history.js";
import { readRunComparison } from "./comparison-report-ownership.js";

export type HistoryCase = { readonly taskCase: TaskCase; readonly path: string };
export type HistoryExperiment = {
  readonly experimentId: string;
  readonly taskCaseId: string;
  readonly metadataTaskCaseId?: string;
  readonly taskTitle?: string;
  readonly candidateProductId?: string;
  readonly candidateModel?: string;
  readonly runId?: string;
  readonly runOrdering?: "committed" | "legacy_timestamp" | "unknown";
  readonly outcome?: string;
  readonly startupFailureStage?: string;
  readonly startupFailure?: string;
  readonly taskStatus?: string;
  readonly cleanupStatus?: string;
  readonly comparisonStatus?: string;
  readonly comparisonFailure?: string;
  readonly comparisonFailureStage?: string;
  readonly comparisonFailureMessage?: string;
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
  readonly eventLogErrorCode?: string;
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
    try {
      return { taskCase: await readTaskCase(path, { expectedCaseId: entry, requireComplete: true }), path };
    } catch {
      // The history list counts unreadable or invalid cases instead of allowing them into executable results.
      return undefined;
    }
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
  if (!isPersistedExperimentMetadata(metadata)) return historyWithoutMetadata(path, experimentId, await exists(metadataPath));
  const runIds = await listPersistedRunIds(path, metadata);
  const runId = runIds.at(-1);
  const recordPath = runId ? join(path, "runs", runId, "record.json") : undefined;
  const value = recordPath ? await readJson(recordPath) : undefined;
  const { events } = await readCommittedRunEvents(path);
  const attempt = latestCommittedAttempt(path, events, runId);
  const caseMismatch = attempt !== undefined && attempt.caseId !== metadata.spec.taskCaseId;
  const startup = attempt ? committedStartupFailure(events, attempt) : undefined;
  const record = runId && matchingRunRecord(value, experimentId, runId, metadata.spec.taskCaseId, events) ? value : undefined;
  const candidateModel = actualModelName(record?.manifest?.resolvedModel.resolved);
  const unread = Boolean(recordPath && !record && await exists(recordPath));
  const runOrdering = runId ? committedRunOrder(path, events).includes(runId) ? "committed" : await legacyOrderingKind(path, runIds) : undefined;
  const { comparison, ...artifacts } = await readRunComparison({ experimentRoot: path, experimentId, ...(runId ? { runId } : {}), events });
  const comparisonDetail = comparisonDetailOf(comparison);
  const committed = await readCommittedExperimentHistory(path, experimentId, runId);
  const outcome = record ? record.outcome.termination.kind : startup ? startup.status : unread ? "record unread" : committed.runStatus;
  return {
    experimentId, taskCaseId: attempt?.caseId ?? metadata.spec.taskCaseId,
    ...(caseMismatch ? { metadataTaskCaseId: metadata.spec.taskCaseId } : {}),
    ...(runId ? { runId } : {}),
    ...(runOrdering ? { runOrdering } : {}),
    ...(attempt ? { startedAt: attempt.createdAt, candidateProductId: attempt.candidate.productId } : {}),
    outcome,
    ...(startup ? { startupFailureStage: startup.stage, startupFailure: startup.error.message } : {}),
    ...(record
      ? {
          taskStatus: record.outcome.task.status,
          cleanupStatus: record.outcome.cleanup.status,
          startedAt: record.attempt.createdAt,
          candidateProductId: record.attempt.candidate.productId,
          ...(candidateModel ? { candidateModel } : {}),
        }
      : {}),
    ...artifacts,
    ...(artifacts.reportAttemptUnconfirmed && !comparison ? { comparisonStatus: "unknown" } : {}),
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
    ...(caseMismatch ? { formatError: 'metadata_case_mismatch' } : unread ? { formatError: 'unreadable_record' } : committed.diagnosticCode === "unsupported_schema" ? { formatError: committed.diagnosticCode } : {}),
    path,
    sizeBytes: await directorySize(path),
  };
}

async function historyWithoutMetadata(path: string, experimentId: string, metadataExists: boolean): Promise<HistoryExperiment> {
  const { events, eventLogErrorCode } = await readMetadataFallbackEvents(path);
  const attempt = latestCommittedAttempt(path, events);
  const startup = attempt ? committedStartupFailure(events, attempt) : undefined;
  return {
    experimentId, taskCaseId: attempt?.caseId ?? experimentId, path, sizeBytes: await directorySize(path),
    formatError: metadataExists ? "invalid_metadata" : "missing_metadata",
    ...(eventLogErrorCode ? { eventLogErrorCode, outcome: "unknown" } : {}),
    ...(attempt ? { runId: attempt.runId, runOrdering: "committed", startedAt: attempt.createdAt,
      candidateProductId: attempt.candidate.productId, outcome: startup?.status ?? "interrupted" } : {}),
    ...(startup ? { startupFailureStage: startup.stage, startupFailure: startup.error.message } : {}),
  };
}

async function readMetadataFallbackEvents(path: string): Promise<{ events: readonly EventEnvelope[]; eventLogErrorCode?: string }> {
  try { return await readCommittedRunEvents(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code))) throw error;
    // Keep damaged metadata visible with the I/O diagnosis; opening detail still reports the actual read failure.
    return { events: [], eventLogErrorCode: error.code };
  }
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
