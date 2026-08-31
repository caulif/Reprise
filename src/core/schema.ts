import { Type, type Static } from "@sinclair/typebox";

const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" });
const JsonRecord = Type.Record(Type.String(), Type.Unknown());
export const EvidenceRefSchema = Type.String({
  pattern: "^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});
const RecoveryReadinessSchema = Type.Union([
  Type.Literal("verified"),
  Type.Literal("best-effort"),
  Type.Literal("pending"),
  Type.Literal("history-only"),
  Type.Literal("no-user-input"),
  Type.Literal("corrupt"),
]);
export type RecoveryReadiness = Static<typeof RecoveryReadinessSchema>;
const RecoveryDiagnosticSchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 4096 }),
  physicalLine: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type RecoveryDiagnostic = Static<typeof RecoveryDiagnosticSchema>;
export const SessionRecoveryAttemptSchema = Type.Object({
  attempted: Type.Literal(true),
  status: Type.Union([
    Type.Literal("recovered"),
    Type.Literal("partial"),
    Type.Literal("not-replayable"),
    Type.Literal("retryable"),
  ]),
  sourcePath: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  parsedMessageCount: Type.Integer({ minimum: 0 }),
  skippedEventCount: Type.Integer({ minimum: 0 }),
  diagnostics: Type.Array(RecoveryDiagnosticSchema),
  rawSnapshotPath: Type.Optional(Type.String({ minLength: 1 })),
});
export type SessionRecoveryAttemptRecord = Static<typeof SessionRecoveryAttemptSchema>;
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
export const ControllerRequestedPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  toolSetVersion: Type.Literal(1),
  requestId: Id,
  runId: Id,
  inputDigest: Hash,
  snapshot: Type.Record(Type.String(), Type.Unknown()),
});
export type ControllerRequestedPayload = Static<typeof ControllerRequestedPayloadSchema>;
export const ControllerObservationReadPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  runId: Id,
  source: Type.String({ minLength: 1, maxLength: 64 }),
  evidenceRefs: Type.Array(EvidenceRefSchema),
});
export type ControllerObservationReadPayload = Static<typeof ControllerObservationReadPayloadSchema>;
/** Public, redacted input set frozen before a Recovery evaluation starts. */
const RecoverySelectionSourceStateSchema = Type.Object({
  readiness: Type.Union([
    Type.Literal("isolated"),
    Type.Literal("unavailable"),
  ]),
  fingerprint: Hash,
  fileCount: Type.Integer({ minimum: 0 }),
  warningCount: Type.Integer({ minimum: 0 }),
});
const RecoverySelectionEntrySchema = Type.Object({
  alias: Id,
  productId: Id,
  evidenceLayer: Type.Union([
    Type.Literal("history"),
    Type.Literal("transcript"),
  ]),
  sessionContentHash: Hash,
  sourceState: RecoverySelectionSourceStateSchema,
  signalCounts: Type.Object({
    userMessages: Type.Integer({ minimum: 0 }),
    assistantMessages: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
    completedTurns: Type.Integer({ minimum: 0 }),
  }),
});
export const RecoverySelectionManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  runId: Id,
  seed: Type.String({ minLength: 1, maxLength: 128 }),
  selectedAt: Timestamp,
  entries: Type.Array(RecoverySelectionEntrySchema, {
    minItems: 1,
    uniqueItems: true,
  }),
});
export type RecoverySelectionManifest = Static<
  typeof RecoverySelectionManifestSchema
