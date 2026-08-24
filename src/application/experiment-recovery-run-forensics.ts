import { Value } from "@sinclair/typebox/value";
import { RecoveryInvestigationSchema } from "../core/schema.js";
import { resolvedRecoveryFacts } from "../infrastructure/recovery-tools.js";
import {
  forensicsFact,
  initialRecoveryInvestigation,
} from "./experiment-recovery-support.js";
import {
  moveRecoveryState,
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./experiment-recovery-session.js";
import { decideRecoverySearch } from "./recovery-selection.js";
import { materializeRecoveryCandidates } from "./recovery-candidate-materialization.js";
import { recoveryAttemptRecord } from "./recovery-orchestrator.js";

export async function startRecoveryForensics(session: RecoveryRunSession): Promise<void> {
  const { input, store, staging, attemptMode } = session;
  if (!staging) throw new Error("Recovery staging was not prepared.");
  moveRecoveryState(session, "forensics_running");
  await recordRecoveryAttempt(
    session,
    recoveryAttemptRecord({
      attemptId: "recovery-attempt-forensics-started",
      phase: "forensics",
      operation: "resolve_facts",
      attemptNumber: 1,
      result: "started",
      durationMs: 0,
      recordedAt: input.now,
    }),
  );
  await store.append({
    type: "recovery.forensics_started",
    runId: input.runId,
    operationId: "recovery-forensics-started",
    payload: {
      mode: attemptMode,
      sources: ["workspace", "git", "transcript", "historical_events"],
    },
  });
  const forensicsStartedAt = Date.now();
  session.facts = await resolvedRecoveryFacts(staging.root, input.taskCase);
  await recordRecoveryAttempt(
    session,
    recoveryAttemptRecord({
      attemptId: "recovery-attempt-forensics-completed",
      phase: "forensics",
      operation: "resolve_facts",
      attemptNumber: 1,
      result: "succeeded",
      durationMs: Math.max(0, Date.now() - forensicsStartedAt),
      recordedAt: new Date().toISOString(),
    }),
  );
  moveRecoveryState(session, "hypotheses_ready");
  session.preflightOperation = "recovery_build_investigation";
  const facts = session.facts;
  session.evidenceSourcesAttempted = 4;
  session.evidenceSourcesAvailable = [
    true,
    facts.git !== undefined,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events") || facts.verifiedEvidence.length > 0,
  ].filter(Boolean).length;
  session.hypothesisCount = initialRecoveryInvestigation(facts, input.now).plan.hypotheses.length;
}

export async function materializeSeedCandidates(session: RecoveryRunSession): Promise<void> {
  const { input, store, provider, facts, activeStaging } = session;
  if (!facts || !activeStaging) throw new Error("Recovery forensics was not prepared.");
  session.preflightOperation = "recovery_create_candidates";
  moveRecoveryState(session, "candidate_running");
  const seed = initialRecoveryInvestigation(facts, input.now);
  const candidateCreationStartedAt = Date.now();
  session.candidateRecipeDigests = new Set<string>();
  session.candidateStagings = await materializeRecoveryCandidates(
    seed.plan.candidates.map((candidate) => ({
      candidateId: `candidate-${candidate.hypothesisId}`,
      hypothesisId: candidate.hypothesisId,
      operations: candidate.operations,
      baseDigest: activeStaging.checkpointFingerprint?.digest ?? activeStaging.sourceFingerprint.digest,
    })),
    {
      seenRecipeDigests: session.candidateRecipeDigests,
      create: (candidate) => provider.createRecoveryCandidate(activeStaging, candidate),
      onRetry: async ({ candidateId, attempt, reasonCode }) => {
        await store.append({
          type: "recovery.candidate_materialization_retry",
          runId: input.runId,
          operationId: `recovery-candidate-retry-${candidateId}-${attempt}`,
          payload: { candidateId, attempt, reasonCode },
        });
      },
    },
  );
  const candidateCreationDurationMs = Math.max(0, Date.now() - candidateCreationStartedAt);
  session.candidateCreated = true;
  session.candidateCount = session.candidateStagings.length;
  if (session.candidateStagings.length > 0)
    await recordRecoveryAttempt(
      session,
      recoveryAttemptRecord({
        attemptId: "recovery-attempt-candidates-materialization",
        phase: "candidate",
        operation: "create_candidate",
        attemptNumber: 1,
        result: "succeeded",
        durationMs: candidateCreationDurationMs,
        recordedAt: new Date().toISOString(),
      }),
    );
  session.remainingSearchBudget = input.maxToolCalls;
  let knownFactRefs: string[] = [];
  for (const hypothesis of seed.plan.hypotheses) {
    const decision = decideRecoverySearch({
      newEvidenceRefs: hypothesis.supportingFactRefs,
      knownEvidenceRefs: knownFactRefs,
      estimatedCost: 1,
      risk: hypothesis.confidence === "high" ? 0.1 : hypothesis.confidence === "medium" ? 0.3 : 0.5,
      remainingBudget: session.remainingSearchBudget,
    });
    session.remainingSearchBudget = Math.max(0, session.remainingSearchBudget - 1);
    knownFactRefs = [...new Set([...knownFactRefs, ...hypothesis.supportingFactRefs])];
    await store.append({
      type: "recovery.search_decision",
      runId: input.runId,
      operationId: `recovery-search-decision-${hypothesis.hypothesisId}`,
      payload: { hypothesisId: hypothesis.hypothesisId, ...decision },
    });
  }
  session.investigation = {
    ...seed,
    candidates: session.candidateStagings.map((candidate) => ({
      candidateId: candidate.candidateId,
      hypothesisId: candidate.hypothesisId,
      status: "created",
      factRefs:
        seed.plan.hypotheses.find((hypothesis) => hypothesis.hypothesisId === candidate.hypothesisId)
          ?.supportingFactRefs ?? [],
      beforeDigest: candidate.beforeFingerprint.digest,
      createdAt: candidate.createdAt,
    })),
  };
}

export async function persistRecoveryInvestigation(session: RecoveryRunSession): Promise<void> {
  const { input, store, facts, investigation, candidateStagings } = session;
  if (!facts || !investigation || !candidateStagings)
    throw new Error("Recovery investigation was not prepared.");
  session.preflightOperation = "recovery_persist_investigation";
  if (!Value.Check(RecoveryInvestigationSchema, investigation))
    throw new Error("Recovery investigation did not satisfy its persistence schema.");
  for (const candidate of candidateStagings)
    await store.append({
      type: "recovery.candidate_created",
      runId: input.runId,
      operationId: `recovery-candidate-created-${candidate.candidateId}`,
      payload: {
        caseId: input.caseId,
        candidateId: candidate.candidateId,
        hypothesisId: candidate.hypothesisId,
      },
    });
  const executionCandidate = candidateStagings[0];
  if (!executionCandidate) throw new Error("Recovery investigation created no candidate.");
  session.executionCandidate = executionCandidate;
  await store.append({
    type: "recovery.candidate_selected",
    runId: input.runId,
    operationId: `recovery-candidate-selected-${executionCandidate.candidateId}`,
    payload: {
      candidateId: executionCandidate.candidateId,
      hypothesisId: executionCandidate.hypothesisId,
      selection: "highest_evidence_first",
    },
  });
  await store.commitArtifact({
    artifactId: "recovery-investigation",
    kind: "recovery_investigation",
    mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(investigation), "utf8"),
    operationId: "recovery-investigation-created",
  });
  await store.append({
    type: "recovery.investigation_created",
    runId: input.runId,
    operationId: "recovery-investigation-event",
    payload: {
      factCount: investigation.facts.length,
      hypothesisCount: investigation.plan.hypotheses.length,
      artifactId: "recovery-investigation",
    },
  });
  session.preflightOperation = "recovery_forensics_complete";
  await store.append({
    type: "recovery.forensics_completed",
    runId: input.runId,
    operationId: "recovery-forensics-completed",
    payload: forensicsFact(facts),
  });
  session.forensicsCompleted = true;
}

export async function runRecoveryForensics(session: RecoveryRunSession): Promise<void> {
  await startRecoveryForensics(session);
  await materializeSeedCandidates(session);
  await persistRecoveryInvestigation(session);
}
