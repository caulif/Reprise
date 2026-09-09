import { Type, type Static } from "@sinclair/typebox";
import { EvidenceRefSchema, Hash, Id, JsonRecord, Timestamp } from "./ids.js";

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