>;
/** Redacted aggregate diagnostics for selection failures; never contains source bindings. */
const RecoverySelectionSourceEligibilitySchema = Type.Object(
  {
    inspected: Type.Integer({ minimum: 0 }),
    isolated: Type.Integer({ minimum: 0 }),
    notIsolated: Type.Integer({ minimum: 0 }),
    inspectionFailed: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const RecoverySelectionDiagnosticsProductSchema = Type.Object(
  {
    productId: Id,
    discoveredCount: Type.Integer({ minimum: 0 }),
    eligibleMetadataCount: Type.Integer({ minimum: 0 }),
    selectedCount: Type.Integer({ minimum: 0 }),
    sourceEligibility: RecoverySelectionSourceEligibilitySchema,
  },
  { additionalProperties: false },
);
/** Persistent redacted explanation of why a real evaluation could not select enough isolated sources. */
export const RecoverySelectionDiagnosticsSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    products: Type.Array(RecoverySelectionDiagnosticsProductSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
export type RecoverySelectionDiagnostics = Static<
  typeof RecoverySelectionDiagnosticsSchema
>;

const RecoveryManifestSchema = Type.Object({
  actions: Type.Array(
    Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("modify"),
        Type.Literal("delete"),
        Type.Literal("restore"),
      ]),
      path: Type.String({ minLength: 1 }),
      beforeHash: Type.Optional(Hash),
      afterHash: Type.Optional(Hash),
      evidenceRefs: Type.Array(EvidenceRefSchema),
    }),
  ),
  unresolved: Type.Array(Type.String()),
});
export type RecoveryManifest = Static<typeof RecoveryManifestSchema>;
const RecoveryCheckpointFingerprintEntrySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
  size: Type.Integer({ minimum: 0 }),
  contentHash: Type.Optional(Hash),
});
const RecoveryCheckpointFingerprintSchema = Type.Object({
  capturedAt: Timestamp,
  resources: Type.Array(RecoveryCheckpointFingerprintEntrySchema),
  digest: Hash,
});
const WorkspaceExclusionSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  reasonCode: Type.Union([
    Type.Literal("workspace.symlink_skipped"),
    Type.Literal("workspace.permission_denied"),
    Type.Literal("workspace.target_missing"),
    Type.Literal("workspace.cycle_skipped"),
    Type.Literal("workspace.unsupported_entry"),
    Type.Literal("workspace.budget_skipped"),
  ]),
});
const RecoveryCheckpointBudgetSchema = Type.Object({
  fileCount: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Integer({ minimum: 0 }),
  largestFileBytes: Type.Integer({ minimum: 0 }),
  blockedReasons: Type.Readonly(Type.Array(Type.String())),
  excludedEntries: Type.Optional(Type.Readonly(Type.Array(WorkspaceExclusionSchema))),
});
export const RecoveryAttemptDiagnosisSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sessionId: Type.String({ minLength: 1, maxLength: 256 }),
  sourcePath: Type.String({ minLength: 1, maxLength: 4096 }),
  transcriptStatus: Type.Union([
    Type.Literal("ok"),
    Type.Literal("partial"),
    Type.Literal("invalid"),
    Type.Literal("missing"),
  ]),
  workspaceStatus: Type.Union([
    Type.Literal("complete"),
    Type.Literal("partial"),
    Type.Literal("unavailable"),
  ]),
  excludedEntries: Type.Array(WorkspaceExclusionSchema),
  recoveryAgentStarted: Type.Boolean(),
  finalStatus: Type.Union([
    Type.Literal("recovered"),
    Type.Literal("partial"),
    Type.Literal("failed"),
  ]),
  retryable: Type.Boolean(),
  reasonCode: Type.String({ minLength: 1, maxLength: 128 }),
});
export type RecoveryAttemptDiagnosis = Static<
  typeof RecoveryAttemptDiagnosisSchema
>;
/** Persistent Provider-owned metadata; the checkpoint tree itself remains content-only. */
export const RecoveryCheckpointRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  checkpointId: Id,
  caseId: Id,
  fingerprint: RecoveryCheckpointFingerprintSchema,
  budget: RecoveryCheckpointBudgetSchema,
});
export type RecoveryCheckpointRecord = Static<
  typeof RecoveryCheckpointRecordSchema
>;

