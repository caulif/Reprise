import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  RecoveryEvaluationPreflightSchema,
  type RecoveryEvaluationPreflight,
} from '../../core/schema.js';
import { writeAtomic } from '../../core/identity.js';

export type RecoveryPreflightCaller = { validate(): Promise<unknown> };
export type RecoveryPreflightInput = {
  readonly providerId: string;
  readonly modelId: string;
  readonly caller: RecoveryPreflightCaller;
};

type PreflightReason = NonNullable<RecoveryEvaluationPreflight['reasonCode']>;

/** Runs one real connection check and returns only schema-safe, non-secret facts. */
export async function runRecoveryPreflight(
  input: RecoveryPreflightInput,
  now: () => string = () => new Date().toISOString(),
): Promise<RecoveryEvaluationPreflight> {
  const identity = { providerId: input.providerId, modelId: input.modelId, checkedAt: now(), operation: 'preflight.validate' };
  try {
    const shape = { schemaVersion: 1, status: 'passed' as const, outcome: 'ready' as const, providerReachable: true, modelAccepted: true, toolRoundTrip: true, retryable: false, ...identity };
    if (!Value.Check(RecoveryEvaluationPreflightSchema, shape)) return failed(identity, 'configuration_invalid');
    await input.caller.validate();
    return checked(shape);
  } catch (error) {
    return checked(failed(identity, classifyReason(error)));
  }
}

/** Writes a preflight record atomically; the record is validated before it crosses the disk boundary. */
export async function persistRecoveryPreflight(path: string, record: RecoveryEvaluationPreflight): Promise<void> {
  if (!Value.Check(RecoveryEvaluationPreflightSchema, record)) throw new Error('Recovery preflight record is invalid.');
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(record)}\n`);
}

function failed(
  identity: Pick<RecoveryEvaluationPreflight, 'providerId' | 'modelId' | 'checkedAt' | 'operation'>,
  reasonCode: PreflightReason,
): RecoveryEvaluationPreflight {
  const providerReachable = reasonCode !== 'endpoint_invalid' && reasonCode !== 'authentication_failed';
  const modelAccepted = providerReachable && reasonCode !== 'model_unavailable';
  return { schemaVersion: 1, status: 'failed', outcome: 'blocked_before_sampling', failureCode: 'preflight_failed', reasonCode, providerReachable, modelAccepted, toolRoundTrip: false, retryable: reasonCode === 'endpoint_invalid' || reasonCode === 'timed_out' || reasonCode === 'request_failed', ...identity };
}

function checked(record: RecoveryEvaluationPreflight): RecoveryEvaluationPreflight {
  if (!Value.Check(RecoveryEvaluationPreflightSchema, record)) throw new Error('Recovery preflight result is invalid.');
  return record;
}

function classifyReason(error: unknown): PreflightReason {
  const value = error as { readonly preflightReason?: unknown; readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
  if (isReason(value.preflightReason)) return value.preflightReason;
  const text = `${textValue(value.name)} ${textValue(value.code)} ${textValue(value.message)}`.toLowerCase();
  if (/auth|credential|api key|unauthori|forbidden|401|403/.test(text)) return 'authentication_failed';
  if (/model.*(not found|unknown|invalid|reject)|invalid.*model|unsupported.*model/.test(text)) return 'model_unavailable';
  if (/timeout|timed out|abort|deadline/.test(text)) return 'timed_out';
  if (/endpoint|base.?url|url|connect|dns|enotfound|econnrefused/.test(text)) return 'endpoint_invalid';
  return 'request_failed';
}

function textValue(value: unknown): string { return typeof value === 'string' ? value : ''; }

function isReason(value: unknown): value is PreflightReason {
  return value === 'authentication_failed' || value === 'endpoint_invalid' || value === 'model_unavailable'
    || value === 'timed_out' || value === 'request_failed' || value === 'configuration_invalid';
}
