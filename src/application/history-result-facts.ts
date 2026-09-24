import { basename } from "node:path";
import { sameFsPath } from "../core/paths.js";
import type { ExperimentResult } from "./experiment.js";
import type { TaskCase } from "../core/schema.js";
import type { HistoryExperiment } from "./experiment-history-list.js";
import { comparisonDetailOf, selectComparisonArtifacts } from "./comparison-artifacts.js";

/** Build the HistoryExperiment / recentExperiment projection from a live ExperimentResult. */
export function historyExperimentFromResult(
  result: ExperimentResult,
  input: { readonly experimentRoot: string; readonly taskCaseId: string; readonly taskCase?: TaskCase; readonly sizeBytes?: number },
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
    ...((result.taskCase ?? input.taskCase)?.initialInput.text.trim() ? { taskTitle: (result.taskCase ?? input.taskCase).initialInput.text.replace(/\s+/g, ' ').trim() } : {}),
    ...(result.record.attempt?.candidate?.productId ? { candidateProductId: result.record.attempt.candidate.productId } : {}),
    ...(result.record.attempt?.candidate?.requestedModel ? { candidateModel: result.record.attempt.candidate.requestedModel } : {}),
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

function presentableLiveReportPath(reportPath: string | undefined, experimentRoot: string): string | undefined {
  if (!reportPath?.trim()) return undefined;
  const trimmed = reportPath.trim();
  if (sameFsPath(trimmed, experimentRoot)) return undefined;
  return trimmed;
}
