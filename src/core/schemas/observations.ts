import { Type, type Static } from "@sinclair/typebox";
import { Hash, Id, Timestamp } from "./ids.js";

export const ObservationSessionManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  caseId: Id,
  source: Type.Object({
    productId: Id,
    sessionId: Id,
  }),
  evidenceLevel: Type.Optional(Type.Union([Type.Literal("transcript"), Type.Literal("history")])),
  provenance: Type.Object({
    packVersion: Type.String({ minLength: 1 }),
    importedAt: Timestamp,
    sourceHash: Hash,
  }),
  privacy: Type.Object({
    allowModelText: Type.Boolean(),
    allowBinary: Type.Boolean(),
  }),
  missing: Type.Array(Type.String()),
});
export type ObservationSessionManifest = Static<typeof ObservationSessionManifestSchema>;
