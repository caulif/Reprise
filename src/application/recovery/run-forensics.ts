import { resolvedRecoveryFacts } from "../../infrastructure/recovery-tools.js";
import { forensicsFact } from "./investigation.js";
import {
  moveRecoveryState,
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./session.js";
import { recoveryAttemptRecord } from "./orchestrator.js";
import { sha256 } from "../../core/identity.js";

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
}

export async function persistRecoveryInvestigation(session: RecoveryRunSession): Promise<void> {
  const { input, store, facts, staging } = session;
  if (!facts || !staging) throw new Error("Recovery forensics was not prepared.");
  session.preflightOperation = "recovery_persist_investigation";
  moveRecoveryState(session, "candidate_running");
  const summary = {
    schemaVersion: 1,
    caseId: input.caseId,
    git: facts.git ? { isRepo: facts.git.isRepo, headState: facts.git.headState } : undefined,
    patchCount: facts.patches.length,
    preimageCount: facts.preimages.length,
    catalogCount: facts.catalog.length,
    observations: "observations/INDEX.md",
  };
  await store.commitArtifact({
    artifactId: "recovery-forensics-summary",
    kind: "recovery_investigation",
    mediaType: "application/json",
    bytes: Buffer.from(JSON.stringify(summary), "utf8"),
    operationId: "recovery-investigation-created",
  });
  await store.append({
    type: "recovery.investigation_created",
    runId: input.runId,
    operationId: "recovery-investigation-event",
    payload: {
      factCount: facts.catalog.length,
      digest: sha256(JSON.stringify(summary)),
      artifactId: "recovery-forensics-summary",
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
  await persistRecoveryInvestigation(session);
}
