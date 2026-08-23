import type { RecoveryCandidate, RecoveryFact } from "../core/schema.js";

export type RecoveryCandidateVerdict = {
  status: "verified" | "pending_user_review" | "rejected";
  reasonCodes: readonly (
    | "contradictory_fact"
    | "strong_evidence_complete"
    | "weak_or_incomplete_evidence"
    | "no_task_path_outcome"
  )[];
};

/**
 * Separates what was safely attempted from what may be claimed as verified.
 * It is deliberately pure so the Host can audit it before promoting a candidate.
 */
export function verifyRecoveryCandidate(
  candidate: Pick<RecoveryCandidate, "factRefs">,
  facts: readonly RecoveryFact[],
  changedPaths: readonly string[],
  recoveryStatus: "recovered" | "partial" | "insufficient_evidence",
): RecoveryCandidateVerdict {
  const referenced = new Set(candidate.factRefs);
  const relevant = facts.filter(
    (fact) =>
      referenced.has(`fact:${fact.factId}`) ||
      changedPaths.some((path) => scopeIncludes(fact.pathScope, path)),
  );
  if (relevant.some((fact) => fact.reliability === "contradicted"))
    return { status: "rejected", reasonCodes: ["contradictory_fact"] };
  // Delivery sinks (report/manifest) are excluded before this verifier. A model cannot
  // claim recovered/partial without a Host-observed task-path outcome; checkpoint no-op
  // recovery is handled by the separate deterministic Host checkpoint path.
  if ((recoveryStatus === "recovered" || recoveryStatus === "partial") && changedPaths.length === 0)
    return { status: "rejected", reasonCodes: ["no_task_path_outcome"] };
  const everyChangedPathHasStrongFact =
    changedPaths.length > 0 &&
    changedPaths.every((path) =>
      relevant.some(
        (fact) =>
          fact.reliability === "strong" && scopeIncludes(fact.pathScope, path),
      ),
    );
  if (recoveryStatus === "recovered" && everyChangedPathHasStrongFact)
    return { status: "verified", reasonCodes: ["strong_evidence_complete"] };
  return {
    status: "pending_user_review",
    reasonCodes: ["weak_or_incomplete_evidence"],
  };
}

function scopeIncludes(scopes: readonly string[], path: string): boolean {
  return scopes.some((scope) => scope === "." || scope === path || path.startsWith(`${scope}/`));
}
