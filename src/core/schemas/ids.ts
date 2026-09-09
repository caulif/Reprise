import { Type, type Static } from "@sinclair/typebox";

export const Id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
export const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const Timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" });
export const JsonRecord = Type.Record(Type.String(), Type.Unknown());
export const EvidenceRefSchema = Type.String({
  pattern: "^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});
export type EvidenceRef = Static<typeof EvidenceRefSchema>;
