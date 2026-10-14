import { Type, type Static } from "@sinclair/typebox";
import { Hash, Id, Timestamp } from "./ids.js";

/** Stable extractor revision string; bump when decode rules change. */
const HistoricalArtifactExtractorVersionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$",
});

const HistoricalArtifactOriginSchema = Type.Union([
  Type.Literal("reconstructed_from_history"), Type.Literal("captured_file"),
  Type.Literal("git_snapshot"), Type.Literal("user_selected_substitute"),
]);

/** Unknown paths are issues, never artifact rows with unknown finality. */
const HistoricalArtifactFinalitySchema = Type.Literal("final");

/**
 * Logical path relative to the task root.
 * Host rejection of `..`, absolutes, UNC, drives, and ADS is enforced at extract time.
 */
const HistoricalLogicalPathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^[^\\r\\n:*?\"<>|\\\\]+$",
});

const HistoricalArtifactIssueCodeSchema = Type.Union([
  Type.Literal("unsupported_write"),
  Type.Literal("missing_preimage"),
  Type.Literal("truncated_content"),
  Type.Literal("ambiguous_version"),
  Type.Literal("path_rejected"),
  Type.Literal("path_conflict"),
  Type.Literal("failed_tool"),
]);

const HistoricalArtifactIssueSchema = Type.Object({
  code: HistoricalArtifactIssueCodeSchema,
  logicalPath: Type.Optional(HistoricalLogicalPathSchema),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 192 }), { maxItems: 64 }),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

const artifactFields = {
  artifactId: Id,
  logicalPath: HistoricalLogicalPathSchema,
  bundleId: Id,
  mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  gitMode: Type.Optional(Type.Union([Type.Literal('100644'), Type.Literal('100755')])),
  contentHash: Hash,
  byteLength: Type.Integer({ minimum: 0, maximum: 32 * 1024 * 1024 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 192 }), { minItems: 1, maxItems: 64 }),
  finality: HistoricalArtifactFinalitySchema,
};
const HistoricalArtifactSchema = Type.Object({ ...artifactFields, origin: HistoricalArtifactOriginSchema });
const OldArtifactSchema = Type.Object({ ...artifactFields, origin: Type.Literal("reconstructed_from_history") });
const GitObjectId = Type.String({ pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" });
const captureFields = { capturedAt: Timestamp, selectionBasis: Type.String({ minLength: 1, maxLength: 2048 }) };
const HistoricalCaptureSchema = Type.Union([
  Type.Object({ ...captureFields, kind: Type.Literal("captured_file"), expectedHash: Hash }),
  Type.Object({ ...captureFields, kind: Type.Literal("user_selected_substitute"), expectedHash: Hash,
    originalStatus: Type.Union([Type.Literal('unavailable'), Type.Literal('not_verified')]), userInstruction: Type.String({ minLength: 1, maxLength: 2048 }) }),
  Type.Object({ ...captureFields, kind: Type.Literal("git_snapshot"), commit: GitObjectId, tree: GitObjectId }),
]);
const manifestFields = {
  sourceHash: Hash, extractorVersion: HistoricalArtifactExtractorVersionSchema,
  issues: Type.Array(HistoricalArtifactIssueSchema, { maxItems: 4096 }),
};

export const HistoricalDeliveryManifestSchema = Type.Object({
  ...manifestFields, schemaVersion: Type.Literal(2), caseId: Id, selectionId: Id,
  capture: HistoricalCaptureSchema,
  artifacts: Type.Array(HistoricalArtifactSchema, { maxItems: 4096 }),
});
export const HistoricalArtifactExtractManifestSchema = Type.Object({ ...manifestFields, schemaVersion: Type.Literal(1), artifacts: Type.Array(OldArtifactSchema, { maxItems: 4096 }) });
export const HistoricalArtifactManifestSchema = Type.Union([
  HistoricalArtifactExtractManifestSchema,
  HistoricalDeliveryManifestSchema,
]);
export const HistoricalDeliverySelectionSchema = Type.Object({
  schemaVersion: Type.Literal(1), caseId: Id, sourceHash: Hash, selectionId: Id, manifestHash: Hash,
});
export const HistoricalDeliveryReceiptSchema = Type.Object({
  schemaVersion: Type.Literal(1), caseId: Id, selectionId: Id, sourceHash: Hash,
  sourceLocator: Type.String({ minLength: 1 }), origin: HistoricalArtifactOriginSchema,
});

export type HistoricalArtifactOrigin = Static<typeof HistoricalArtifactOriginSchema>;
export type HistoricalArtifactFinality = Static<typeof HistoricalArtifactFinalitySchema>;
export type HistoricalArtifactIssueCode = Static<typeof HistoricalArtifactIssueCodeSchema>;
export type HistoricalArtifactIssue = Static<typeof HistoricalArtifactIssueSchema>;
export type HistoricalArtifact = Static<typeof HistoricalArtifactSchema>;
export type HistoricalArtifactManifest = Static<typeof HistoricalArtifactManifestSchema>;
export type HistoricalDeliveryManifest = Static<typeof HistoricalDeliveryManifestSchema>;
export type HistoricalDeliverySelection = Static<typeof HistoricalDeliverySelectionSchema>;
