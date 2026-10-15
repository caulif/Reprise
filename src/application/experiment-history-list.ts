import { readTaskCase, readTaskCaseMetadata } from '../products/shared/task-case-reader.js';
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import { readCommittedExperimentHistory } from "./experiment-history-read.js";
import { listPersistedRunIds } from "./experiment-layout.js";
import { readExperimentMetadata, assertExperimentTaskIdentity } from './experiment-metadata.js';
import type { ExperimentSpec } from '../core/schema.js';
import { comparisonDetailOf } from "./comparison-artifacts.js";
import { listPublishedFrozenCases } from "../products/shared/freeze.js";
import { actualModelName } from "./actual-model-name.js";
import { committedRunOrder, committedStartupFailure, latestCommittedAttempt, legacyOrderingKind, matchingRunRecord, readCommittedRunEvents } from "./experiment-run-history.js";
import { historicalRunStatus } from '../infrastructure/agent/history-read.js';
import { collectHistoryStorageSize, mapHistoryItems, historyIoErrorCode } from './history-io.js';
import { resolvedExperimentRoot } from './experiment-layout.js';
import { readRunComparison } from "./comparison-report-ownership.js";

export type HistoryCase = { readonly taskCase: TaskCase; readonly path: string; readonly filesVerified?: boolean };
export type HistoryExperiment = {
  readonly experimentId: string;
  readonly taskCaseId: string;
  readonly metadataTaskCaseId?: string;
  readonly taskIdentity?: 'fixed-v2' | 'legacy-unverified';
  readonly taskCaseFilesVerified?: boolean;
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
  /** Saved comparison value status, including completed; missing detail remains unknown. */

  readonly comparisonFailureStage?: string;
  readonly comparisonFailureMessage?: string;
  readonly comparisonDetail?: string;
  readonly startedAt?: string;
  readonly reportPath?: string;
  /** Prior successful report retained beside this attempt's diagnostic. */
  readonly previousReportPath?: string;
  /** True when an on-disk HTML exists but attempt ownership is not confirmed. */
  readonly reportAttemptUnconfirmed?: boolean;
  readonly path: string;
  readonly sizeBytes: number | undefined;
  readonly modelInputAudit?: 'checked' | 'not_checked';
  readonly eventLogDiagnostic?: string;
  readonly incompleteModelInput?: boolean;
  readonly formatError?: string;
  readonly eventLogErrorCode?: string;
};

type HistoryReadOptions = { readonly audit: boolean; readonly sizes: boolean };
export type LocalHistory = { readonly cases: readonly HistoryCase[]; readonly experiments: readonly HistoryExperiment[];
  readonly totalBytes: number | undefined; readonly storageSizeStatus: 'collected' | 'not_collected'; readonly invalidCaseCount: number };

/** Lists only schema-validated local objects beneath Reprise's configured data directory. */
export async function readLocalHistory(dataDir: string): Promise<LocalHistory & { readonly totalBytes: number }> {
  const history = await readHistory(dataDir, { audit: true, sizes: true });
  return { ...history, totalBytes: history.totalBytes! };
}

/** Version 2 listing defers model-input audit and storage walks; selected details remain explicit. */
export async function readLocalHistoryListing(dataDir: string): Promise<LocalHistory> {
  return readHistory(dataDir, { audit: false, sizes: false });
}

export async function readLocalHistoryExperiment(dataDir: string, experimentId: string): Promise<HistoryExperiment> {
  return readExperiment(resolvedExperimentRoot(dataDir, experimentId), experimentId, { audit: true, sizes: false });
}

