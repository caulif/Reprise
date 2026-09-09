import { Type, type Static } from "@sinclair/typebox";
import { EvidenceRefSchema, Hash, Id } from "./schemas/ids.js";
export { EvidenceRefSchema, type EvidenceRef } from "./schemas/ids.js";
export { SceneDescriptorSchema, type SceneDescriptor } from "./schemas/scene.js";
export { EventEnvelopeSchema, type EventEnvelope } from "./schemas/event.js";
export {
  SessionRecoveryAttemptSchema,
  type SessionRecoveryAttemptRecord,
  type RecoveryReadiness,
  type RecoveryDiagnostic,
  RecoverySelectionManifestSchema,
  type RecoverySelectionManifest,
  RecoverySelectionDiagnosticsSchema,
  type RecoverySelectionDiagnostics,
  type RecoveryManifest,
  RecoveryAttemptDiagnosisSchema,
  type RecoveryAttemptDiagnosis,
  RecoveryCheckpointRecordSchema,
  type RecoveryCheckpointRecord,
  RecoveryControlledWriteSchema,
  type RecoveryControlledWrite,
  type RecoveryFact,
  RecoveryLifecycleAttemptSchema,
  type RecoveryLifecycleAttempt,
  type RecoveryPlan,
  type RecoveryCandidate,
  type RecoveryCandidateGraph,
  RecoveryInvestigationSchema,
  type RecoveryInvestigation,
  type RecoveryPathOutcome,
  type RecoveryReviewSummary,
  type RecoveryReviewFeedback,
  RecoveryExternalEffectSchema,
  type RecoveryExternalEffect,
  RecoveryCompensationRequestSchema,
  type RecoveryCompensationRequest,
  RecoveryCompensationResultSchema,
  type RecoveryCompensationResult,
  RecoveryEvaluationPreflightSchema,
  type RecoveryEvaluationPreflight,
  RecoveryEvaluationCaseStartedSchema,
  type RecoveryEvaluationCaseStarted,
  RecoveryEvaluationSourceAuditSchema,
  type RecoveryEvaluationSourceAudit,
  RecoveryEvaluationTerminalCaseSchema,
  RecoveryEvaluationCaseSchema,
  type RecoveryEvaluationCase,
  type RecoveryEvaluationTerminalCase,
  RecoveryReadinessContextSchema,
  type RecoveryReadinessContext,
} from "./schemas/recovery.js";
export {
  ArtifactRefSchema,
  type ArtifactRef,
  type CaseArtifactRef,
  TaskCaseSchema,
  type TaskCase,
  CandidateSpecSchema,
  type CandidateSpec,
} from "./schemas/task-case.js";
export {
  ExperimentSpecSchema,
  type ExperimentSpec,
  type AgentBudget,
  type AgentConfig,
  type RunPolicy,
  RunAttemptSchema,
  type RunAttempt,
  RunManifestSchema,
  type RunManifest,
  type RunOutcome,
  type CandidateRunState,
  RunRecordSchema,
  type RunRecord,
} from "./schemas/run.js";
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
export const ControllerReadArtifactSchema = Type.Object({
  path: Type.String({ minLength: 1 }), offset: Type.Integer({ minimum: 0 }),
  content: Type.String(),
  contentBlocks: Type.Optional(Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  ]))),
});
export const ControllerShellArtifactSchema = Type.Object({ schemaVersion: Type.Literal(1), command: Type.String({ minLength: 1 }), cwd: Type.Literal("."), exitCode: Type.Integer(), stdoutBytes: Type.Integer({ minimum: 0 }), stderrBytes: Type.Integer({ minimum: 0 }), truncated: Type.Boolean(), content: Type.String() });
export const ComparisonRequestedPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  runId: Id,
  inputDigest: Hash,
  artifactId: Id,
  byteLength: Type.Integer({ minimum: 1, maximum: 262_144 }),
  truncated: Type.Boolean(),
});
export type ComparisonRequestedPayload = Static<typeof ComparisonRequestedPayloadSchema>;
export const ComparisonPhaseRequestedPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Id,
  phase: Type.Union([Type.Literal("plan"), Type.Literal("report")]),
  inputDigest: Hash,
  artifactId: Id,
  byteLength: Type.Integer({ minimum: 1 }),
});
export type ComparisonPhaseRequestedPayload = Static<typeof ComparisonPhaseRequestedPayloadSchema>;
const ComparisonLinkSchema = Type.Object({
  side: Type.Union([Type.Literal("baseline"), Type.Literal("candidate")]),
  inspectPath: Type.String({ minLength: 1 }),
  reportHref: Type.Optional(Type.String({ minLength: 1 })),
  artifactId: Type.Optional(Id),
  path: Type.Optional(Type.String({ minLength: 1 })),
  mediaType: Type.Optional(Type.String({ minLength: 1 })),
  byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
  evidenceRef: Type.Optional(EvidenceRefSchema),
});
export const ComparisonLinksSchema = Type.Array(ComparisonLinkSchema);
export type ComparisonLinkRecord = Static<typeof ComparisonLinkSchema>;
export { ComparisonBriefingContextSchema, ComparisonInvocationSchema } from "./comparison-schema.js";

