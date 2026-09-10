import { Type, type Static } from "@sinclair/typebox";
import { Id } from "./ids.js";

export const CandidateLaunchContextSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  experimentId: Id,
  runId: Id,
  workspaceRoot: Type.String({ minLength: 1 }),
  productId: Id,
  requestedModel: Type.String({ minLength: 1 }),
  resolvedModel: Type.String({ minLength: 1 }),
  permissions: Type.Record(Type.String(), Type.String()),
});
export type CandidateLaunchContext = Static<typeof CandidateLaunchContextSchema>;

export const CandidateSessionHandleSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  productId: Id,
  requestedModel: Type.String({ minLength: 1 }),
  resolvedModel: Type.String({ minLength: 1 }),
  workspaceRoot: Type.String({ minLength: 1 }),
});
export type CandidateSessionHandle = Static<typeof CandidateSessionHandleSchema>;

export const CandidateRuntimeEventTypeSchema = Type.Union([
  Type.Literal("session_started"),
  Type.Literal("session_failed"),
  Type.Literal("message_submitted"),
  Type.Literal("delivery_observed"),
  Type.Literal("turn_started"),
  Type.Literal("tool_started"),
  Type.Literal("tool_finished"),
  Type.Literal("visible_output"),
  Type.Literal("visible_prompt"),
  Type.Literal("turn_settled"),
  Type.Literal("usage_reported"),
  Type.Literal("runtime_failed"),
  Type.Literal("session_stopped"),
  Type.Literal("session_closed"),
]);
export type CandidateRuntimeEventType = Static<typeof CandidateRuntimeEventTypeSchema>;

/** Journal payload for `runtime.<CandidateRuntimeEventType>` EventEnvelope rows. Envelope owns eventId, sequence, type, and occurredAt. */
export const CandidateRuntimeEventSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  sessionId: Type.String({ minLength: 1 }),
  turnId: Type.Optional(Type.String({ minLength: 1 })),
  messageId: Type.Optional(Type.String({ minLength: 1 })),
  callId: Type.Optional(Type.String({ minLength: 1 })),
  evidenceRefs: Type.Array(Type.String()),
}, { additionalProperties: true });
export type CandidateRuntimeEvent = Static<typeof CandidateRuntimeEventSchema>;

export const UserVisibleTurnSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  turnIndex: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("waiting"),
    Type.Literal("failed"),
    Type.Literal("aborted"),
    Type.Literal("empty"),
    Type.Literal("unavailable"),
  ]),
  observedAt: Type.String({ minLength: 1 }),
  assistantText: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
});
export type UserVisibleTurn = Static<typeof UserVisibleTurnSchema>;
