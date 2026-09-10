import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { persistRecoveryEvaluation, recoveryEvaluationCase, recoveryTimingSummary } from "./evaluation.js";
import { validateRecoveryEvidence, type RecoveryEvidenceVerification } from "../../infrastructure/recovery-tools.js";
import { writeImmutableJson } from "../../infrastructure/store/experiment-store.js";
import type { RecoveryManifest } from "../../core/schema.js";
import type { RecoveryAttempt } from "./types.js";
import type { RecoveryAttemptInput } from "./input.js";
import type { RecoveryResult } from "../../agents/recovery-agent.js";
import type { StructuredAgentResult } from "../../infrastructure/agent/host.js";
import type { ExperimentStore } from "../../infrastructure/store/experiment-store.js";
import type { LocalWorkspaceProvider, RecoveryStaging } from "../../environment/local-workspace-provider.js";
import type { RecoveryOrchestrator } from "./orchestrator.js";
import type { RecoveryReadinessResult } from "./readiness.js";

export type HostCheckpointRecoveryArgs = {
  input: RecoveryAttemptInput;
  staging: RecoveryStaging;
  experimentRoot: string;
  store: ExperimentStore;
  provider: LocalWorkspaceProvider;
  activeStaging: RecoveryStaging;
  recoveryOrchestrator: RecoveryOrchestrator;
  readinessResult: RecoveryReadinessResult | undefined;
  forensicsCompleted: boolean;
  evidenceSourcesAttempted: number | undefined;
  evidenceSourcesAvailable: number | undefined;
  hypothesisCount: number | undefined;
  candidateCount: number | undefined;
  verifierRejectionReasons: string[] | undefined;
  providerFailureRetryable: boolean | undefined;
  pathBoundaryRejected: boolean | undefined;
};

async function persistHostCheckpointRecoveryOutputs(input: {
  staging: RecoveryStaging;
  experimentRoot: string;
  checkpoint: ReturnType<typeof hostCheckpointRecovery>;
}): Promise<StructuredAgentResult<RecoveryResult>> {
  const recovery: StructuredAgentResult<RecoveryResult> = {
    status: "completed",
    sessionId: `host-${input.staging.checkpointId}`,
    value: input.checkpoint.result,
  };
  await writeFile(join(input.staging.root, "recovery.md"), input.checkpoint.report, "utf8");
  await writeFile(
    join(input.staging.root, "recovery-manifest.json"),
    JSON.stringify(input.checkpoint.manifest),
    "utf8",
  );
  await writeImmutableJson(join(input.experimentRoot, "recovery.json"), recovery);
  return recovery;
}

