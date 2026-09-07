import { readFile } from "node:fs/promises";
import { Value } from "@sinclair/typebox/value";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RecoveryResult } from "../agents/recovery-agent.js";
import {
  RecoveryReviewSummarySchema,
  RecoveryControlledWriteSchema,
  type RecoveryReviewSummary,
  type TaskCase,
  type RecoveryInvestigation,
  type RecoveryManifest,
  type RecoveryControlledWrite,
} from "../core/schema.js";
import { sha256 } from "../core/identity.js";
import {
  RecoveryValidationError,
  type EnvironmentBaseline,
  type RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import {
  resolvedRecoveryFacts,
  RecoveryEvidenceValidationError,
  type RecoveryEvidenceVerification,
} from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import type { RecoveryReadinessResult } from "./recovery-readiness.js";

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
    recoveryCandidates: context.recoveryCandidates,
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
    investigationPacketDigest:
      context.investigationPacket !== undefined
        ? sha256(JSON.stringify(context.investigationPacket))
        : undefined,
  };
}

export function recoveryInvocationFailureStage(
  recovery: StructuredAgentResult<RecoveryResult>,
): NonNullable<NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]> {
  if (recovery.status === "cancelled") return "cancelled";
  if (recovery.status === "failed" && recovery.failure.code === "agent_timeout") return "agent_timeout";
  if (recovery.status === "failed" && recovery.failure.code === "invalid_output") return "agent_invalid_output";
  if (recovery.status === "failed" && recovery.failure.kind === "tool") return "agent_tool_failed";
  return "agent_model_failed";
}

export function retryableRecoveryFailure(
  result: StructuredAgentResult<RecoveryResult>,
): "agent_failure" | "agent_timeout" | undefined {
  if (result.status !== "failed") return undefined;
  if (result.failure.code === "agent_timeout") return result.failure.code;
  if (result.failure.code !== "agent_failure") return undefined;
  // Legacy injected ports omit kind and retain the historical bounded retry;
  // real Host failures are classified, so auth/protocol/tool/unknown errors do not loop.
  return result.failure.kind === undefined ||
    result.failure.kind === "rate_limited" ||
    result.failure.kind === "transient_network" ||
    result.failure.kind === "transient_upstream" ||
    result.failure.kind === "timeout"
    ? result.failure.code
    : undefined;
}

