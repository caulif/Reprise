import { Type, type Static } from "@sinclair/typebox";
import { ComparisonInvocationSchema } from "./comparison-schema.js";
import { Hash, Id } from "./schemas/ids.js";

export const ComparisonAttemptReferenceSchema = Type.Object({ attemptId: Id });
export const ComparisonReportOwnerSchema = Type.Object({
  schemaVersion: Type.Literal(1), experimentId: Id, runId: Id, attemptId: Id,
  report: Type.Object({
    path: Type.String({ pattern: "^(report|comparison-failure)-[A-Za-z0-9._-]+\\.html$" }),
    sha256: Hash,
  }),
});
export type ComparisonReportOwner = Static<typeof ComparisonReportOwnerSchema>;
export const ComparisonAttemptResultSchema = Type.Composite([
  ComparisonReportOwnerSchema, Type.Object({ comparison: ComparisonInvocationSchema }),
]);
export type ComparisonAttemptResult = Static<typeof ComparisonAttemptResultSchema>;
