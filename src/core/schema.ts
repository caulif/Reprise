import { Type, type Static } from '@sinclair/typebox';

const Id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' });
const JsonRecord = Type.Record(Type.String(), Type.Unknown());
export const EvidenceRefSchema = Type.String({ pattern: '^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
export type EvidenceRef = Static<typeof EvidenceRefSchema>;

export const CaseArtifactRefSchema = Type.Object({ artifactId: Id, caseId: Id });
export type CaseArtifactRef = Static<typeof CaseArtifactRefSchema>;
export const ArtifactRefSchema = Type.Union([
  CaseArtifactRefSchema,
  Type.Object({ artifactId: Id, experimentId: Id, runId: Type.Optional(Id) }),
]);
export type ArtifactRef = Static<typeof ArtifactRefSchema>;

export const SessionRefSchema = Type.Object({
  productId: Id,
  sessionId: Id,
  sourcePath: Type.Optional(Type.String({ minLength: 1 })),
});
const MessageSchema = Type.Object({
  id: Id,
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('tool')]),
  text: Type.String(),
});
const BaselineEvidenceSchema = Type.Object({
  status: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]),
  finalMessage: Type.Optional(Type.String()),
  artifactRefs: Type.Array(CaseArtifactRefSchema),
  evidenceRefs: Type.Array(EvidenceRefSchema),
});
export const TaskCaseSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  caseId: Id,
  source: SessionRefSchema,
  initialInput: MessageSchema,
  transcript: Type.Array(MessageSchema, { minItems: 1 }),
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
    resolved: Type.Union([Type.String({ minLength: 1 }), Type.Literal('unknown')]),
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

export const RunOutcomeSchema = Type.Object({
  task: Type.Object({
    status: Type.Union([
      Type.Literal('apparently_completed'), Type.Literal('incomplete'),
      Type.Literal('indeterminate'), Type.Literal('not_assessed'),
    ]),
    decidedBy: Type.Optional(Type.Literal('controller')),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
  termination: Type.Object({
    kind: Type.Union([
      Type.Literal('completed'), Type.Literal('limit_reached'), Type.Literal('stalled'),
      Type.Literal('cancelled'), Type.Literal('blocked'), Type.Literal('failed'), Type.Literal('uncertain'),
    ]),
    code: Type.String({ minLength: 1 }),
    initiatedBy: Type.Union([
      Type.Literal('target'), Type.Literal('controller'), Type.Literal('user'), Type.Literal('harness'),
    ]),
    failure: Type.Optional(Type.Object({
      origin: Type.Union([
        Type.Literal('runtime'), Type.Literal('controller'), Type.Literal('environment'),
        Type.Literal('harness'), Type.Literal('external_dependency'), Type.Literal('unknown'),
      ]),
      code: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      evidenceRefs: Type.Array(EvidenceRefSchema),
    })),
  }),
  cleanup: Type.Object({
    status: Type.Union([
      Type.Literal('not_needed'), Type.Literal('complete'), Type.Literal('incomplete'), Type.Literal('unknown'),
    ]),
    remainingResourceIds: Type.Array(Id),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  }),
});
export type RunOutcome = Static<typeof RunOutcomeSchema>;

export const CandidateRunStateSchema = Type.Union([
  Type.Literal('created'), Type.Literal('preparing'), Type.Literal('launching'),
  Type.Literal('awaiting_target'), Type.Literal('awaiting_controller'),
  Type.Literal('finalizing'), Type.Literal('finished'),
]);
export type CandidateRunState = Static<typeof CandidateRunStateSchema>;
export const RunRecordSchema = Type.Object({
  attempt: RunAttemptSchema,
  manifest: Type.Optional(RunManifestSchema),
  state: Type.Literal('finished'),
  stageReached: Type.Union([
    Type.Literal('created'), Type.Literal('preparing'), Type.Literal('launching'),
    Type.Literal('awaiting_target'), Type.Literal('awaiting_controller'),
  ]),
  outcome: RunOutcomeSchema,
  trace: Type.Object({
    experimentId: Id,
    runId: Id,
    firstSequence: Type.Integer({ minimum: 1 }),
    lastSequence: Type.Integer({ minimum: 1 }),
  }),
  artifactRefs: Type.Array(ArtifactRefSchema),
  warnings: Type.Array(Type.Object({
    code: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    evidenceRefs: Type.Array(EvidenceRefSchema),
  })),
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