const RecoveryDeltaFileSchema = Type.Object({
  kind: Type.Literal("file"),
  contentHash: Hash,
  size: Type.Integer({ minimum: 0 }),
  /** Immutable Host-owned artifact containing these exact bytes, when persisted by orchestration. */
  artifactId: Type.Optional(Id),
});
/** An append-only record for a Host-controlled Recovery sink write; external shells remain explicitly unobserved. */
export const RecoveryControlledWriteSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  tool: Type.Union([
    Type.Literal("write"),
    Type.Literal("edit"),
    Type.Literal("write_file"),
    Type.Literal("write_recovery_manifest"),
    Type.Literal("write_recovery_report"),
    Type.Literal("delete_file"),
    Type.Literal("rename_file"),
    Type.Literal("write_binary_file"),
  ]),
  phase: Type.Union([
    Type.Literal("before"),
    Type.Literal("after"),
    Type.Literal("failed"),
  ]),
  path: Type.String({ minLength: 1, maxLength: 512 }),
  sourcePath: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  origin: Type.Optional(Type.Union([
    Type.Literal("agent_direct_write"),
    Type.Literal("agent_direct_move"),
    Type.Literal("agent_direct_delete"),
  ])),
  /** Provider baseline that owns this delta; absent for legacy/non-checkpoint runs. */
  checkpointId: Type.Optional(Id),
  baseDigest: Type.Optional(Hash),
  before: Type.Optional(RecoveryDeltaFileSchema),
  after: Type.Optional(RecoveryDeltaFileSchema),
});
export type RecoveryControlledWrite = Static<
  typeof RecoveryControlledWriteSchema
>;

/** A Host-owned, reviewable observation collected during maximum-effort Recovery. */
const RecoveryFactSchema = Type.Object({
  factId: Id,
  kind: Type.Union([
    Type.Literal("workspace"),
    Type.Literal("git"),
    Type.Literal("session"),
    Type.Literal("artifact"),
    Type.Literal("patch"),
    Type.Literal("test"),
  ]),
  reliability: Type.Union([
    Type.Literal("strong"),
    Type.Literal("corroborated"),
    Type.Literal("weak"),
    Type.Literal("contradicted"),
  ]),
  sourceRefs: Type.Array(EvidenceRefSchema, { minItems: 1 }),
  observedAt: Timestamp,
  pathScope: Type.Array(Type.String({ minLength: 1 })),
  contentHash: Type.Optional(Hash),
  summary: Type.String({ minLength: 1 }),
});
export type RecoveryFact = Static<typeof RecoveryFactSchema>;

/** A single Host-audited operation in the Recovery lifecycle. */
export const RecoveryLifecycleAttemptSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Id,
  phase: Type.Union([
    Type.Literal("staging"),
    Type.Literal("forensics"),
    Type.Literal("hypothesis"),
    Type.Literal("candidate"),
    Type.Literal("verification"),
    Type.Literal("promotion"),
  ]),
  operation: Type.Union([
    Type.Literal("begin_staging"),
    Type.Literal("resolve_facts"),
    Type.Literal("create_candidate"),
    Type.Literal("invoke_model"),
    Type.Literal("validate_candidate"),
    Type.Literal("promote_checkpoint"),
  ]),
  candidateId: Type.Optional(Id),
  attemptNumber: Type.Integer({ minimum: 1 }),
  result: Type.Union([
    Type.Literal("started"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
    Type.Literal("skipped"),
  ]),
  failureCode: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  durationMs: Type.Integer({ minimum: 0 }),
  recordedAt: Timestamp,
});
export type RecoveryLifecycleAttempt = Static<typeof RecoveryLifecycleAttemptSchema>;

const RecoveryFactRefSchema = Type.String({
  pattern: "^fact:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});
const RecoveryHypothesisSchema = Type.Object({
  hypothesisId: Id,
  rationale: Type.String({ minLength: 1 }),
  paths: Type.Array(Type.String({ minLength: 1 })),
  supportingFactRefs: Type.Array(RecoveryFactRefSchema),
  counterFactRefs: Type.Array(RecoveryFactRefSchema),
  expectedChecks: Type.Array(Type.String({ minLength: 1 })),
  confidence: Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
});
const RecoveryPlanOperationSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("create"),
    Type.Literal("modify"),
    Type.Literal("delete"),
    Type.Literal("restore"),
  ]),
  path: Type.String({ minLength: 1 }),
  rationale: Type.String({ minLength: 1 }),
});
const RecoveryPlanCandidateSchema = Type.Object({
  hypothesisId: Id,
  operations: Type.Array(RecoveryPlanOperationSchema),
});
const RecoveryPlanSchema = Type.Object({
  planId: Id,
  factsUsed: Type.Array(RecoveryFactRefSchema),
  hypotheses: Type.Array(RecoveryHypothesisSchema, { minItems: 1 }),
  candidates: Type.Array(RecoveryPlanCandidateSchema, { minItems: 1 }),
  verificationPlan: Type.Array(Type.String({ minLength: 1 })),
});
export type RecoveryPlan = Static<typeof RecoveryPlanSchema>;

