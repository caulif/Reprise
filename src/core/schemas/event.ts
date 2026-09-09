import { Type, type Static } from "@sinclair/typebox";
import { Hash, Id, Timestamp } from "./ids.js";

export const EventEnvelopeSchema = Type.Object({
  schemaVersion: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
  eventId: Id,
  occurredAt: Timestamp,
  type: Type.String({ minLength: 1 }),
  runId: Type.Optional(Id),
  operationId: Type.Optional(Id),
  payload: Type.Unknown(),
  checksum: Hash,
});
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;
