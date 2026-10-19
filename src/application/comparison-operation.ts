import { join } from 'node:path';
import type { AgentLocale } from '../agents/language.js';
import { Value } from '@sinclair/typebox/value';
import { ComparisonOperationFailureSchema, ComparisonInvocationSchema, HarnessConfigurationBoundSchema,
  type ComparisonOperationFailure, type HarnessConfigurationReference } from '../core/schema.js';
import { canonicalJson } from '../core/task-case-identity.js';
import { safeAgentFailureText } from '../infrastructure/agent/failure.js';
import { writeImmutableJson, type ExperimentStore } from '../infrastructure/store/experiment-store.js';
import { newComparisonAttempt } from './comparison-briefing.js';
import { harnessConfigurationScope, type HarnessConfigurationScope } from './harness-configuration.js';
import { cleanupOperation, throwFailures, type CleanupFailure } from './experiment-startup.js';

export async function prepareComparisonConfiguration(input: {
  store: ExperimentStore; runId: string; attemptId: string; attemptRoot: string; locale: AgentLocale;
  reference: HarnessConfigurationReference | undefined; signal: AbortSignal | undefined;
}): Promise<void> {
  try {
    await bindComparisonAttemptConfiguration(input.store, input.runId, input.attemptId, input.locale, input.reference);
  } catch (error) {
    const failures: CleanupFailure[] = [];
    await cleanupOperation(failures, 'comparison_failure_audit', () => failComparisonOperation(input.store, input.attemptRoot, {
      experimentId: input.store.experimentId, runId: input.runId, attemptId: input.attemptId, stage: 'agents',
      status: input.signal?.aborted ? 'cancelled' : 'failed',
    }, error));
    throwFailures([error, ...failures.map(failure => failure.error)], 'Comparison configuration and failure audit failed.');
  }
}

export function comparisonConfigurationScope(store: ExperimentStore, runId: string, attemptId: string, locale: AgentLocale,
  onBound?: (reference: HarnessConfigurationReference) => void): HarnessConfigurationScope {
  const scope = harnessConfigurationScope(store, { experimentId: store.experimentId, runId,
    operation: 'comparison', comparisonAttemptId: attemptId }, onBound);
  return { bind: configuration => scope.bind({ ...configuration, locale }) };
}

export async function bindComparisonAttemptConfiguration(store: ExperimentStore, runId: string, attemptId: string,
  locale: AgentLocale, reference: HarnessConfigurationReference | undefined): Promise<void> {
  if (!reference) return;
  if (reference.operation === 'recovery' || (reference.operation === 'comparison' && reference.comparisonAttemptId !== attemptId)) {
    throw new Error('Comparison configuration belongs to a different operation.');
  }
  const bound = store.events(runId).find(event => event.type === 'harness.configuration_bound'
    && Value.Check(HarnessConfigurationBoundSchema, event.payload)
    && canonicalJson(event.payload.reference) === canonicalJson(reference));
  if (!bound || !Value.Check(HarnessConfigurationBoundSchema, bound.payload)) throw new Error('Comparison requires its committed Harness configuration.');
  const { configuration } = bound.payload;
  if (reference.operation === 'comparison' && reference.comparisonAttemptId === attemptId && configuration.locale === locale) return;
  await comparisonConfigurationScope(store, runId, attemptId, locale).bind(configuration);
}

export async function reserveComparisonOperation(store: ExperimentStore, experimentRoot: string, runId: string, locale?: AgentLocale): Promise<ReturnType<typeof newComparisonAttempt>> {
  const attempt = newComparisonAttempt(experimentRoot, locale);
  await store.append({ type: 'comparison.started', runId, operationId: `comparison-started-${attempt.attemptId}`,
    payload: { attemptId: attempt.attemptId, phase: 'preparation', ...(locale ? { locale } : {}) } });
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