export function recoveryTimingSummary(
  attempts: readonly import("../core/schema.js").RecoveryLifecycleAttempt[],
): {
  forensicsMs?: number;
  modelRequestMs?: number;
  candidateMaterializationMs?: number;
} {
  const sum = (operation: import("../core/schema.js").RecoveryLifecycleAttempt["operation"]): number | undefined => {
    const values = attempts
      .filter((attempt) => attempt.operation === operation && attempt.result !== "started")
      .map((attempt) => attempt.durationMs);
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const forensicsMs = sum("resolve_facts");
  const modelRequestMs = sum("invoke_model");
  const candidateMaterializationMs = sum("create_candidate");
  return {
    ...(forensicsMs === undefined ? {} : { forensicsMs }),
    ...(modelRequestMs === undefined ? {} : { modelRequestMs }),
    ...(candidateMaterializationMs === undefined ? {} : { candidateMaterializationMs }),
  };
}

export function recoveryEvaluationCase(input: {
  caseId: string;
  staging?: RecoveryStaging | undefined;
  candidateCreated: boolean;
  recoveredPaths: string[];
  verification:
    "verified" | "pending_user_review" | "rejected" | "insufficient_evidence";
  forensicsCompleted: boolean;
  evidenceSourcesAttempted?: number | undefined;
  evidenceSourcesAvailable?: number | undefined;
  hypothesisCount?: number | undefined;
  candidateCount?: number | undefined;
  verifierRejectionReasons?: readonly string[] | undefined;
  providerFailureRetryable?: boolean | undefined;
  pathBoundaryRejected?: boolean | undefined;
  readiness?: RecoveryReadinessResult;
  taskOutcome?: NonNullable<EnvironmentBaseline["recovery"]>["taskOutcome"];
  modelCalls: number;
  startedAt: string;
  timings?: { forensicsMs?: number; modelRequestMs?: number; candidateMaterializationMs?: number; };
}): import("../core/schema.js").RecoveryEvaluationCase {
  const common = {
    schemaVersion: 1 as const,
    caseId: input.caseId,
    stagingSucceeded: Boolean(input.staging),
    forensicsStarted: Boolean(input.staging),
    forensicsCompleted: input.forensicsCompleted,
    ...(input.evidenceSourcesAttempted === undefined
      ? {}
      : { evidenceSourcesAttempted: input.evidenceSourcesAttempted }),
    ...(input.evidenceSourcesAvailable === undefined
      ? {}
      : { evidenceSourcesAvailable: input.evidenceSourcesAvailable }),
    ...(input.hypothesisCount === undefined
      ? {}
      : { hypothesisCount: input.hypothesisCount }),
    ...(input.candidateCount === undefined
      ? {}
      : { candidateCount: input.candidateCount }),
    ...(input.verifierRejectionReasons?.length
      ? { verifierRejectionReasons: [...input.verifierRejectionReasons] }
      : {}),
    ...(input.providerFailureRetryable === undefined
      ? {}
      : { providerFailureRetryable: input.providerFailureRetryable }),
    ...(input.pathBoundaryRejected === undefined
      ? {}
      : { pathBoundaryRejected: input.pathBoundaryRejected }),
    ...(input.readiness ? { readinessStatus: input.readiness.status, readinessCheckedPaths: input.readiness.checkedPaths, readinessMissingPaths: input.readiness.missingPaths } : {}),
    ...(input.taskOutcome ? { taskOutcome: input.taskOutcome } : {}),
    candidateCreated: input.candidateCreated,
    verification: input.verification,
    recoveredPaths: [...new Set(input.recoveredPaths)],
    modelCalls: input.modelCalls,
    durationMs: Math.max(0, Date.now() - Date.parse(input.startedAt)),
    ...(input.timings && Object.keys(input.timings).length ? { timings: input.timings } : {}),
  };
  const checkpointPaths =
    input.staging?.checkpointFingerprint?.resources
      .filter((resource) => resource.kind === "file")
      .map((resource) => resource.path) ?? [];
  if (checkpointPaths.length > 0)
    return { ...common, layer: "interrupted_checkpoint", checkpointPaths };
  return { ...common, layer: "history_completed" };
}

export function verdictToEvaluationStatus(
  candidateStatus: "verified" | "pending_user_review" | "rejected",
  envelopeStatus: RecoveryResult["status"],
): "verified" | "pending_user_review" | "rejected" | "insufficient_evidence" {
  if (candidateStatus === "rejected") return "rejected";
  if (candidateStatus === "verified" && envelopeStatus === "recovered")
    return "verified";
  return envelopeStatus === "insufficient_evidence"
    ? "insufficient_evidence"
    : "pending_user_review";
}

/** Restores a Provider-validated checkpoint without spending a model call or exposing checkpoint contents. */
export function hostCheckpointRecovery(staging: RecoveryStaging): {
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
    status: "recovered",
    reportPath: "recovery.md",
    unresolved: [],
    evidenceRefs: evidence.map((item) => item.ref),
    manifestPath: "recovery-manifest.json",
  };
  return {
    result,
    manifest,
    report: `# Recovery checkpoint restored\n\nThe Host restored ${changedPaths.length} candidate-visible path(s) from a Provider-validated checkpoint.\n`,
    evidence,
    changedPaths,
  };
}

/** Stores direct-write postimages as immutable artifacts; journal events only carry their content address. */
export async function persistRecoveryControlledWriteBlob(
  store: ExperimentStore,
  candidateRoot: string,
  entry: RecoveryControlledWrite,
  binding: { checkpointId?: string; baseDigest: string },
): Promise<RecoveryControlledWrite> {
  const origin = entry.tool === "rename_file"
    ? "agent_direct_move"
    : entry.tool === "delete_file"
      ? "agent_direct_delete"
      : "agent_direct_write";
  const attributedEntry = { ...entry, ...binding, origin } as RecoveryControlledWrite;
  if (entry.phase !== "after" || !entry.after) {
    if (!Value.Check(RecoveryControlledWriteSchema, attributedEntry))
      throw new Error("Recovery controlled-write attribution is invalid.");
    return attributedEntry;
  }
  const absolutePath = recoveryCandidatePath(candidateRoot, entry.path);
  const bytes = await readFile(absolutePath);
  if (
    bytes.byteLength !== entry.after.size ||
    sha256(bytes) !== entry.after.contentHash
  )
    throw new Error(
      `Recovery controlled-write postimage changed before artifact capture: ${entry.path}.`,
    );
  const artifactId = `recovery-blob-${entry.after.contentHash}`;
  const artifact = await store.commitArtifact({
    artifactId,
    kind: "recovery_controlled_write_blob",
    mediaType: "application/octet-stream",
    bytes,
    operationId: `recovery-blob-${entry.after.contentHash.slice(0, 16)}`,
  });
  if (
    artifact.contentHash !== entry.after.contentHash ||
    artifact.byteLength !== entry.after.size
  )
    throw new Error("Recovery controlled-write blob artifact integrity mismatch.");
  const persisted = {
    ...attributedEntry,
    after: { ...entry.after, artifactId },
  };
  if (!Value.Check(RecoveryControlledWriteSchema, persisted))
    throw new Error("Persisted Recovery controlled-write blob entry is invalid.");
  return persisted;
}

