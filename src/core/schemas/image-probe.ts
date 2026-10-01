import { Type, type Static } from '@sinclair/typebox';
import { Timestamp } from './ids.js';

export const HarnessImageProbeSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  configFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  providerId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  observedAt: Timestamp,
  status: Type.Union(['passed', 'answer_mismatch', 'unsupported', 'provider_failure'].map((value) => Type.Literal(value))),
  failureKind: Type.Optional(Type.String()),
});
export type HarnessImageProbe = Static<typeof HarnessImageProbeSchema>;
