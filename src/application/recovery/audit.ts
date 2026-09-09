import { sha256 } from "../../core/identity.js";

/** Retries only transient execution failures; protocol, privacy, and cancellation failures remain terminal. */
export function recoveryModelInputAudit(
  context: Record<string, unknown>,
  toolNames: readonly string[],
): Record<string, unknown> {
  const task = context.task as Record<string, unknown> | undefined;
  const session = context.session as Record<string, unknown> | undefined;
  const investigation = context.investigation as Record<string, unknown> | undefined;
  const staging = context.staging as Record<string, unknown> | undefined;
  const budget = context.budget as Record<string, unknown> | undefined;
  const initialInput = task?.initialInput;
  return {
    schemaVersion: 1,
    taskCaseId: typeof task?.caseId === "string" ? task.caseId : "unknown",
    evidenceLevel: context.evidenceLevel,
    attemptMode: context.attemptMode,
    session: {
      transcriptLength: session?.transcriptLength,
      historicalEventCount: session?.historicalEventCount,
    },
    investigation: {
      planId: investigation?.planId,
      factRefs: investigation?.factRefs,
      hypothesisIds: Array.isArray(investigation?.hypotheses)
        ? investigation.hypotheses.flatMap((hypothesis) => {
            const value = hypothesis as Record<string, unknown>;
            return typeof value.hypothesisId === "string" ? [value.hypothesisId] : [];
          })
        : [],
    },
    runtimeCapabilities: context.runtimeCapabilities,
    staging: {
      fileCount: staging?.fileCount,
      totalBytes: staging?.totalBytes,
      excludedEntries: staging?.excludedEntries,
    },
    budget: { timeoutMs: budget?.timeoutMs },
    allowModelText: context.allowModelText,
    toolNames: [...toolNames],
    contextDigest: sha256(JSON.stringify(context) ?? "undefined"),
    initialInputDigest: sha256(JSON.stringify(initialInput) ?? "undefined"),
  };
}

