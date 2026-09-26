import { Type, type Static } from "@sinclair/typebox";
import { EvidenceRefSchema, Hash, Id } from "./schemas/ids.js";
import {
  ComparisonBriefingContextSchema,
  ComparisonDraftSubmissionSchema,
  ComparisonInvocationSchema,
  ComparisonMediaDerivationSchema,
  ComparisonMediaRecordSchema,
  ComparisonMediaShortRefSchema,
  ComparisonReportModelSchema,
  ComparisonShortRefSchema,
} from "./comparison-schema.js";
export { EvidenceRefSchema, type EvidenceRef } from "./schemas/ids.js";
export { SceneDescriptorSchema, type SceneDescriptor } from "./schemas/scene.js";
export { RecoveryMarkerSchema } from "./schemas/recovery-marker.js";
export { EventEnvelopeSchema, type EventEnvelope } from "./schemas/event.js";
export { ControllerDecisionSchema, type ControllerDecision, ComparisonResultSchema, type ComparisonAgentEnvelope } from "./schemas/agent-output.js";
export { ArtifactManifestSchema, type ArtifactManifest } from "./schemas/artifact.js";
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
  RecoveryTaskOutcomeSchema,
  type RecoveryTaskOutcome,
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
  RecoveryPreTaskDiagnosisSchema,
  type RecoveryPreTaskDiagnosis,
  RecoveryExplanationSchema,
  type RecoveryExplanation,
  RecoveryAgentEnvelopeSchema,
  type RecoveryAgentEnvelope,
  RecoveryDecisionSchema,
  type RecoveryDecision,
} from "./schemas/recovery.js";
export {
  ArtifactRefSchema,
  type ArtifactRef,
  type CaseArtifactRef,
  TaskCaseSchema,
  type TaskCase,
  FROZEN_ALLOW_MODEL_TEXT,
  CandidateSpecSchema,
  type CandidateSpec,
} from "./schemas/task-case.js";
export {
  HistoricalArtifactManifestSchema,
  type HistoricalArtifact,
  type HistoricalArtifactManifest,
  type HistoricalArtifactIssue,
  type HistoricalArtifactIssueCode,
  type HistoricalArtifactOrigin,
  type HistoricalArtifactFinality,
} from "./schemas/historical-artifacts.js";
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
export {
  CandidateLaunchContextSchema,
  type CandidateLaunchContext,
  CandidateSessionHandleSchema,
  type CandidateSessionHandle,
  CandidateRuntimeEventSchema,
  CandidateRuntimeEventTypeSchema,
  PublicLiveActivitySchema,
  type CandidateRuntimeEvent,
  type CandidateRuntimeEventType,
  type PublicLiveActivity,
  UserVisibleTurnSchema,
  type UserVisibleTurn,
} from "./schemas/candidate.js";
export {
  ObservationSessionManifestSchema,
  type ObservationSessionManifest,
} from "./schemas/observations.js";
export {
  GitSinkManifestSchema,
  GitSinkManifestV1Schema,
  type GitSinkManifest,
  type GitSinkManifestV1,
  type GitSinkRepoRecord,
  type GitSinkRef,
  type GitSinkRefChange,
  type GitSinkSkipped,
  type GitSinkIssue,
  type GitSinkIssueCode,
} from "./schemas/git-sink.js";
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
export const ControllerWorkspaceWritePayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  runId: Id,
  tool: Type.Union([Type.Literal("edit"), Type.Literal("write")]),
  path: Type.String({ minLength: 1, maxLength: 512 }),
});
export type ControllerWorkspaceWritePayload = Static<typeof ControllerWorkspaceWritePayloadSchema>;
export const ControllerExternalWritePayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Id,
  runId: Id,
  tool: Type.Literal("shell_exec"),
  pathClass: Type.Union([Type.Literal("absolute"), Type.Literal("unc"), Type.Literal("wsl")]),
  pathRef: Type.String({ minLength: 1, maxLength: 512 }),
  commandDigest: Hash,
});
export type ControllerExternalWritePayload = Static<typeof ControllerExternalWritePayloadSchema>;
export const ControllerReadArtifactSchema = Type.Object({
  path: Type.String({ minLength: 1 }), offset: Type.Integer({ minimum: 0 }),
  content: Type.String(),
  contentBlocks: Type.Optional(Type.Array(Type.Union([
    Type.Object({ type: Type.Literal("text"), text: Type.String() }),
    Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
  ]))),
});
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
export const ComparisonEvidenceOriginSchema = Type.Union([
  Type.Literal("historical_artifact"),
  Type.Literal("reconstructed_from_history"),
  Type.Literal("candidate_delivery"),
  Type.Literal("derived_analysis"),
  Type.Literal("host_review"),
]);
export type ComparisonEvidenceOrigin = Static<typeof ComparisonEvidenceOriginSchema>;
const ComparisonLinkSchema = Type.Object({
  side: Type.Union([
    Type.Literal("baseline"),
    Type.Literal("candidate"),
    Type.Literal("host"),
    Type.Literal("derived"),
  ]),
  inspectPath: Type.String({ minLength: 1 }),
  reportHref: Type.Optional(Type.String({ minLength: 1 })),
  artifactId: Type.Optional(Id),
  path: Type.Optional(Type.String({ minLength: 1 })),
  mediaType: Type.Optional(Type.String({ minLength: 1 })),
  byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
  evidenceRef: Type.Optional(EvidenceRefSchema),
  shortRef: Type.Optional(Type.String({ pattern: "^ev-[0-9]{2,6}$" })),
  label: Type.Optional(Type.String({ minLength: 1 })),
  origin: Type.Optional(ComparisonEvidenceOriginSchema),
  contentHash: Type.Optional(Hash),
  sourceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 })),
});
export const ComparisonLinksSchema = Type.Array(ComparisonLinkSchema);
export type ComparisonLinkRecord = Static<typeof ComparisonLinkSchema>;
export const ComparisonEvidenceCatalogSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Id,
  revision: Type.Integer({ minimum: 0 }),
  links: ComparisonLinksSchema,
  media: Type.Array(ComparisonMediaRecordSchema),
});
export type ComparisonEvidenceCatalogSnapshot = Static<typeof ComparisonEvidenceCatalogSchema>;
const ComparisonEvidenceRegistrationDerivationSchema = Type.Object({
  kind: Type.Literal("register_evidence"),
  relativePath: Type.String({ minLength: 1, maxLength: 512 }),
  dedupeKey: Type.String({ minLength: 1, maxLength: 512 }),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});
