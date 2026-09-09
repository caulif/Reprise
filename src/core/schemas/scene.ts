import { Type, type Static } from "@sinclair/typebox";
import { Id } from "./ids.js";

export const SceneDescriptorSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  experimentId: Id,
  caseId: Id,
  runId: Id,
  sourceRoot: Type.String({ minLength: 1 }),
  sealed: Type.Boolean(),
});
export type SceneDescriptor = Static<typeof SceneDescriptorSchema>;