const RecoveryCandidateSchema = Type.Object({
  candidateId: Id,
  hypothesisId: Id,
  status: Type.Union([
    Type.Literal("created"),
    Type.Literal("selected"),
    Type.Literal("discarded"),
    Type.Literal("pending_user_review"),
    Type.Literal("verified"),
    Type.Literal("rejected"),
  ]),
  factRefs: Type.Array(RecoveryFactRefSchema),
  beforeDigest: Hash,
  afterDigest: Type.Optional(Hash),
  diffArtifactId: Type.Optional(Id),
  reviewArtifactId: Type.Optional(Id),
  createdAt: Timestamp,
});
export type RecoveryCandidate = Static<typeof RecoveryCandidateSchema>;
export const RecoveryCandidateGraphSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  investigation: Type.Object({
    schemaVersion: Type.Integer({ minimum: 1 }),
    facts: Type.Array(RecoveryFactSchema),
    plan: RecoveryPlanSchema,
    candidates: Type.Array(RecoveryCandidateSchema),
  }),
  reviews: Type.Array(Type.Object({
    candidateId: Id,
    artifactId: Id,
  })),
});
export type RecoveryCandidateGraph = Static<typeof RecoveryCandidateGraphSchema>;

export const RecoveryInvestigationSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  facts: Type.Array(RecoveryFactSchema),
  plan: RecoveryPlanSchema,
  candidates: Type.Array(RecoveryCandidateSchema),
});
export type RecoveryInvestigation = Static<typeof RecoveryInvestigationSchema>;

const RecoveryPathOutcomeSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 512 }),
  disposition: Type.Union([
    Type.Literal("created"),
    Type.Literal("modified"),
    Type.Literal("removed"),
    Type.Literal("renamed"),
    Type.Literal("retained"),
  ]),
  beforeHash: Type.Optional(Hash),
  afterHash: Type.Optional(Hash),
  verification: Type.Union([
    Type.Literal("changed"),
    Type.Literal("unchanged"),
    Type.Literal("not_observed"),
  ]),
  failureReason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type RecoveryPathOutcome = Static<typeof RecoveryPathOutcomeSchema>;

export const RecoveryReviewSummarySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  candidateId: Id,
  hypothesisId: Id,
  /** Candidate-visible task paths only; recovery report artifacts are intentionally excluded. */
  changedPaths: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  pathOutcomes: Type.Optional(Type.Array(RecoveryPathOutcomeSchema, { maxItems: 512 })),
  evidenceStrength: Type.Union([
    Type.Literal("strong"),
    Type.Literal("corroborated"),
    Type.Literal("weak"),
    Type.Literal("mixed"),
    Type.Literal("none"),
  ]),
  conflict: Type.Boolean(),
  verifierStatus: Type.Union([
    Type.Literal("verified"),
    Type.Literal("pending_user_review"),
    Type.Literal("rejected"),
  ]),
  reasonCodes: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
  recommendedAction: Type.Union([
    Type.Literal("accept"),
    Type.Literal("review_candidate"),
    Type.Literal("reject"),
  ]),
});
export type RecoveryReviewSummary = Static<typeof RecoveryReviewSummarySchema>;
export const RecoveryReviewFeedbackSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  candidateId: Id,
  decision: Type.Union([Type.Literal("accept"), Type.Literal("reject"), Type.Literal("needs_more_evidence")]),
  evidenceRefs: Type.Array(RecoveryFactRefSchema, { uniqueItems: true }),
  stagingDigest: Hash,
  checkpointId: Type.Optional(Id),
  recordedAt: Timestamp,
});
export type RecoveryReviewFeedback = Static<typeof RecoveryReviewFeedbackSchema>;


export const RecoveryExternalEffectSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  effectId: Id,
  kind: Type.Union([
    Type.Literal("command"),
    Type.Literal("ide"),
    Type.Literal("browser"),
    Type.Literal("database"),
    Type.Literal("remote_api"),
    Type.Literal("unknown"),
  ]),
  observability: Type.Union([Type.Literal("observed"), Type.Literal("unobserved")]),
  summary: Type.String({ minLength: 1, maxLength: 512 }),
  evidenceRefs: Type.Array(RecoveryFactRefSchema, { uniqueItems: true }),
  recordedAt: Timestamp,
});
export type RecoveryExternalEffect = Static<typeof RecoveryExternalEffectSchema>;

