import { Value } from "@sinclair/typebox/value";
import {
  RecoveryPreTaskDiagnosisSchema,
} from "../../core/schema.js";
import { writeImmutableJson } from "../../infrastructure/store/experiment-store.js";
import { evaluateRecoveryPreTaskConditions } from "../../environment/recovery-pre-task.js";
import {
  measureRecoveryStagingReadiness,
  taskContinuationOutcome,
} from "./readiness.js";
import {
  diagnosisReasonCode,
  persistRecoveryAttemptDiagnosis,
  recoveryAcceptIsExposed,
  recoveryAttemptDiagnosis,
} from "./user-status.js";
import { recoveryAttemptRecord } from "./orchestrator.js";
import {
  lifecycleState,
  moveRecoveryState,
  recordRecoveryAttempt,
  type RecoveryRunSession,
} from "./session.js";
import type { RecoveryAttempt } from "./types.js";
import type { RecoveryEnvelope } from "../../environment/local-workspace-provider.js";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function finalizeRecoveredCandidate(session: RecoveryRunSession): Promise<RecoveryAttempt> {
  const { input, store, provider, staging, recovery, facts } = session;
  if (!staging || !recovery || recovery.status !== "completed" || !facts)
    throw new Error("Recovery finalize was not prepared.");
  await ensureRecoveryReport(staging.root, recovery.value);
  session.failureStage = "provider_validation_failed";
  const providerVerificationStartedAt = Date.now();
  const validated = await provider.validateRecovery(staging, recovery.value);
  session.readinessResult = await measureRecoveryStagingReadiness(staging.root, input.taskCase, {
    executeCommands: Boolean(input.executeReadinessCommands),
    cwd: input.sourceRoot,
  });
  await store.append({
    type: "recovery.readiness_checked",
    runId: input.runId,
    operationId: "recovery-readiness-checked",
    payload: {
      status: session.readinessResult.status,
      missingPathCount: session.readinessResult.missingPaths.length,
      commandCheckCount: session.readinessResult.commandChecks.length,
    },
  });
  session.activeProviderPreview = validated;
  await recordRecoveryAttempt(
    session,
    recoveryAttemptRecord({
      attemptId: "recovery-attempt-provider-verification",
      phase: "validated",
      operation: "validate",
      attemptNumber: 1,
      result: "succeeded",
      durationMs: Math.max(0, Date.now() - providerVerificationStartedAt),
      recordedAt: new Date().toISOString(),
    }),
  );
  const preTaskBlocksReady = await applyPreTaskReadyGate(session, recovery.value.status);
  const hostReady = recovery.value.status === "ready" && !preTaskBlocksReady;
  moveRecoveryState(session, "validated");
  session.verification = hostReady ? "verified" : "rejected";
  session.taskOutcome = preTaskBlocksReady ? "blocked_by_safety" : taskContinuationOutcome(recovery.value.status);
  const preview = session.activeProviderPreview;
  if (preview.baseline.recovery && session.taskOutcome) {
    const baseline = {
      ...preview.baseline,
      recovery: { ...preview.baseline.recovery, taskOutcome: session.taskOutcome },
    };
    session.activeProviderPreview = { ...preview, baseline };
  }
  const mayAccept = hostReady;
  if (mayAccept) {
    session.automaticallyAcceptedBaseline = await provider.acceptRecovery(session.activeProviderPreview);
    if (session.automaticallyAcceptedBaseline.recovery && session.taskOutcome) {
      session.automaticallyAcceptedBaseline = {
        ...session.automaticallyAcceptedBaseline,
        recovery: { ...session.automaticallyAcceptedBaseline.recovery, taskOutcome: session.taskOutcome },
      };
    }
    moveRecoveryState(session, "accepted");
    await store.append({
      type: "recovery.lifecycle_completed",
      runId: input.runId,
      operationId: "recovery-lifecycle-accepted-automatically",
      payload: { state: lifecycleState(session), automatic: true, taskOutcome: session.taskOutcome },
    });
    session.activeProviderPreview = { ...session.activeProviderPreview, baseline: session.automaticallyAcceptedBaseline, accepted: true };
  }
  await persistRecoveryCompletionArtifacts(session, session.activeProviderPreview);
  return completeRecoveryAttempt(session);
}

async function applyPreTaskReadyGate(
  session: RecoveryRunSession,
  envelopeStatus: string,
): Promise<boolean> {
  const { input, store, staging, activeProviderPreview } = session;
  if (envelopeStatus !== "ready" || !staging || !activeProviderPreview) return false;
  const preTask = await evaluateRecoveryPreTaskConditions(staging.root, input.taskCase);
  if (preTask.readyAllowed) return false;
  if (!Value.Check(RecoveryPreTaskDiagnosisSchema, preTask)) {
    throw new Error("Recovery pre-task diagnosis does not match RecoveryPreTaskDiagnosisSchema.");
  }
  await writeImmutableJson(join(session.experimentRoot, "recovery-pre-task.json"), preTask);
  await store.append({
    type: "recovery.warning",
    runId: input.runId,
    operationId: "recovery-pre-task-head",
    payload: {
      summary: preTask.reasons[0] ?? "Work-copy HEAD is not the pre-task commit.",
      head: preTask.head,
      taskCommit: preTask.taskCommit,
      preTaskCommit: preTask.preTaskCommit,
      dirtyPathCount: preTask.dirtyPaths.length,
    },
  });
  session.activeProviderPreview = {
    ...activeProviderPreview,
    baseline: {
      ...activeProviderPreview.baseline,
      match: "observational",
      warnings: [...activeProviderPreview.baseline.warnings, ...preTask.reasons],
      readiness: {
        ...activeProviderPreview.baseline.readiness,
        runnable: "blocked",
        blockingResourceIds: ["recovery-pre-task-head"],
      },
      ...(activeProviderPreview.baseline.recovery
        ? {
            recovery: {
              ...activeProviderPreview.baseline.recovery,
              status: "blocked",
              unresolved: [...activeProviderPreview.baseline.recovery.unresolved, ...preTask.reasons],
            },
          }
        : {}),
    },
  };
  return true;
}

