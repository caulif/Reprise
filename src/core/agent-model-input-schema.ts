import { Type, type Static } from "@sinclair/typebox";

const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });

export const AgentTextBodySchema = Type.Union([
  Type.Object({
    encoding: Type.Literal("inline"),
    schemaVersion: Type.Literal(1),
    text: Type.String(),
  }),
  Type.Object({
    encoding: Type.Literal("artifact"),
    schemaVersion: Type.Literal(1),
    artifactId: Id,
    contentHash: Hash,
    byteLength: Type.Integer({ minimum: 0 }),
  }),
]);
export type AgentTextBody = Static<typeof AgentTextBodySchema>;

export const AgentImageRefSchema = Type.Object({
  type: Type.Literal("image"),
  mimeType: Type.String({ minLength: 1, maxLength: 128 }),
  contentHash: Hash,
  byteLength: Type.Integer({ minimum: 0 }),
  artifactId: Type.Optional(Id),
});
export type AgentImageRef = Static<typeof AgentImageRefSchema>;

const AgentToolSpecSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1 }),
  parameters: Type.Unknown(),
});

export const ReconstructedModelRequestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 }),
  invocationId: Type.String({ minLength: 1 }),
  requestIndex: Type.Integer({ minimum: 1 }),
  repair: Type.Boolean(),
  compacted: Type.Boolean(),
  contentComplete: Type.Boolean(),
  legacyRequestComplete: Type.Optional(Type.Boolean()),
  systemPrompt: Type.String(),
  tools: Type.Array(AgentToolSpecSchema),
  messages: Type.Array(Type.Unknown()),
});
export type ReconstructedModelRequest = Static<typeof ReconstructedModelRequestSchema>;

export const ModelInputDiagnosticSchema = Type.Object({
  code: Type.Union([
    Type.Literal("incomplete_tail"),
    Type.Literal("invalid_json"),
    Type.Literal("invalid_envelope"),
    Type.Literal("missing_attachment"),
    Type.Literal("attachment_checksum"),
    Type.Literal("schema"),
    Type.Literal("incomplete_content"),
    Type.Literal("unsupported_schema"),
    Type.Literal("checksum_mismatch"),
    Type.Literal("sequence_gap"),
  ]),
  message: Type.String({ minLength: 1 }),
  sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  artifactId: Type.Optional(Id),
});
export type ModelInputDiagnostic = Static<typeof ModelInputDiagnosticSchema>;