function recoveryCandidatePath(candidateRoot: string, relativePath: string): string {
  const absolutePath = resolve(candidateRoot, relativePath);
  const pathFromRoot = relative(candidateRoot, absolutePath);
  if (
    !pathFromRoot ||
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${String.fromCharCode(92)}`) ||
    pathFromRoot.startsWith("../") ||
    isAbsolute(pathFromRoot)
  )
    throw new Error("Recovery controlled-write artifact path escapes candidate root.");
  return absolutePath;
}
type RecoveryCandidatePathChange = {
  path: string;
  before?: { contentHash?: string } | undefined;
  after?: { contentHash?: string } | undefined;
};
type RecoveryCandidateDiff = {
  candidateId: string;
  hypothesisId: string;
  factRefs: string[];
  beforeDigest: string;
  afterDigest: string;
  /** All candidate changes, including Host delivery artifacts. */
  changedPaths: RecoveryCandidatePathChange[];
  /** Recovery-effect paths only. recovery.md and recovery-manifest.json never count as recovery. */
  taskPathOutcomes: import("../core/schema.js").RecoveryPathOutcome[];
};

export function recoveryReviewSummary(
  candidate: RecoveryInvestigation["candidates"][number],
  facts: RecoveryInvestigation["facts"],
  changedPaths: string[],
  pathOutcomes: RecoveryCandidateDiff["taskPathOutcomes"],
  status: RecoveryReviewSummary["verifierStatus"],
  reasonCodes: readonly string[],
): RecoveryReviewSummary {
  const relevant = facts.filter(
    (fact) =>
      candidate.factRefs.includes(`fact:${fact.factId}`) ||
      changedPaths.some((path) =>
        fact.pathScope.some(
          (scope) => scope === "." || scope === path || path.startsWith(`${scope}/`),
        ),
      ),
  );
  const strengths = new Set(relevant.map((fact) => fact.reliability));
  const evidenceStrength: RecoveryReviewSummary["evidenceStrength"] =
    strengths.size === 0
      ? "none"
      : strengths.size > 1 || strengths.has("contradicted")
        ? "mixed"
        : strengths.has("strong")
          ? "strong"
          : strengths.has("corroborated")
            ? "corroborated"
            : "weak";
  const summary: RecoveryReviewSummary = {
    schemaVersion: 1,
    candidateId: candidate.candidateId,
    hypothesisId: candidate.hypothesisId,
    changedPaths: [...new Set(changedPaths)],
    pathOutcomes,
    evidenceStrength,
    conflict: relevant.some((fact) => fact.reliability === "contradicted"),
    verifierStatus: status,
    reasonCodes: [...new Set(reasonCodes)],
    recommendedAction:
      status === "verified"
        ? "accept"
        : status === "rejected"
          ? "reject"
          : "review_candidate",
  };
  if (!Value.Check(RecoveryReviewSummarySchema, summary))
    throw new Error("Recovery review summary failed schema validation.");
  return summary;
}

/** Produces a bounded metadata diff without copying candidate file content into the event log. */
export function recoveryCandidateDiff(
  candidate: { candidateId: string; hypothesisId: string },
  factRefs: string[],
  before: EnvironmentBaseline["fingerprint"],
  after: EnvironmentBaseline["fingerprint"],
  writes: readonly RecoveryControlledWrite[] = [],
): RecoveryCandidateDiff {
  const initial = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  const changedPaths = [...new Set([...initial.keys(), ...current.keys()])]
    .filter(
      (path) =>
        !path.startsWith(".git/") &&
        JSON.stringify(initial.get(path)) !== JSON.stringify(current.get(path)),
    )
    .sort()
    .map((path) => ({
      path,
      ...(initial.has(path) ? { before: initial.get(path) } : {}),
      ...(current.has(path) ? { after: current.get(path) } : {}),
    }));
  const renamedTargets = new Set(
    writes
      .filter((entry) => entry.phase === "after" && entry.tool === "rename_file")
      .map((entry) => entry.path),
  );
  const taskPathOutcomes = changedPaths
    .filter((change) => !isRecoveryDeliveryArtifact(change.path))
    .map((change) => ({
      path: change.path,
      disposition: renamedTargets.has(change.path)
        ? "renamed" as const
        : !change.before ? "created" as const : !change.after ? "removed" as const : "modified" as const,
      ...(change.before?.contentHash ? { beforeHash: change.before.contentHash } : {}),
      ...(change.after?.contentHash ? { afterHash: change.after.contentHash } : {}),
      verification: "changed" as const,
    }));
  return {
    candidateId: candidate.candidateId,
    hypothesisId: candidate.hypothesisId,
    factRefs: [...factRefs],
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changedPaths,
    taskPathOutcomes,
  };
}

function isRecoveryDeliveryArtifact(path: string): boolean {
  return path === "recovery.md" || path === "recovery-manifest.json";
}

export function initialRecoveryInvestigation(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  observedAt: string,
): RecoveryInvestigation {
  const records = recoveryInvestigationFacts(facts, observedAt);
  const hypotheses = recoveryInvestigationHypotheses(facts, records);
  return {
    schemaVersion: 1,
    facts: records,
    plan: {
      planId: "evidence-ranked-forensics",
      factsUsed: records.map((fact) => `fact:${fact.factId}`),
      hypotheses,
      candidates: hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        operations: [],
      })),
      verificationPlan: [
        "compare candidate-visible diffs",
        "run the smallest task-relevant check",
      ],
    },
    candidates: [],
  };
}

const MAX_FACT_SOURCE_REFS = 8;

function representativeRefs(refs: readonly string[], fallback: string): string[] {
  const unique = [...new Set(refs.filter((item) => item.length > 0))];
  const sliced = unique.slice(0, MAX_FACT_SOURCE_REFS);
  return sliced.length > 0 ? sliced : [fallback];
}

function recoveryInvestigationFacts(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  observedAt: string,
): RecoveryInvestigation["facts"] {
  const sourceRefs = representativeRefs(facts.evidenceRefs, "artifact:recovery-investigation");
  const historicalPaths = recoveryHistoricalPaths(facts);
  const records: RecoveryInvestigation["facts"] = [
    {
      factId: "workspace-current",
      kind: "workspace",
      reliability: "weak",
      sourceRefs,
      observedAt,
      pathScope: ["."],
      summary:
        "The isolated current workspace was captured for recovery investigation.",
    },
  ];
  if (facts.catalog.length)
    records.push({
      factId: "historical-observations",
      kind: "session",
      reliability: "weak",
      sourceRefs: representativeRefs(facts.catalog.map((entry) => entry.ref), "artifact:recovery-investigation"),
      observedAt,
      pathScope: historicalPaths.length ? historicalPaths : ["."],
      summary: `${facts.catalog.length} frozen historical observation(s) are available for targeted investigation.`,
    });
  if (facts.git)
    records.push({
      factId: "git-state",
      kind: "git",
      reliability: facts.git.isRepo ? "corroborated" : "weak",
      sourceRefs,
      observedAt,
      pathScope: ["."],
      summary: facts.git.isRepo
        ? `Git repository observed with ${facts.git.headState} HEAD.`
        : "No Git repository was observed; workspace-only recovery remains possible.",
    });
  if (facts.patches.length)
    records.push({
      factId: "session-patches",
      kind: "patch",
      reliability: facts.patches.some((patch) => patch.verifiableBase)
        ? "corroborated"
        : "weak",
      sourceRefs,
      observedAt,
      pathScope: facts.patches.map((patch) => patch.targetPath),
      summary: `${facts.patches.length} session patch clue(s) were cataloged.`,
    });
  if (facts.preimages.length)
    records.push({
      factId: "preimages",
      kind: "artifact",
      reliability: "strong",
      sourceRefs,
      observedAt,
      pathScope: facts.preimages.map((preimage) => preimage.path),
      summary: `${facts.preimages.length} preimage artifact(s) were mechanically verified.`,
    });
  return records;
}

function recoveryInvestigationHypotheses(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
  records: RecoveryInvestigation["facts"],
): RecoveryInvestigation["plan"]["hypotheses"] {
  const historicalPaths = recoveryHistoricalPaths(facts);
  const known = new Set(records.map((fact) => fact.factId));
  const hypotheses: RecoveryInvestigation["plan"]["hypotheses"] = [];
  const add = (input: RecoveryInvestigation["plan"]["hypotheses"][number]) => {
    if (input.supportingFactRefs.every((ref) => known.has(ref.slice(5))))
      hypotheses.push(input);
  };
  add({ hypothesisId: "preimage-reconstruction", rationale: "Mechanically verified preimages can restore the narrowest known paths before weaker inference.", paths: facts.preimages.map((preimage) => preimage.path), supportingFactRefs: ["fact:preimages"], counterFactRefs: [], expectedChecks: ["restore only preimage paths", "verify restored hashes"], confidence: "high" });
  add({ hypothesisId: "patch-replay", rationale: "Patch clues with a verified base may describe an auditable historical delta.", paths: facts.patches.map((patch) => patch.targetPath), supportingFactRefs: ["fact:session-patches"], counterFactRefs: [], expectedChecks: ["compare patch base", "verify affected paths"], confidence: facts.patches.some((patch) => patch.verifiableBase) ? "medium" : "low" });
  if (facts.git?.isRepo && facts.git.headState === "present")
    add({ hypothesisId: "git-history", rationale: "Available Git history is a supplemental, independently inspectable recovery branch.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:git-state"], counterFactRefs: [], expectedChecks: ["inspect Git metadata", "compare candidate diff"], confidence: "medium" });
  add({ hypothesisId: "historical-observations", rationale: "Frozen transcript and historical observations may narrow paths and tests without becoming proof by themselves.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:historical-observations"], counterFactRefs: [], expectedChecks: ["derive footprint", "compare candidate-visible diff"], confidence: "low" });
  add({ hypothesisId: "current-workspace", rationale: "The isolated current workspace remains a low-cost fallback and must be compared rather than assumed.", paths: historicalPaths.length ? historicalPaths : ["."], supportingFactRefs: ["fact:workspace-current"], counterFactRefs: facts.git?.isRepo ? ["fact:git-state"] : [], expectedChecks: ["inspect candidate-visible diff", "check task-relevant tests"], confidence: "low" });
  if (!hypotheses.length)
    throw new Error("Recovery investigation has no Host-supported hypothesis.");
  return hypotheses;
}

function recoveryHistoricalPaths(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): string[] {
  return [...new Set([...facts.patches.map((patch) => patch.targetPath), ...facts.preimages.map((preimage) => preimage.path)])];
}

export function forensicsFact(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): Record<string, unknown> {
  return {
    git: facts.git
      ? {
          isRepo: facts.git.isRepo,
          headState: facts.git.headState,
          statusAvailable: facts.git.statusAvailable,
        }
      : { isRepo: false, headState: "unavailable", statusAvailable: false },
    transcriptEntries: facts.catalog.filter(
      (entry) => entry.source === "transcript",
    ).length,
    historicalEventEntries: facts.catalog.filter(
      (entry) => entry.source === "historical_events",
    ).length,
    preimageCount: facts.preimages.length,
    patchCount: facts.patches.length,
    verifiedEvidenceCount: facts.verifiedEvidence.length,
    evidenceQuality: recoveryEvidenceQuality(facts),
    operations: facts.operations,
  };
}

function recoveryEvidenceQuality(
  facts: Awaited<ReturnType<typeof resolvedRecoveryFacts>>,
): {
  sourceReachability: { available: number; attempted: number };
  taskRelevantEvidence: number;
  strongEvidence: number;
  operationBearingEvidence: number;
  conflictRate: number;
} {
  const attempted = 4;
  const available = [
    true,
    facts.git !== undefined,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events") || facts.verifiedEvidence.length > 0,
  ].filter(Boolean).length;
  const taskRelevant = [
    facts.preimages.length > 0,
    facts.patches.length > 0,
    facts.catalog.some((entry) => entry.source === "transcript"),
    facts.catalog.some((entry) => entry.source === "historical_events"),
  ].filter(Boolean).length;
  const strong = facts.verifiedEvidence.filter((evidence) => evidence.kind === "checkpoint" || evidence.kind === "preimage" || evidence.kind === "git_commit").length;
  return {
    sourceReachability: { available, attempted },
    taskRelevantEvidence: taskRelevant,
    strongEvidence: strong,
    operationBearingEvidence: facts.operations.filter((operation) => operation.availability === "available" && operation.operation !== "evidence_catalog").length,
    conflictRate: 0,
  };
}

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

type RecoveryPreflightDiagnostic = {
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

/** Preserves known verifier failures while keeping unknown provider errors as crashes. */
export async function persistRecoveryValidationArtifacts(store: ExperimentStore, staging: RecoveryStaging): Promise<void> {
  const files = ["recovery.md", "recovery-manifest.json"] as const;
  for (const file of files) {
    try {
      const bytes = await readFile(join(staging.root, file));
      await store.commitArtifact({
        artifactId: `recovery-validation-${file.replaceAll(".", "-")}`,
        kind: file === "recovery.md" ? "recovery_report" : "recovery_manifest",
        mediaType: file.endsWith(".md") ? "text/markdown" : "application/json",
        bytes,
        operationId: `recovery-validation-${file}-preserved`,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  await store.append({
    type: "recovery.validation_artifacts_preserved",
    runId: staging.caseId,
    operationId: "recovery-validation-artifacts-preserved",
    payload: { files: files.map((file) => file) },
  });
}

export function classifyRecoveryFailureStage(
  stage: NonNullable<
    NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]
  >,
  error: unknown,
  verifierRejectionReasons?: readonly string[],
  agentCompletedWithCandidate = false,
): NonNullable<NonNullable<EnvironmentBaseline["recovery"]>["failureStage"]> {
  if (recoveryModelRequestError(error)) return "agent_model_failed";
  if (
    stage === "provider_validation_failed" &&
    verifierRejectionReasons?.length
  )
    return "provider_validation_failed";
  if (
    error instanceof RecoveryValidationError &&
    error.code === "source_tripwire_failed"
  )
    return "source_tripwire_failed";
  if (stage === "provider_validation_failed" && agentCompletedWithCandidate)
    return "provider_validation_failed";
  if (
    stage === "provider_validation_failed" &&
    !(error instanceof RecoveryValidationError) &&
    !(error instanceof RecoveryEvidenceValidationError)
  )
    return "runner_crashed";
  return stage;
}

function recoveryModelRequestError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /\b(context_length_exceeded|maximum context length|prompt is too long|context window)\b/i.test(text);
}

export function recoveryFailedFromThrown(
  error: unknown,
  sessionId: string,
): StructuredAgentResult<RecoveryResult> {
  return {
    status: "failed",
    sessionId,
    failure: {
      code: "agent_failure",
      kind: recoveryModelRequestError(error) ? "protocol" : "unknown",
      message: error instanceof Error ? error.message : String(error),
      attempts: 1,
    },
  };
}

export function safeRecoveryFailureSummary(
  error: unknown,
  stage: NonNullable<EnvironmentBaseline["recovery"]>["failureStage"],
): string {
  if (stage === "source_tripwire_failed")
    return "Recovery source tripwire detected a source change.";
  if (stage === "agent_model_failed") return "Recovery model request failed.";
  if (stage === "agent_timeout") return "Recovery agent timed out.";
  if (stage === "agent_invalid_output")
    return "Recovery agent returned an invalid completion envelope.";
  if (stage === "provider_validation_failed")
    return "Provider validation rejected the recovery result.";
  if (stage === "preflight_failed") return "Recovery preflight failed.";
  if (stage === "cancelled") return "Recovery agent was cancelled.";
  if (stage === "runner_crashed") return "Recovery runner crashed.";
  return error instanceof Error && error.name === "AbortError"
    ? "Recovery agent was cancelled."
    : "Recovery agent or tool execution failed.";
}

export function recoveryClues(taskCase: TaskCase): {
  cwd?: string;
  historicalCommit?: string;
  sourceVersion?: string;
} {
  const context = taskCase.taskContext ?? {};
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.length ? value : undefined;
  const cwd = string(context.cwd);
  const historicalCommit = string(context.historicalCommit);
  const sourceVersion = string(context.sourceVersion);
  return {
    ...(cwd ? { cwd } : {}),
    ...(historicalCommit ? { historicalCommit } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}