export const RecoveryCompensationRequestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  effectId: Id,
  action: Type.String({ minLength: 1, maxLength: 512 }),
  evidenceRefs: Type.Array(RecoveryFactRefSchema, { uniqueItems: true }),
  requestedAt: Timestamp,
});
export type RecoveryCompensationRequest = Static<typeof RecoveryCompensationRequestSchema>;

export const RecoveryCompensationResultSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  effectId: Id,
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("not_supported"),
    Type.Literal("requires_review"),
  ]),
  summary: Type.String({ minLength: 1, maxLength: 512 }),
  evidenceRefs: Type.Array(RecoveryFactRefSchema, { uniqueItems: true }),
  completedAt: Timestamp,
});
export type RecoveryCompensationResult = Static<typeof RecoveryCompensationResultSchema>;

const CaseArtifactRefSchema = Type.Object({ artifactId: Id, caseId: Id });
export type CaseArtifactRef = Static<typeof CaseArtifactRefSchema>;
export const ArtifactRefSchema = Type.Union([
  CaseArtifactRefSchema,
  Type.Object({ artifactId: Id, experimentId: Id, runId: Type.Optional(Id) }),
]);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

const SessionRefSchema = Type.Object({
  productId: Id,
  sessionId: Id,
  sourcePath: Type.Optional(Type.String({ minLength: 1 })),
});
const MessageSchema = Type.Object({
  id: Id,
  role: Type.Union([
    Type.Literal("user"),
    Type.Literal("assistant"),
    Type.Literal("tool"),
  ]),
  text: Type.String(),
});
const BaselineEvidenceSchema = Type.Object({
  status: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
  finalMessage: Type.Optional(Type.String()),
  artifactRefs: Type.Array(CaseArtifactRefSchema),
  evidenceRefs: Type.Array(EvidenceRefSchema),
});
export const TaskCaseSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  caseId: Id,
  source: SessionRefSchema,
  /** Omitted only by cases frozen before history-assisted intake. */
  evidenceLevel: Type.Optional(
    Type.Union([Type.Literal("transcript"), Type.Literal("history")]),
  ),
  initialInput: MessageSchema,
  transcript: Type.Array(MessageSchema),
  historicalEvents: Type.Array(JsonRecord),
  baseline: BaselineEvidenceSchema,
  sourceRuntimeEvidence: Type.Object({
    productId: Id,
    version: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    artifactRefs: Type.Array(ArtifactRefSchema),
  }),
  taskContext: Type.Optional(JsonRecord),
  provenance: Type.Object({
    packVersion: Type.String({ minLength: 1 }),
    importedAt: Timestamp,
    sourceHash: Hash,
  }),
  privacy: Type.Object({
    allowModelText: Type.Boolean(),
    allowBinary: Type.Boolean(),
    redactions: Type.Array(Type.String()),
  }),
  contentHash: Hash,
});
export type TaskCase = Static<typeof TaskCaseSchema>;

export const CandidateSpecSchema = Type.Object({
  candidateId: Id,
  productId: Id,
  requestedModel: Type.String({ minLength: 1 }),
});
export type CandidateSpec = Static<typeof CandidateSpecSchema>;