async function readHistory(dataDir: string, options: HistoryReadOptions): Promise<LocalHistory> {
  const root = resolve(dataDir);
  const [{ cases, invalidCount }, sized, totalBytes] = await Promise.all([readCases(root, options), readExperiments(root, options), options.sizes ? collectHistoryStorageSize(root) : undefined]);
  const titles = new Map(cases.map(({ taskCase }) => [taskCase.caseId, taskCase.initialInput.text.replace(/\s+/g, ' ').trim()]));
  const experiments = sized.map((item) => {
    const title = item.formatError === 'fixed_task_identity_mismatch' ? undefined : titles.get(item.taskCaseId);
    return title ? { ...item, taskTitle: title } : item;
  });
  return { cases, experiments, totalBytes: totalBytes?.bytes, storageSizeStatus: totalBytes ? 'collected' : 'not_collected', invalidCaseCount: invalidCount };
}

async function readCases(root: string, options: HistoryReadOptions): Promise<{ cases: readonly HistoryCase[]; invalidCount: number }> {
  const directory = join(root, "cases");
  const entries = await listPublishedFrozenCases(directory);
  const cases = await mapHistoryItems(entries, async (entry) => {
    const path = join(directory, entry, "case.json");
    try {
      if (options.audit) return { taskCase: await readTaskCase(path, { expectedCaseId: entry, requireComplete: true }), path };
      return { taskCase: await readTaskCaseMetadata(path, { expectedCaseId: entry, requireComplete: true }), path, filesVerified: false };
    } catch {
      // The history list counts unreadable or invalid cases instead of allowing them into executable results.
      return undefined;
    }
  });
  const valid = cases.filter((item): item is HistoryCase => item !== undefined);
  return {
    cases: valid.sort((left, right) => right.taskCase.provenance.importedAt.localeCompare(left.taskCase.provenance.importedAt)),
    invalidCount: cases.length - valid.length,
  };
}

async function readExperiments(root: string, options: HistoryReadOptions): Promise<readonly HistoryExperiment[]> {
  const directory = join(root, "experiments");
  const entries = await safeDirectories(directory);
  const experiments = await mapHistoryItems(entries, async entry => {
    try { return await readExperiment(join(directory, entry), entry, options); }
    catch (error) {
      const eventLogErrorCode = historyIoErrorCode(error);
      if (!eventLogErrorCode) throw error;
      return { experimentId: entry, taskCaseId: entry, path: join(directory, entry), sizeBytes: undefined,
        outcome: 'unknown', eventLogErrorCode, formatError: 'unreadable_entry', modelInputAudit: 'not_checked' as const };
    }
  });
  return experiments.sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

async function readExperiment(path: string, experimentId: string, options: HistoryReadOptions): Promise<HistoryExperiment> {
  const metadataPath = join(path, "experiment.json");
  const read = await readExperimentMetadata(metadataPath, experimentId);
  if (read.kind !== 'current' && read.kind !== 'legacy') return historyWithoutMetadata(path, experimentId, read.kind !== 'missing', options, read.diagnostic);
  const metadata = read.value;
  const identityError = metadata.spec.schemaVersion === 2 && !(await fixedTaskIdentityMatches(path, metadata.spec, options));
  const runIds = await listPersistedRunIds(path, metadata);
  const runId = runIds.at(-1);
  const recordPath = runId ? join(path, "runs", runId, "record.json") : undefined;
  const value = recordPath ? await readJson(recordPath) : undefined;
  const { events, diagnostic } = await readCommittedRunEvents(path);
  const attempt = latestCommittedAttempt(path, events, runId);
  const caseMismatch = attempt !== undefined && attempt.caseId !== metadata.spec.taskCaseId;
  const startup = attempt ? committedStartupFailure(events, attempt) : undefined;
  const record = runId && matchingRunRecord(value, experimentId, runId, metadata.spec.taskCaseId, events) ? value : undefined;
  const candidateModel = actualModelName(record?.manifest?.resolvedModel.resolved);
  const unread = Boolean(recordPath && !record && await exists(recordPath));
  const runOrdering = runId ? committedRunOrder(path, events).includes(runId) ? "committed" : await legacyOrderingKind(path, runIds) : undefined;
  const { comparison, ...artifacts } = await readRunComparison({ experimentRoot: path, experimentId, ...(runId ? { runId } : {}), events });
  const comparisonDetail = comparisonDetailOf(comparison);
  const committed = options.audit ? await readCommittedExperimentHistory(path, experimentId, runId)
    : { runStatus: historicalRunStatus(runId ? events.filter(event => event.runId === runId) : events), incompleteModelInput: false, diagnosticCode: diagnostic?.code };
  const outcome = record ? record.outcome.termination.kind : startup ? startup.status : unread ? "record unread" : committed.runStatus;
  return {
    experimentId, taskCaseId: attempt?.caseId ?? metadata.spec.taskCaseId,
    ...(metadata.spec.schemaVersion === 2 ? { taskCaseFilesVerified: options.audit && !identityError } : {}),
    taskIdentity: metadata.spec.schemaVersion === 2 && metadata.spec.taskCaseIdentity.kind === 'frozen-v2' ? 'fixed-v2' : 'legacy-unverified',
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
    modelInputAudit: options.audit ? 'checked' : 'not_checked',
    ...(diagnostic ? { eventLogDiagnostic: diagnostic.code } : {}),
    ...(committed.incompleteModelInput ? { incompleteModelInput: true } : {}),
    ...(identityError ? { formatError: 'fixed_task_identity_mismatch' } : caseMismatch ? { formatError: 'metadata_case_mismatch' } : unread ? { formatError: 'unreadable_record' } : committed.diagnosticCode === "unsupported_schema" ? { formatError: committed.diagnosticCode } : {}),
    path,
    sizeBytes: options.sizes ? (await collectHistoryStorageSize(path)).bytes : undefined,
  };
}

async function fixedTaskIdentityMatches(path: string, spec: ExperimentSpec, options: HistoryReadOptions): Promise<boolean> {
  try {
    const reader = options.audit ? readTaskCase : readTaskCaseMetadata;
    const task = await reader(join(resolve(path, '..', '..'), 'cases', spec.taskCaseId, 'case.json'), { expectedCaseId: spec.taskCaseId, requireComplete: true });
    assertExperimentTaskIdentity(spec, task);
    return true;
  } catch {
    // Keep the committed run visible, but do not certify unreadable or mismatched scene content.
    return false;
  }
}

async function historyWithoutMetadata(path: string, experimentId: string, metadataExists: boolean, options: HistoryReadOptions, diagnostic?: string): Promise<HistoryExperiment> {
  const { events, eventLogErrorCode, eventLogDiagnostic } = await readMetadataFallbackEvents(path);
  const attempt = latestCommittedAttempt(path, events);
  const startup = attempt ? committedStartupFailure(events, attempt) : undefined;
  return {
    experimentId, taskCaseId: attempt?.caseId ?? experimentId, path, sizeBytes: options.sizes ? (await collectHistoryStorageSize(path)).bytes : undefined,
    formatError: diagnostic === 'unsupported_experiment_schema' ? diagnostic : metadataExists ? "invalid_metadata" : "missing_metadata",
    modelInputAudit: 'not_checked',
    ...(eventLogDiagnostic ? { eventLogDiagnostic } : {}),
    ...(eventLogErrorCode ? { eventLogErrorCode, outcome: "unknown" } : {}),
    ...(attempt ? { runId: attempt.runId, runOrdering: "committed", startedAt: attempt.createdAt,
      candidateProductId: attempt.candidate.productId, outcome: startup?.status ?? "interrupted" } : {}),
    ...(startup ? { startupFailureStage: startup.stage, startupFailure: startup.error.message } : {}),
  };
}

async function readMetadataFallbackEvents(path: string): Promise<{ events: readonly EventEnvelope[]; eventLogErrorCode?: string; eventLogDiagnostic?: string }> {
  try {
    const { events, diagnostic } = await readCommittedRunEvents(path);
    return { events, ...(diagnostic ? { eventLogDiagnostic: diagnostic.code } : {}) };
  }
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
