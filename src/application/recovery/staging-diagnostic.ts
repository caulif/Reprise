/** One safe retry for a diagnostic explicitly classified as transient. */
export async function retryRecoveryPreflight<T>(
  operation: string,
  operationFn: () => Promise<T>,
  onRetry: (diagnostic: RecoveryPreflightDiagnostic) => Promise<void>,
): Promise<T> {
  try {
    return await operationFn();
  } catch (error) {
    const diagnostic = recoveryPreflightDiagnostic(error, operation);
    if (!diagnostic.retryable) throw error;
    await onRetry(diagnostic);
    return operationFn();
  }
}

export type RecoveryPreflightDiagnostic = {
  reasonCode:
    | "staging_creation_failed"
    | "source_unavailable"
    | "source_not_directory"
    | "source_workspace_overlap"
    | "source_budget_blocked"
    | "filesystem_error"
    | "unknown";
  operation: string;
  exitCategory: "hard_failure";
  retryable: boolean;
};

export function recoveryPreflightDiagnostic(
  error: unknown,
  operation: string,
): RecoveryPreflightDiagnostic {
  const facts = errorFacts(error);
  const message = facts.messages.join(" ");
  const reasonCode = message.includes("cannot be recovered")
    ? "source_budget_blocked"
    : message.includes("must be a directory")
      ? "source_not_directory"
      : message.includes("must not overlap")
        ? "source_workspace_overlap"
        : message.includes("ENOENT") || facts.codes.includes("ENOENT")
          ? "source_unavailable"
          : operation === "begin_recovery_staging" &&
              /copy|mkdir/i.test(message)
            ? "staging_creation_failed"
            : facts.codes.length > 0 ||
                /git .* probe failed|fingerprint|workspace|filesystem|copy|mkdir/i.test(
                  message,
                )
              ? "filesystem_error"
              : "unknown";
  return {
    reasonCode,
    operation: operation || "recovery_preflight",
    exitCategory: "hard_failure",
    retryable:
      reasonCode === "filesystem_error" ||
      reasonCode === "staging_creation_failed",
  };
}

function errorFacts(error: unknown): { messages: string[]; codes: string[] } {
  const messages: string[] = [];
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && messages.length < 8) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "string") codes.push(code);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return { messages, codes };
}
