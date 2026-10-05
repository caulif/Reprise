import { Type } from '@sinclair/typebox';

export const AgentInvocationYieldedSchema = Type.Object({
  schemaVersion: Type.Literal(1), invocationId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });
