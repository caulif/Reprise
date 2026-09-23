import { Type } from "@sinclair/typebox";
import { Id } from "./ids.js";

export const RecoveryMarkerSchema = Type.Object({
  status: Type.Union([
    Type.Literal("ready"),
    Type.Literal("blocked"),
    Type.Literal("recovered"),
    Type.Literal("partial"),
    Type.Literal("insufficient_evidence"),
    Type.Literal("failed"),
  ]),
  unresolved: Type.Array(Type.String()),
  sourceDigest: Type.String(),
  recoveredDigest: Type.String(),
  reportRef: Type.Optional(Id),
  reportRunId: Type.Optional(Id),
});
