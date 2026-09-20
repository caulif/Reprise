import { basename } from "node:path";
import { sameFsPath } from "../core/paths.js";
import type { ExperimentResult } from "./experiment.js";
import type { HistoryExperiment } from "./experiment-history-list.js";

/** Openable comparison artifact label for history / recent-run projection. */
export type HistoryReportKind = "Report" | "Diagnostic" | "Previous report";

/**
 * Shared result facts consumed by live recentExperiment and history detail.
 * Presentation (T01) should map these fields; missing facts stay omitted / unknown.
 */
export type ResultFactSnapshot = {
  readonly experimentId: string;
  readonly taskCaseId: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly taskStatus?: string;
  readonly cleanupStatus?: string;
  readonly comparisonStatus?: string;
  readonly comparisonFailure?: string;
  readonly comparisonDetail?: string;
  readonly reportKind?: HistoryReportKind;
  readonly reportPath?: string;
  readonly previousReportPath?: string;
  readonly reportAttemptUnconfirmed?: boolean;
  readonly startedAt?: string;
  readonly path: string;
  readonly sizeBytes: number;
};

export type ComparisonArtifactSelection = {
  readonly reportPath?: string;
  readonly reportKind?: HistoryReportKind;
  readonly previousReportPath?: string;
  readonly reportAttemptUnconfirmed?: boolean;
};

/**
 * Prefer this-attempt diagnostic for unsuccessful comparison; never promote leftover
 * report.html to a successful "Report" for cancelled / failed / unknown attempts.
 */
export function selectComparisonArtifacts(input: {
  readonly comparisonStatus?: string;
  readonly diagnosticPath?: string;
  readonly successPath?: string;
  readonly comparisonReadable?: boolean;
}): ComparisonArtifactSelection {
  const diagnostic = input.diagnosticPath;
  const success = input.successPath;
  const status = input.comparisonStatus;
  const unsuccessful =
    status === "failed" ||
    status === "cancelled" ||
    (status !== undefined && status !== "completed");

  if (unsuccessful) {
    if (diagnostic) {
      return {
        reportPath: diagnostic,
        reportKind: "Diagnostic",
        ...(success ? { previousReportPath: success } : {}),
      };
    }
    if (success) {
      return {
        reportPath: success,
        reportKind: "Previous report",
        previousReportPath: success,
        reportAttemptUnconfirmed: true,
      };
    }
    return {};
  }

  if (input.comparisonReadable === false && (success || diagnostic)) {
    const primary = success ?? diagnostic;
    return {
      ...(primary ? { reportPath: primary, reportKind: success ? "Previous report" : "Diagnostic" } : {}),
      ...(success && diagnostic ? { previousReportPath: success === primary ? diagnostic : success } : {}),
      reportAttemptUnconfirmed: true,
    };
  }

  if (success) {
    return {
      reportPath: success,
      reportKind: "Report",
      ...(diagnostic ? { previousReportPath: diagnostic } : {}),
    };
  }
  if (diagnostic) {
    return { reportPath: diagnostic, reportKind: "Diagnostic", reportAttemptUnconfirmed: true };
  }
  return {};
}

export function comparisonDetailOf(comparison: {
  readonly status: string;
  readonly value?: { readonly status?: string };
} | undefined): string | undefined {
  if (!comparison || comparison.status !== "completed") return undefined;
  const detail = comparison.value?.status;
  return detail && detail !== "completed" ? detail : undefined;
}

/** Build the HistoryExperiment / recentExperiment projection from a live ExperimentResult. */
export function historyExperimentFromResult(
  result: ExperimentResult,
  input: { readonly experimentRoot: string; readonly taskCaseId: string; readonly sizeBytes?: number },
): HistoryExperiment {
  const comparison = result.comparison.result;
  const skipped = comparison.status === "skipped";
  const reportPath = presentableLiveReportPath(result.reportPath, input.experimentRoot);
  const isDiagnostic = reportPath !== undefined && basename(reportPath).toLowerCase() === "comparison-failure.html";
  const isSuccessReport = reportPath !== undefined && basename(reportPath).toLowerCase() === "report.html";
  const artifacts = skipped
    ? {}
    : selectComparisonArtifacts({
        comparisonStatus: comparison.status,
        ...(isDiagnostic ? { diagnosticPath: reportPath } : {}),
        ...(isSuccessReport ? { successPath: reportPath } : {}),
        ...(reportPath && !isDiagnostic && !isSuccessReport
          ? comparison.status === "completed"
            ? { successPath: reportPath }
            : { diagnosticPath: reportPath }
          : {}),
        comparisonReadable: true,
      });
  const failure =
    comparison.status === "failed" && "failure" in comparison
      ? comparison.failure.kind ?? comparison.failure.code
      : undefined;
  const detail = !skipped ? comparisonDetailOf(comparison) : undefined;
  return {
    experimentId: basename(input.experimentRoot),
    taskCaseId: input.taskCaseId,
    runId: result.record.attempt.runId,
    outcome: result.record.outcome.termination.kind,
    taskStatus: result.record.outcome.task.status,
    cleanupStatus: result.record.outcome.cleanup.status,
    startedAt: result.record.attempt.createdAt,
    path: input.experimentRoot,
    sizeBytes: input.sizeBytes ?? 0,
    ...(!skipped ? { comparisonStatus: comparison.status } : {}),
    ...(failure ? { comparisonFailure: failure } : {}),
    ...(detail ? { comparisonDetail: detail } : {}),
    ...artifacts,
  };
}

export function resultFactsFromHistory(item: HistoryExperiment): ResultFactSnapshot {
  return {
    experimentId: item.experimentId,
    taskCaseId: item.taskCaseId,
    path: item.path,
    sizeBytes: item.sizeBytes,
    ...(item.runId ? { runId: item.runId } : {}),
    ...(item.outcome ? { outcome: item.outcome } : {}),
    ...(item.taskStatus ? { taskStatus: item.taskStatus } : {}),
    ...(item.cleanupStatus ? { cleanupStatus: item.cleanupStatus } : {}),
    ...(item.comparisonStatus ? { comparisonStatus: item.comparisonStatus } : {}),
    ...(item.comparisonFailure ? { comparisonFailure: item.comparisonFailure } : {}),
    ...(item.comparisonDetail ? { comparisonDetail: item.comparisonDetail } : {}),
    ...(item.reportKind ? { reportKind: item.reportKind } : {}),
    ...(item.reportPath ? { reportPath: item.reportPath } : {}),
    ...(item.previousReportPath ? { previousReportPath: item.previousReportPath } : {}),
    ...(item.reportAttemptUnconfirmed ? { reportAttemptUnconfirmed: true } : {}),
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
  };
}

export function resultFactsFromLiveResult(
  result: ExperimentResult,
  input: { readonly experimentRoot: string; readonly taskCaseId: string },
): ResultFactSnapshot {
  return resultFactsFromHistory(historyExperimentFromResult(result, input));
}

function presentableLiveReportPath(reportPath: string | undefined, experimentRoot: string): string | undefined {
  if (!reportPath?.trim()) return undefined;
  const trimmed = reportPath.trim();
  if (sameFsPath(trimmed, experimentRoot)) return undefined;
  return trimmed;
}
