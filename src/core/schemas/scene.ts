import { Type, type Static } from "@sinclair/typebox";
import { Id } from "./ids.js";

export const SceneDescriptorSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  experimentId: Id,
  caseId: Id,
  runId: Id,
  recoveryProviderRunId: Type.Optional(Id),
  recoveryProviderLayout: Type.Optional(Type.Literal('compact-v1')),
  sourceRoot: Type.String({ minLength: 1 }),
  sealed: Type.Boolean(),
});
export type SceneDescriptor = Static<typeof SceneDescriptorSchema>;
