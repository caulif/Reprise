import { Type } from '@sinclair/typebox';

const AgentYieldDeadlineSchema = Type.Object({
  at: Type.Integer({ minimum: 0 }), reason: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export const AgentInvocationStartedSchema = Type.Object({
  invocationId: Type.String({ minLength: 1 }), requestId: Type.Optional(Type.String({ minLength: 1 })),
  yieldDeadline: Type.Optional(AgentYieldDeadlineSchema),
  reasoningEffortCeiling: Type.Optional(Type.Literal('low')),
}, { additionalProperties: false });

export const AgentInvocationYieldedSchema = Type.Object({
  schemaVersion: Type.Literal(1), invocationId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
