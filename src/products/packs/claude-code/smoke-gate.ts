import { Type, type Static } from '@sinclair/typebox';
import {
  assertSmokeRecord,
  commonSmokeMissing,
  smokeAcceptanceShared,
  type CommonSmokeGateInput,
} from '../../shared/smoke-record.js';

export type ClaudeSmokeGateInput = CommonSmokeGateInput & {
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
  const missing = commonSmokeMissing(input);
  if (!input.permissionModeConfirmed) missing.push('bypassPermissions must be set and --permission-prompt-tool must not be passed.');
  if (!input.outOfWorkspaceToolsDisabled) missing.push('Cron*, ScheduleWakeup, and SendMessage must be disallowed.');
  if (!input.sessionPollutionHandled) missing.push('Session pollution must be handled with --no-session-persistence and discovery cwd exclusion.');
  if (!input.initSnapshotRecorded) missing.push('system/init must be archived as ExecutionRuntimeFingerprint.observableConfig.');
  return { allowed: missing.length === 0, missing };
}

export const ClaudeSmokeAcceptanceRecordSchema = Type.Object({
  ...smokeAcceptanceShared,
  catalogListed: Type.Boolean(),
  actuallyRan: Type.Boolean(),
  permissionModeConfirmed: Type.Boolean(),
  outOfWorkspaceToolsDisabled: Type.Boolean(),
  sessionPollutionHandled: Type.Boolean(),
  initSnapshotRecorded: Type.Boolean(),
});
export type ClaudeSmokeAcceptanceRecord = Static<typeof ClaudeSmokeAcceptanceRecordSchema>;

export function assertClaudeSmokeAcceptanceRecord(value: unknown): asserts value is ClaudeSmokeAcceptanceRecord {
  assertSmokeRecord(ClaudeSmokeAcceptanceRecordSchema, value, 'Invalid Claude Code smoke acceptance record.');
}
