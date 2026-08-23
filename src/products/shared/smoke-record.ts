import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const SmokeId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
const SmokeTimestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' });
const SmokeNote = Type.String({ maxLength: 4_000 });

export type CommonSmokeGateInput = {
  taskCaseReady: boolean;
  isolatedWorkspace: boolean;
  noIrreversibleActions: boolean;
  accountConfirmed: boolean;
  networkConfirmed: boolean;
  costLimit: string;
  maxWallClockMs: number;
};

export function commonSmokeMissing(input: CommonSmokeGateInput): string[] {
  const missing: string[] = [];
  if (!input.taskCaseReady) missing.push('TaskCase and executable input are not ready.');
  if (!input.isolatedWorkspace) missing.push('The workspace is not proven isolated.');
  if (!input.noIrreversibleActions) missing.push('The task still contains an irreversible action.');
  if (!input.accountConfirmed) missing.push('The Runtime account is not confirmed.');
  if (!input.networkConfirmed) missing.push('Network permission is not confirmed.');
  if (!input.costLimit.trim()) missing.push('A cost limit is required.');
  if (!Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs < 1) missing.push('A positive maximum wall clock is required.');
  return missing;
}

export const smokeAcceptanceShared = {
  schemaVersion: Type.Literal(1),
  status: Type.Union([Type.Literal('passed'), Type.Literal('blocked'), Type.Literal('unsupported')]),
  recordedAt: SmokeTimestamp,
  taskCaseId: SmokeId,
  experimentId: SmokeId,
  runId: SmokeId,
  executable: Type.String({ minLength: 1, maxLength: 4_000 }),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  requestedModel: Type.String({ minLength: 1, maxLength: 200 }),
  resolvedModel: Type.String({ minLength: 1, maxLength: 200 }),
  fidelity: Type.Union([Type.Literal('native'), Type.Literal('partial'), Type.Literal('unknown')]),
  termination: Type.Union([Type.Literal('completed'), Type.Literal('cancelled'), Type.Literal('failed'), Type.Literal('unknown')]),
  cleanup: Type.Union([Type.Literal('released'), Type.Literal('failed'), Type.Literal('unknown')]),
  reportPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  smokeSteps: Type.Object({
    started: Type.Boolean(),
    initialAdmission: Type.Boolean(),
    firstTurnSettlement: Type.Boolean(),
    followupSubmission: Type.Boolean(),
    stopped: Type.Boolean(),
  }),
  humanJudgment: Type.Object({
    rawEvidence: SmokeNote,
    artifacts: SmokeNote,
    traceAndReport: SmokeNote,
    knownLimitations: SmokeNote,
    conclusion: Type.Union([Type.Literal('passed'), Type.Literal('blocked'), Type.Literal('unsupported')]),
  }),
  blockingEvidence: Type.Optional(Type.Object({
    stage: Type.String({ minLength: 1, maxLength: 200 }),
    diagnosticCode: Type.String({ minLength: 1, maxLength: 200 }),
    observation: SmokeNote,
    unexecutedExternalActions: SmokeNote,
  })),
};

export function assertSmokeRecord<T extends TSchema>(schema: T, value: unknown, message: string): void {
  if (!Value.Check(schema, value)) throw new Error(message);
}