export async function completeHostCheckpointRecovery(
  args: HostCheckpointRecoveryArgs,
): Promise<RecoveryAttempt | undefined> {
  const input = args.input;
  const staging = args.staging;
  const experimentRoot = args.experimentRoot;
  const store = args.store;
  const provider = args.provider;
  const activeStaging = args.activeStaging;
  const recoveryOrchestrator = args.recoveryOrchestrator;
  const readinessResult = args.readinessResult;
  const forensicsCompleted = args.forensicsCompleted;
  const evidenceSourcesAttempted = args.evidenceSourcesAttempted;
  const evidenceSourcesAvailable = args.evidenceSourcesAvailable;
  const hypothesisCount = args.hypothesisCount;
  const candidateCount = args.candidateCount;
  const verifierRejectionReasons = args.verifierRejectionReasons;
  const providerFailureRetryable = args.providerFailureRetryable;
  const pathBoundaryRejected = args.pathBoundaryRejected;

if (staging.checkpointFingerprint && staging.checkpointId) {
  const checkpoint = hostCheckpointRecovery(staging);
  const recovery = await persistHostCheckpointRecoveryOutputs({
    staging,
    experimentRoot,
    checkpoint,
  });
  await store.append({
    type: "recovery.checkpoint_restored",
    runId: input.runId,
    operationId: "recovery-checkpoint-restored",
    payload: {
      checkpointId: staging.checkpointId,
      checkpointDigest: staging.checkpointFingerprint.digest,
      changedPathCount: checkpoint.changedPaths.length,
    },
  });
  await store.append({
    type: "recovery.completed",
    runId: input.runId,
    operationId: "recovery-completed",
    payload: { status: "completed", source: "host_checkpoint" },
  });
  validateRecoveryEvidence(
    checkpoint.evidence.map((item) => item.ref),
    checkpoint.result,
  );
  const providerPreview = await provider.validateRecovery(
    activeStaging,
    checkpoint.result,
  );
  const recoveredPaths = [...providerPreview.changedPaths];
  const verification = "verified" as const;
  if (providerPreview.reportText) {
    await store.commitArtifact({
      artifactId: "recovery-md",
      kind: "recovery_report",
      mediaType: "text/markdown",
      bytes: Buffer.from(providerPreview.reportText, "utf8"),
    });
  }
  await persistRecoveryEvaluation(store, [
    recoveryEvaluationCase({
      caseId: input.caseId,
      staging,
      candidateCreated: false,
      recoveredPaths,
      forensicsCompleted,
      evidenceSourcesAttempted,
      evidenceSourcesAvailable,
      hypothesisCount,
      candidateCount,
      verifierRejectionReasons,
      providerFailureRetryable,
      pathBoundaryRejected,
      verification,
      modelCalls: 0,
      startedAt: input.now,
      timings: recoveryTimingSummary(recoveryOrchestrator.attempts),
    }),
  ],
  undefined,
  store.events(input.runId),
);
  return {
    baseline: providerPreview.baseline,
    providerPreview,
    staging,
    ...(readinessResult ? { taskReadiness: readinessResult } : {}),
    recovery,
    experimentRoot,
    experimentId: input.experimentId,
    provider,
    accept: () => provider.acceptRecovery(providerPreview),
  };
}
  return undefined;
}

/** Restores a Provider-validated checkpoint without spending a model call or exposing checkpoint contents. */
function hostCheckpointRecovery(staging: RecoveryStaging): {
  result: RecoveryResult;
  manifest: RecoveryManifest;
  report: string;
  evidence: RecoveryEvidenceVerification[];
  changedPaths: string[];
} {
  const checkpoint = staging.checkpointFingerprint;
  if (!checkpoint || !staging.checkpointId)
    throw new Error(
      "Trusted checkpoint recovery requires checkpoint metadata.",
    );
  const before = new Map(
    staging.sourceFingerprint.resources.map((entry) => [entry.path, entry]),
  );
  const after = new Map(
    checkpoint.resources.map((entry) => [entry.path, entry]),
  );
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !path.startsWith(".git/") && path !== ".git")
    .filter(
      (path) =>
        JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)),
    )
    .sort();
  const refPrefix = `artifact:checkpoint-${staging.checkpointId.slice("checkpoint-".length, 96)}`;
  const evidence = changedPaths.map((path, index) => {
    const entry = after.get(path);
    return {
      ref: `${refPrefix}-${index}`,
      kind: "checkpoint" as const,
      path,
      ...(entry
        ? {
            entryKind: entry.kind,
            ...(entry.contentHash ? { hash: entry.contentHash } : {}),
          }
        : {}),
    };
  });
  // A no-op restore is still provenance-backed even though it has no manifest action.
  if (!evidence.length)
    evidence.push({ ref: `${refPrefix}-0`, kind: "checkpoint", path: "." });
  const evidenceByPath = new Map(evidence.map((item) => [item.path, item.ref]));
  const manifest: RecoveryManifest = {
    actions: changedPaths.map((path) => {
      const previous = before.get(path);
      const current = after.get(path);
      return {
        operation: !previous ? "create" : !current ? "delete" : "restore",
        path,
        ...(previous?.contentHash ? { beforeHash: previous.contentHash } : {}),
        ...(current?.contentHash ? { afterHash: current.contentHash } : {}),
        evidenceRefs: [evidenceByPath.get(path)!],
      };
    }),
    unresolved: [],
  };
  const result: RecoveryResult = {
    status: "ready",
    reportPath: "recovery.md",
    unresolved: [],
  };
  return {
    result,
    manifest,
    report: `# Recovery checkpoint restored\n\nThe Host restored ${changedPaths.length} candidate-visible path(s) from a Provider-validated checkpoint.\n`,
    evidence,
    changedPaths,
  };
}
