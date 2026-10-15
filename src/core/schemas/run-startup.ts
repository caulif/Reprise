import { Type, type Static } from '@sinclair/typebox';
import { Id, Timestamp } from './ids.js';

const Failure = Type.Object({ name: Type.String(), message: Type.String() });
const Owner = { schemaVersion: Type.Literal(1), experimentId: Id, runId: Id, caseId: Id };
export const ExperimentWriterLeaseSchema = Type.Object({
  experimentId: Id, pid: Type.Integer({ minimum: 1 }), nonce: Type.String({ minLength: 1 }),
  startedAt: Type.String(), host: Type.String(),
});
export type ExperimentWriterLease = Static<typeof ExperimentWriterLeaseSchema>;
export const RunStartupFailureSchema = Type.Object({
  ...Owner,
  stage: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]),
  cancellationSource: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('supervisor'), Type.Literal('budget')])),
  error: Failure,
  cleanupErrors: Type.Array(Type.Object({ resource: Type.String(), error: Failure })),
  recordedAt: Timestamp,
});
export type RunStartupFailure = Static<typeof RunStartupFailureSchema>;
export const RunCleanupFailureSchema = Type.Object({
  ...Owner,
  resource: Type.String({ minLength: 1 }),
  error: Failure,
  recordedAt: Timestamp,
});
export type RunCleanupFailure = Static<typeof RunCleanupFailureSchema>;
