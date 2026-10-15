import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ComparisonOperationFailureSchema, ComparisonInvocationSchema, type ComparisonOperationFailure } from '../core/schema.js';
import { safeAgentFailureText } from '../infrastructure/agent/failure.js';
import { writeImmutableJson, type ExperimentStore } from '../infrastructure/store/experiment-store.js';
import { newComparisonAttempt } from './comparison-briefing.js';

export async function reserveComparisonOperation(store: ExperimentStore, experimentRoot: string, runId: string): Promise<ReturnType<typeof newComparisonAttempt>> {
  const attempt = newComparisonAttempt(experimentRoot);
  await store.append({ type: 'comparison.started', runId, operationId: `comparison-started-${attempt.attemptId}`,
    payload: { attemptId: attempt.attemptId, phase: 'preparation' } });
  return attempt;
}

export async function failComparisonOperation(store: ExperimentStore, attemptRoot: string,
  owner: Omit<ComparisonOperationFailure, 'schemaVersion' | 'error'>, error: unknown): Promise<void> {
  const fact = { schemaVersion: 1 as const, ...owner, error: {
    name: safeAgentFailureText(error instanceof Error ? error.name : 'unknown'),
    message: safeAgentFailureText(error instanceof Error ? error.message : String(error)),
  } };
  if (!Value.Check(ComparisonOperationFailureSchema, fact)) throw new Error('Invalid Comparison operation failure.');
  await writeImmutableJson(join(attemptRoot, 'operation-failure.json'), fact);
  await store.append({ type: 'comparison.operation_failed', runId: owner.runId, payload: fact });
  const result = owner.status === 'cancelled' ? { status: 'cancelled' as const }
    : { status: 'failed' as const, failure: { code: error instanceof Error && error.name === 'HarnessProbeError' ? 'provider_failure' as const : 'agent_failure' as const,
      message: fact.error.message, attempts: 0 } };
  if (!Value.Check(ComparisonInvocationSchema, result)) throw new Error('Invalid Comparison preparation result.');
  await store.append({ type: 'comparison.completed', runId: owner.runId, payload: { attemptId: owner.attemptId, ...result } });
}