const AgentBudgetSchema = Type.Object({
  callTimeoutMs: Type.Integer({ minimum: 1 }),
  maxStructuredRepairAttempts: Type.Integer({ minimum: 0 }),
});
const AgentConfigSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  requestedModel: Type.String({ minLength: 1 }),
  options: Type.Optional(JsonRecord),
  budget: AgentBudgetSchema,
  contextPolicy: Type.Optional(JsonRecord),
});
const RunPolicySchema = Type.Object({
  wallClockMs: Type.Integer({ minimum: 1 }),
  maxTargetTurns: Type.Integer({ minimum: 1 }),
  maxModelCalls: Type.Integer({ minimum: 1 }),
  turnTimeoutMs: Type.Integer({ minimum: 1 }),
  maxConsecutiveNoProgress: Type.Integer({ minimum: 1 }),
});
export const ExperimentSpecSchema = Type.Object({
  experimentId: Id,
  taskCaseId: Id,
  candidates: Type.Array(CandidateSpecSchema, { minItems: 1 }),
  controller: AgentConfigSchema,
  comparison: AgentConfigSchema,
  runPolicy: RunPolicySchema,
  outputRoot: Type.String({ minLength: 1 }),
});
export type ExperimentSpec = Static<typeof ExperimentSpecSchema>;
export type AgentBudget = Static<typeof AgentBudgetSchema>;
export type AgentConfig = Static<typeof AgentConfigSchema>;
export type RunPolicy = Static<typeof RunPolicySchema>;

export const RunAttemptSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  runId: Id,
  experimentId: Id,
  caseId: Id,
  candidate: CandidateSpecSchema,
  policy: RunPolicySchema,
  createdAt: Timestamp,
});
export type RunAttempt = Static<typeof RunAttemptSchema>;

const ResolvedAgentConfigSchema = Type.Object({
  providerId: Type.String({ minLength: 1 }),
  requestedModel: Type.String({ minLength: 1 }),
  budget: AgentBudgetSchema,
});
export const RunManifestSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  attempt: RunAttemptSchema,
  resolvedModel: Type.Object({
    requested: Type.String({ minLength: 1 }),
    resolved: Type.Union([
      Type.String({ minLength: 1 }),
      Type.Literal("unknown"),
    ]),
  }),
  runtime: Type.Object({
    productId: Id,
    executable: Type.String({ minLength: 1 }),
    version: Type.Optional(Type.String()),
    configHash: Type.Optional(Hash),
  }),
  environment: Type.Object({
    environmentId: Id,
    workspacePath: Type.String({ minLength: 1 }),
  }),
  controller: ResolvedAgentConfigSchema,
  comparison: ResolvedAgentConfigSchema,
  startedAt: Timestamp,
});
export type RunManifest = Static<typeof RunManifestSchema>;

