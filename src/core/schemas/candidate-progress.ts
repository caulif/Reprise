import { Type } from '@sinclair/typebox';
import { Id } from './ids.js';
export const CandidateProgressCheckpointSchema = Type.Object({
  schemaVersion: Type.Literal(1), sessionId: Type.Optional(Id), clientMessageId: Id,
  turnIndex: Type.Integer({ minimum: 0 }), delivery: Type.Union([Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('unknown')]),
  nextAction: Type.Union([Type.Literal('wait_for_turn'), Type.Literal('controller_decision'), Type.Literal('inspect_unknown_delivery'), Type.Literal('stop')]),
});
export const CandidateWorkspaceScopeSchema = Type.Object({
  changedPaths: Type.Array(Type.String()), runtimeGeneratedPaths: Type.Optional(Type.Array(Type.String())),
  snapshotStatus: Type.Optional(Type.Union([Type.Literal('complete'), Type.Literal('incomplete')])),
  snapshotRoot: Type.Optional(Type.String()),
  omittedRebuildableDirectories: Type.Optional(Type.Array(Type.Object({ path: Type.String(), lockfile: Type.String(), restoreCommand: Type.String() }))),
});
