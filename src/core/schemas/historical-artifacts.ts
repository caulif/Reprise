import { Type, type Static } from "@sinclair/typebox";
import { Hash, Id } from "./ids.js";

/** Stable extractor revision string; bump when decode rules change. */
const HistoricalArtifactExtractorVersionSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$",
});

/** B1 produces reconstructed bytes only; sealed original artifacts are a later path. */
const HistoricalArtifactOriginSchema = Type.Literal("reconstructed_from_history");

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

const HistoricalArtifactSchema = Type.Object({
  artifactId: Id,
  logicalPath: HistoricalLogicalPathSchema,
  bundleId: Id,
  mediaType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  contentHash: Hash,
  byteLength: Type.Integer({ minimum: 0, maximum: 32 * 1024 * 1024 }),
  origin: HistoricalArtifactOriginSchema,
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 192 }), { minItems: 1, maxItems: 64 }),
  finality: HistoricalArtifactFinalitySchema,
});

export const HistoricalArtifactManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sourceHash: Hash,
  extractorVersion: HistoricalArtifactExtractorVersionSchema,
  artifacts: Type.Array(HistoricalArtifactSchema, { maxItems: 4096 }),
  issues: Type.Array(HistoricalArtifactIssueSchema, { maxItems: 4096 }),
});

export type HistoricalArtifactOrigin = Static<typeof HistoricalArtifactOriginSchema>;
export type HistoricalArtifactFinality = Static<typeof HistoricalArtifactFinalitySchema>;
export type HistoricalArtifactIssueCode = Static<typeof HistoricalArtifactIssueCodeSchema>;
export type HistoricalArtifactIssue = Static<typeof HistoricalArtifactIssueSchema>;
export type HistoricalArtifact = Static<typeof HistoricalArtifactSchema>;
export type HistoricalArtifactManifest = Static<typeof HistoricalArtifactManifestSchema>;
