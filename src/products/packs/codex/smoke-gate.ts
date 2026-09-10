import { Type, type Static } from '@sinclair/typebox';
import {
  assertSmokeRecord,
  commonSmokeMissing,
  smokeAcceptanceShared,
  type CommonSmokeGateInput,
} from '../../shared/smoke-record.js';

export type CodexSmokeGateInput = CommonSmokeGateInput;

export type CodexSmokeGateResult = {
  allowed: boolean;
  missing: readonly string[];
};

export function checkCodexSmokeGate(input: CodexSmokeGateInput): CodexSmokeGateResult {
  const missing = commonSmokeMissing(input);
  return { allowed: missing.length === 0, missing };
}

// ponytail: keep the manual acceptance artifact product-specific; Core only stores runtime facts.
export const CodexSmokeAcceptanceRecordSchema = Type.Object(smokeAcceptanceShared);
export type CodexSmokeAcceptanceRecord = Static<typeof CodexSmokeAcceptanceRecordSchema>;

/** Validates operator-supplied smoke facts before they enter the experiment directory. */
export function assertCodexSmokeAcceptanceRecord(value: unknown): asserts value is CodexSmokeAcceptanceRecord {
  assertSmokeRecord(CodexSmokeAcceptanceRecordSchema, value, 'Invalid Codex smoke acceptance record.');
}