async function ensureRecoveryReport(
  root: string,
  decision: RecoveryEnvelope,
): Promise<void> {
  const reportPath = join(root, "recovery.md");
  try {
    await access(reportPath);
    return;
  } catch {
    // The report path is Host-owned in the envelope. If the model completed a
    // valid decision but omitted the optional narrative artifact, preserve the
    // decision and materialize a minimal auditable report from it.
  }
  const unresolved = decision.unresolved.length
    ? `\n\nUnresolved:\n${decision.unresolved.map((item) => `- ${item}`).join("\n")}`
    : "";
  await writeFile(reportPath, `# Recovery report\n\n${decision.summary}${unresolved}\n`, "utf8");
}

async function persistRecoveryCompletionArtifacts(
  session: RecoveryRunSession,
  activeProviderPreview: NonNullable<RecoveryRunSession["activeProviderPreview"]>,
): Promise<void> {
  const { input, store, recovery } = session;
  const attemptsArtifact = Buffer.from(
    JSON.stringify({ schemaVersion: 1, state: lifecycleState(session), attempts: session.recoveryOrchestrator.attempts }),
    "utf8",
  );
  await store.commitArtifact({
    artifactId: "recovery-attempts",
    kind: "recovery_attempts",
    mediaType: "application/json",
    bytes: attemptsArtifact,
    operationId: "recovery-attempts-created",
  });
  if (activeProviderPreview.reportText) {
    await store.commitArtifact({
      artifactId: "recovery-md",
      kind: "recovery_report",
      mediaType: "text/markdown",
      bytes: Buffer.from(activeProviderPreview.reportText, "utf8"),
    });
  }
  const hasAccept = recoveryAcceptIsExposed({
    automaticallyAccepted: Boolean(session.automaticallyAcceptedBaseline),
    envelopeStatus: recovery?.status === "completed" ? recovery.value.status : undefined,
    match: activeProviderPreview.baseline.match,
    runnable: activeProviderPreview.baseline.readiness?.runnable,
  });
  await persistRecoveryAttemptDiagnosis(
    session.experimentRoot,
    recoveryAttemptDiagnosis({
      taskCase: input.taskCase,
      baseline: activeProviderPreview.baseline,
      transcriptOk: Boolean(input.taskCase.initialInput?.text),
      recoveryAgentStarted: true,
      retryable: false,
      reasonCode: diagnosisReasonCode({
        baseline: activeProviderPreview.baseline,
        transcriptOk: Boolean(input.taskCase.initialInput?.text),
        hasAccept,
        ...(activeProviderPreview.baseline.recovery?.failureStage
          ? { failureStage: activeProviderPreview.baseline.recovery.failureStage }
          : {}),
      }),
      hasAccept,
    }),
  );
}

function completeRecoveryAttempt(session: RecoveryRunSession): RecoveryAttempt {
  const input = session.input;
  const staging = session.staging;
  const recovery = session.recovery;
  const automaticallyAcceptedBaseline = session.automaticallyAcceptedBaseline;
  const activeProviderPreview = session.activeProviderPreview;
  if (!staging || !recovery || !activeProviderPreview) throw new Error("Recovery attempt was not prepared.");
  const exposeAccept = recoveryAcceptIsExposed({
    automaticallyAccepted: Boolean(automaticallyAcceptedBaseline),
    envelopeStatus: recovery.status === "completed" ? recovery.value.status : undefined,
    match: activeProviderPreview.baseline.match,
    runnable: activeProviderPreview.baseline.readiness?.runnable,
  });
  return {
    get baseline() {
      return automaticallyAcceptedBaseline ?? activeProviderPreview.baseline;
    },
    get providerPreview() {
      return activeProviderPreview;
    },
    staging,
    ...(session.readinessResult ? { taskReadiness: session.readinessResult } : {}),
    ...(automaticallyAcceptedBaseline ? { acceptedAutomatically: true } : {}),
    recovery,
    experimentRoot: session.experimentRoot,
    experimentId: input.experimentId,
    provider: session.provider,
    ...(exposeAccept
      ? {
          accept: async () => {
            if (automaticallyAcceptedBaseline) return automaticallyAcceptedBaseline;
            return session.provider.acceptRecovery(activeProviderPreview);
          },
        }
      : {}),
  };
}
