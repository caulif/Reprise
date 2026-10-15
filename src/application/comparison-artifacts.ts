/**
 * Disk ownership for comparison HTML under an experiment root.
 * Labels belong to T01 presentation; this module only picks paths.
 */
import { basename } from "node:path";

export function comparisonHtmlKind(path: string): "success" | "diagnostic" | undefined {
  const name = basename(path).toLowerCase();
  if (name === "report.html" || /^report-[a-z0-9][a-z0-9._-]{0,127}\.html$/.test(name)) return "success";
  if (name === "comparison-failure.html" || /^comparison-failure-[a-z0-9][a-z0-9._-]{0,127}\.html$/.test(name)) return "diagnostic";
  return undefined;
}

export type ComparisonArtifactSelection = {
  readonly reportPath?: string;
  readonly previousReportPath?: string;
  readonly reportAttemptUnconfirmed?: boolean;
};

/**
 * Prefer this-attempt diagnostic for unsuccessful comparison; never promote leftover
 * report.html to a confirmed success open for cancelled / failed / unknown attempts.
 * previousReportPath is only the retained success HTML beside a primary diagnostic.
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
        ...(success ? { previousReportPath: success } : {}),
      };
    }
    if (success) {
      return {
        reportPath: success,
        previousReportPath: success,
        reportAttemptUnconfirmed: true,
      };
    }
    return {};
  }

  if (input.comparisonReadable === false && (success || diagnostic)) {
    if (success) {
      return {
        reportPath: success,
        reportAttemptUnconfirmed: true,
      };
    }
    if (diagnostic) {
      return {
        reportPath: diagnostic,
        reportAttemptUnconfirmed: true,
      };
    }
    return {};
  }

  if (success) {
    return { reportPath: success };
  }
  if (diagnostic) {
    return { reportPath: diagnostic, reportAttemptUnconfirmed: true };
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