const RunOutcomeSchema = Type.Object({
  task: Type.Object({
    status: Type.Union([
      Type.Literal("apparently_completed"),
      Type.Literal("incomplete"),
      Type.Literal("indeterminate"),
      Type.Literal("not_assessed"),
    ]),
    decidedBy: Type.Optional(Type.Literal("controller")),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
  termination: Type.Object({
    kind: Type.Union([
      Type.Literal("completed"),
      Type.Literal("limit_reached"),
      Type.Literal("stalled"),
      Type.Literal("cancelled"),
      Type.Literal("blocked"),
      Type.Literal("failed"),
      Type.Literal("uncertain"),
    ]),
    code: Type.String({ minLength: 1 }),
    initiatedBy: Type.Union([
      Type.Literal("target"),
      Type.Literal("controller"),
      Type.Literal("user"),
      Type.Literal("harness"),
    ]),
    failure: Type.Optional(
      Type.Object({
        origin: Type.Union([
          Type.Literal("runtime"),
          Type.Literal("controller"),
          Type.Literal("environment"),
          Type.Literal("harness"),
          Type.Literal("external_dependency"),
          Type.Literal("unknown"),
        ]),
        code: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        evidenceRefs: Type.Array(EvidenceRefSchema),
      }),
    ),
  }),
  cleanup: Type.Object({
    status: Type.Union([
      Type.Literal("not_needed"),
      Type.Literal("complete"),
      Type.Literal("incomplete"),
      Type.Literal("unknown"),
    ]),
    remainingResourceIds: Type.Array(Id),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
});
export type RunOutcome = Static<typeof RunOutcomeSchema>;

const CandidateRunStateSchema = Type.Union([
  Type.Literal("created"),
  Type.Literal("preparing"),
  Type.Literal("launching"),
  Type.Literal("awaiting_target"),
  Type.Literal("awaiting_controller"),
  Type.Literal("finalizing"),
  Type.Literal("finished"),
]);
export type CandidateRunState = Static<typeof CandidateRunStateSchema>;
export const RunRecordSchema = Type.Object({
  attempt: RunAttemptSchema,
  manifest: Type.Optional(RunManifestSchema),
  state: Type.Literal("finished"),
  stageReached: Type.Union([
    Type.Literal("created"),
    Type.Literal("preparing"),
    Type.Literal("launching"),
    Type.Literal("awaiting_target"),
    Type.Literal("awaiting_controller"),
  ]),
  outcome: RunOutcomeSchema,
  trace: Type.Object({
    experimentId: Id,
    runId: Id,
    firstSequence: Type.Integer({ minimum: 1 }),
    lastSequence: Type.Integer({ minimum: 1 }),
  }),
  artifactRefs: Type.Array(ArtifactRefSchema),
  warnings: Type.Array(
    Type.Object({
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      evidenceRefs: Type.Array(EvidenceRefSchema),
    }),
  ),
});
export type RunRecord = Static<typeof RunRecordSchema>;

export const EventEnvelopeSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  eventId: Id,
  occurredAt: Timestamp,
  type: Type.String({ minLength: 1 }),
  runId: Type.Optional(Id),
  operationId: Type.Optional(Id),
  payload: Type.Unknown(),
  checksum: Hash,
});
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
const RecoveryEvaluationPathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
});
const RecoveryEvaluationCommonSchema = {
  caseId: Id,
  stagingSucceeded: Type.Optional(Type.Boolean()),
  forensicsStarted: Type.Boolean(),
  forensicsCompleted: Type.Optional(Type.Boolean()),
  evidenceSourcesAttempted: Type.Optional(Type.Integer({ minimum: 0 })),
  evidenceSourcesAvailable: Type.Optional(Type.Integer({ minimum: 0 })),
  hypothesisCount: Type.Optional(Type.Integer({ minimum: 0 })),
  candidateCount: Type.Optional(Type.Integer({ minimum: 0 })),
  verifierRejectionReasons: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
      uniqueItems: true,
      maxItems: 32,
    }),
  ),
  providerFailureRetryable: Type.Optional(Type.Boolean()),
  pathBoundaryRejected: Type.Optional(Type.Boolean()),
  readinessStatus: Type.Optional(Type.Union([
    Type.Literal("ready"), Type.Literal("not_ready"), Type.Literal("blocked"),
  ])),
  readinessCheckedPaths: Type.Optional(Type.Array(RecoveryEvaluationPathSchema, { uniqueItems: true })),
  readinessMissingPaths: Type.Optional(Type.Array(RecoveryEvaluationPathSchema, { uniqueItems: true })),
  taskOutcome: Type.Optional(Type.Union([
    Type.Literal("ready_for_task"),
    Type.Literal("unrecoverable"),
    Type.Literal("blocked_by_safety"),
    Type.Literal("runner_failed"),
  ])),
  candidateCreated: Type.Boolean(),
  candidateAcceptedByUser: Type.Optional(Type.Boolean()),
  candidateReplayPassed: Type.Optional(Type.Boolean()),
  verification: Type.Union([
    Type.Literal("verified"),
    Type.Literal("pending_user_review"),
    Type.Literal("rejected"),
    Type.Literal("insufficient_evidence"),
  ]),
  recoveredPaths: Type.Array(RecoveryEvaluationPathSchema, {
    uniqueItems: true,
  }),
  modelCalls: Type.Integer({ minimum: 0 }),
  durationMs: Type.Integer({ minimum: 0 }),
  /** Component timings are optional for legacy rows; absent means not observed, not zero. */
  timings: Type.Optional(Type.Object({
    forensicsMs: Type.Optional(Type.Integer({ minimum: 0 })),
    modelRequestMs: Type.Optional(Type.Integer({ minimum: 0 })),
    candidateMaterializationMs: Type.Optional(Type.Integer({ minimum: 0 })),
    toolMs: Type.Optional(Type.Integer({ minimum: 0 })),
  })),
};
const RecoveryEvaluationTerminalSchema = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  failureCode: Type.Optional(
    Type.Union([
      Type.Literal("preflight_failed"),
      Type.Literal("model_request_failed"),
      Type.Literal("agent_protocol_failed"),
      Type.Literal("tool_failed"),
      Type.Literal("verifier_rejected"),
      Type.Literal("source_tripwire_failed"),
      Type.Literal("source_unavailable"),
      Type.Literal("evaluation_protocol_error"),
      Type.Literal("runner_crashed"),
      Type.Literal("cancelled"),
    ]),
  ),
  operation: Type.Optional(
    Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
  ),
});
export const RecoveryEvaluationPreflightSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
  outcome: Type.Union([
    Type.Literal("ready"),
    Type.Literal("blocked_before_sampling"),
  ]),
  providerId: Id,
  modelId: Id,
  checkedAt: Timestamp,
  operation: Id,
  providerReachable: Type.Boolean(),
  modelAccepted: Type.Boolean(),
  toolRoundTrip: Type.Boolean(),
  retryable: Type.Boolean(),
  failureCode: Type.Optional(Type.Literal("preflight_failed")),
  reasonCode: Type.Optional(
    Type.Union([
      Type.Literal("authentication_failed"),
      Type.Literal("endpoint_invalid"),
      Type.Literal("model_unavailable"),
      Type.Literal("timed_out"),
      Type.Literal("request_failed"),
      Type.Literal("configuration_invalid"),
    ]),
  ),
});
export type RecoveryEvaluationPreflight = Static<
  typeof RecoveryEvaluationPreflightSchema
