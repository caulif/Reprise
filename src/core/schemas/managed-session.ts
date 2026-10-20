import { Type, type Static } from '@sinclair/typebox';
import { Id, Hash, Timestamp } from './ids.js';

export const ManagedSessionReceiptSchema = Type.Object({
  schemaVersion: Type.Literal(1), productId: Id, sessionId: Id,
  experimentId: Id, runId: Id, role: Type.Literal('candidate'), origin: Type.Literal('reprise'),
  workspaceRoot: Type.String({ minLength: 1 }), nativeRoot: Type.String({ minLength: 1 }),
  nativeSourcePath: Type.Optional(Type.String({ minLength: 1 })),
  requestedModel: Type.String({ minLength: 1 }), createdAt: Timestamp,
  status: Type.Union([Type.Literal('recording'), Type.Literal('archived'), Type.Literal('unavailable')]),
  digest: Type.Optional(Hash), byteLength: Type.Optional(Type.Integer({ minimum: 0 })),
  archivedAt: Type.Optional(Timestamp), diagnostic: Type.Optional(Type.String()),
  preview: Type.Optional(Type.Object({
    model: Type.Optional(Type.String({ minLength: 1 })),
    summary: Type.Optional(Type.String({ maxLength: 512 })),
    startedAt: Type.Optional(Timestamp), updatedAt: Type.Optional(Timestamp),
    signals: Type.Object({ userMessages: Type.Integer({ minimum: 0 }), assistantMessages: Type.Integer({ minimum: 0 }), toolCalls: Type.Integer({ minimum: 0 }), completedTurns: Type.Integer({ minimum: 0 }) }),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type ManagedSessionReceipt = Static<typeof ManagedSessionReceiptSchema>;
