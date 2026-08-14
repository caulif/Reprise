import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export type ClaudeSmokeGateInput = {
  taskCaseReady: boolean;
  isolatedWorkspace: boolean;
  noIrreversibleActions: boolean;
  accountConfirmed: boolean;
  networkConfirmed: boolean;
  costLimit: string;
  maxWallClockMs: number;
  permissionModeConfirmed: boolean;
  outOfWorkspaceToolsDisabled: boolean;
  sessionPollutionHandled: boolean;
  initSnapshotRecorded: boolean;
};

export type ClaudeSmokeGateResult = {
  allowed: boolean;
  missing: readonly string[];
};

export function checkClaudeSmokeGate(input: ClaudeSmokeGateInput): ClaudeSmokeGateResult {
  const missing: string[] = [];
  if (!input.taskCaseReady) missing.push('TaskCase and executable input are not ready.');
  if (!input.isolatedWorkspace) missing.push('The workspace is not proven isolated.');
  if (!input.noIrreversibleActions) missing.push('The task still contains an irreversible action.');
  if (!input.accountConfirmed) missing.push('The Runtime account is not confirmed.');
  if (!input.networkConfirmed) missing.push('Network permission is not confirmed.');
  if (!input.costLimit.trim()) missing.push('A cost limit is required.');
  if (!Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs < 1) missing.push('A positive maximum wall clock is required.');
  if (!input.permissionModeConfirmed) missing.push('bypassPermissions must be set and --permission-prompt-tool must not be passed.');
  if (!input.outOfWorkspaceToolsDisabled) missing.push('Cron*, ScheduleWakeup, and SendMessage must be disallowed.');
  if (!input.sessionPollutionHandled) missing.push('Session pollution must be handled with --no-session-persistence and discovery cwd exclusion.');
  if (!input.initSnapshotRecorded) missing.push('system/init must be archived as ExecutionRuntimeFingerprint.observableConfig.');
  return { allowed: missing.length === 0, missing };
}

const Id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' });
const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' });
const Note = Type.String({ maxLength: 4_000 });

export const ClaudeSmokeAcceptanceRecordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  status: Type.Union([Type.Literal('passed'), Type.Literal('blocked'), Type.Literal('unsupported')]),
  recordedAt: Timestamp,
  taskCaseId: Id,
  experimentId: Id,
  runId: Id,
  executable: Type.String({ minLength: 1, maxLength: 4_000 }),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  requestedModel: Type.String({ minLength: 1, maxLength: 200 }),
  resolvedModel: Type.String({ minLength: 1, maxLength: 200 }),
  catalogListed: Type.Boolean(),
  actuallyRan: Type.Boolean(),
  permissionModeConfirmed: Type.Boolean(),
  outOfWorkspaceToolsDisabled: Type.Boolean(),
  sessionPollutionHandled: Type.Boolean(),
  initSnapshotRecorded: Type.Boolean(),
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
    rawEvidence: Note,
    artifacts: Note,
    traceAndReport: Note,
    knownLimitations: Note,
    conclusion: Type.Union([Type.Literal('passed'), Type.Literal('blocked'), Type.Literal('unsupported')]),
  }),
  blockingEvidence: Type.Optional(Type.Object({
    stage: Type.String({ minLength: 1, maxLength: 200 }),
    diagnosticCode: Type.String({ minLength: 1, maxLength: 200 }),
    observation: Note,
    unexecutedExternalActions: Note,
  })),
});
export type ClaudeSmokeAcceptanceRecord = Static<typeof ClaudeSmokeAcceptanceRecordSchema>;

export function assertClaudeSmokeAcceptanceRecord(value: unknown): asserts value is ClaudeSmokeAcceptanceRecord {
  if (!Value.Check(ClaudeSmokeAcceptanceRecordSchema, value)) throw new Error('Invalid Claude Code smoke acceptance record.');
}