export type ComparisonEvidenceRegistrationDerivation = Static<typeof ComparisonEvidenceRegistrationDerivationSchema>;
export const ComparisonEvidenceRegisteredPayloadSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  attemptId: Id,
  revision: Type.Integer({ minimum: 1 }),
  shortRef: Type.String({ minLength: 1, maxLength: 32 }),
  kind: Type.Union([Type.Literal("evidence"), Type.Literal("media")]),
  origin: ComparisonEvidenceOriginSchema,
  contentHash: Hash,
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 32 }),
  artifactRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 16 }),
  derivation: Type.Optional(Type.Union([
    ComparisonEvidenceRegistrationDerivationSchema,
    ComparisonMediaDerivationSchema,
  ])),
});
export type ComparisonEvidenceRegisteredPayload = Static<typeof ComparisonEvidenceRegisteredPayloadSchema>;
export {
  ComparisonBriefingContextSchema,
  ComparisonDraftSubmissionSchema,
  ComparisonInvocationSchema,
  ComparisonMediaDerivationSchema,
  ComparisonMediaRecordSchema,
  ComparisonMediaShortRefSchema,
  ComparisonReportModelSchema,
  ComparisonShortRefSchema,
};
export type { ComparisonDraftSubmission, ComparisonMediaDerivation, ComparisonMediaRecord, ComparisonMediaRef, ComparisonReportModel } from "./comparison-schema.js";
export {
  type ModelInputCapabilities,
} from "./schemas/model-input-capabilities.js";