>;
export const RecoveryEvaluationCaseStartedSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  caseId: Id,
  startedAt: Timestamp,
});
export type RecoveryEvaluationCaseStarted = Static<
  typeof RecoveryEvaluationCaseStartedSchema
>;
export const RecoveryEvaluationSourceAuditSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  caseId: Id,
  outcome: Type.Union([
    Type.Literal("passed"),
    Type.Literal("failed"),
    Type.Literal("unavailable"),
  ]),
});
export type RecoveryEvaluationSourceAudit = Static<
  typeof RecoveryEvaluationSourceAuditSchema
>;
const RecoveryEvaluationV1CaseSchema = Type.Union([
  Type.Object({
    ...RecoveryEvaluationCommonSchema,
    schemaVersion: Type.Literal(1),
    layer: Type.Literal("history_completed"),
  }),
  Type.Object({
    ...RecoveryEvaluationCommonSchema,
    schemaVersion: Type.Literal(1),
    layer: Type.Literal("interrupted_checkpoint"),
    checkpointPaths: Type.Array(RecoveryEvaluationPathSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
  }),
]);
/** A v2 row has a durable terminal status and a separate source-integrity audit outcome. */
export const RecoveryEvaluationTerminalCaseSchema = Type.Union([
  Type.Object({
    ...RecoveryEvaluationCommonSchema,
    schemaVersion: Type.Literal(2),
    layer: Type.Literal("history_completed"),
    terminal: RecoveryEvaluationTerminalSchema,
    sourceAudit: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("unavailable"),
    ]),
  }),
  Type.Object({
    ...RecoveryEvaluationCommonSchema,
    schemaVersion: Type.Literal(2),
    layer: Type.Literal("interrupted_checkpoint"),
    checkpointPaths: Type.Array(RecoveryEvaluationPathSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    terminal: RecoveryEvaluationTerminalSchema,
    sourceAudit: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("unavailable"),
    ]),
  }),
]);
/** Immutable measurement row for one no-cost Recovery evaluation fixture or recorded run. */
export const RecoveryEvaluationCaseSchema = Type.Union([
  RecoveryEvaluationV1CaseSchema,
  RecoveryEvaluationTerminalCaseSchema,
]);
export type RecoveryEvaluationCase = Static<
  typeof RecoveryEvaluationCaseSchema
>;
export type RecoveryEvaluationTerminalCase = Static<
  typeof RecoveryEvaluationTerminalCaseSchema
>;

/** Host-derived, redacted constraints used to decide whether staging can resume the task. */
export const RecoveryReadinessContextSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  taskSummary: Type.String({ minLength: 1, maxLength: 4096 }),
  observedWorkspaces: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
  relevantPaths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 256 }),
  /** Whether relevant paths are required inputs or expected outputs of the historical task. */
  pathSemantics: Type.Optional(Type.Union([Type.Literal("required_inputs"), Type.Literal("task_outputs")])),
  priorCommands: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 }),
  availableChecks: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 64 }),
}, { additionalProperties: false });
export type RecoveryReadinessContext = Static<typeof RecoveryReadinessContextSchema>;
