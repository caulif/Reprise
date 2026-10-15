import { join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RunAttemptSchema, RunStartupFailureSchema, RunCleanupFailureSchema, type RunAttempt, type RunStartupFailure, type RunCleanupFailure } from '../core/schema.js';
import { ExperimentStore, writeImmutableJson } from '../infrastructure/store/experiment-store.js';
import { safeAgentFailureText } from '../infrastructure/agent/failure.js';
import { runOperationId } from '../core/identity.js';
import { assertIds, assertPaths, persistTaskCase } from './experiment-helpers.js';
import { snapshotTaskCase } from '../products/shared/task-case-reader.js';
import { readExperimentMetadata, assertExperimentTaskIdentity, fixedExperimentSpec } from './experiment-metadata.js';
import { persistExperimentSpec } from './experiment-layout.js';
import type { TaskCase } from '../core/schema.js';
import type { ExperimentInput } from './experiment.js';
import { frozenSnapshot } from '../core/json.js';

type Admission = Pick<ExperimentInput, 'dataDir' | 'sourceRoot' | 'experimentId' | 'runId' | 'caseId' | 'taskCase' | 'candidate' | 'policy' | 'now' | 'onEvent'>;
export type CleanupFailure = { resource: string; error: unknown };
function startupErrorFact(error: unknown): { name: string; message: string } {
  const message = error instanceof AggregateError
    ? [error.message, ...(error.errors as unknown[]).map(item => startupErrorFact(item).message)].join('; ')
    : error instanceof Error ? String(error.message) : String(error);
  return { name: safeAgentFailureText(error instanceof Error ? String(error.name) : 'unknown'),
    message: safeAgentFailureText(message).slice(0, 4096) };
}
export function throwFailures(errors: readonly [unknown, ...unknown[]], message: string): never;
export function throwFailures(errors: readonly unknown[], message: string): void;
export function throwFailures(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message, { cause: errors[0] });
}
export async function cleanupOperation(failures: CleanupFailure[], resource: string, operation: () => Promise<unknown>): Promise<void> {
  try { await operation(); } catch (error) { failures.push({ resource, error }); }
}

export class ExperimentStartup {
  stage = 'activity';
  private constructor(readonly root: string, readonly store: ExperimentStore, readonly attempt: RunAttempt, readonly taskCase: TaskCase, readonly unsubscribe?: () => void) {}

  static async admit(input: Admission): Promise<ExperimentStartup> {
    input = { ...input };
    assertIds(input);
    assertPaths(input.dataDir, input.sourceRoot);
    const taskCase = snapshotTaskCase(input.taskCase);
    if (taskCase.caseId !== input.caseId) throw new Error('Experiment caseId must match TaskCase.caseId.');
    const attempt: RunAttempt = frozenSnapshot({ schemaVersion: 1, experimentId: input.experimentId, runId: input.runId,
      caseId: input.caseId, candidate: input.candidate, policy: input.policy, createdAt: input.now });
    if (!Value.Check(RunAttemptSchema, attempt)) throw new Error('Invalid startup RunAttempt.');
    const root = join(resolve(input.dataDir), 'experiments', input.experimentId);
    const store = await ExperimentStore.open(root, input.experimentId);
    let unsubscribe: (() => void) | undefined;
    try {
      await store.acquireWriter();
      if (store.events(input.runId).some(event => event.type === 'run.attempt_created')) throw new Error(`Run ${input.runId} already exists; use a new run ID.`);
      const metadata = await readExperimentMetadata(join(root, 'experiment.json'), input.experimentId);
      if (metadata.kind === 'current' || metadata.kind === 'legacy') assertExperimentTaskIdentity(metadata.value.spec, taskCase);
      else if (metadata.kind !== 'missing') throw new Error(`Experiment admission rejected: ${metadata.diagnostic}.`);
      await persistTaskCase(join(resolve(input.dataDir), 'cases', input.caseId, 'case.json'), taskCase);
      await persistExperimentSpec(root, fixedExperimentSpec(input.experimentId, taskCase));
      unsubscribe = input.onEvent ? store.subscribe(input.onEvent) : undefined;
      await store.commitAttempt(attempt);
    } catch (error) {
      const cleanup: CleanupFailure[] = [];
      unsubscribe?.();
      await cleanupOperation(cleanup, 'store_close', () => store.close());
      throwFailures([error, ...cleanup.map(item => item.error)], 'Startup admission and cleanup failed.');
    }
    return new ExperimentStartup(root, store, attempt, taskCase, unsubscribe);
  }

  async fail(error: unknown, cancelled: boolean, cleanup: readonly CleanupFailure[] = [], cancellationSource?: 'user' | 'supervisor' | 'budget'): Promise<void> {
    const failure: RunStartupFailure = { schemaVersion: 1, experimentId: this.attempt.experimentId, runId: this.attempt.runId,
      caseId: this.attempt.caseId, stage: this.stage, status: cancelled ? 'cancelled' : 'failed', error: startupErrorFact(error),
      cleanupErrors: cleanup.map(item => ({ resource: item.resource, error: startupErrorFact(item.error) })), recordedAt: new Date().toISOString(),
      ...(cancelled && cancellationSource ? { cancellationSource } : {}) };
    if (!Value.Check(RunStartupFailureSchema, failure)) throw new Error('Invalid startup failure.');
    await writeImmutableJson(join(this.root, 'runs', this.attempt.runId, 'startup-failure.json'), failure);
    await this.store.append({ type: 'run.startup_failed', runId: this.attempt.runId,
      operationId: runOperationId(this.attempt.runId, 'startup-failed'), payload: failure });
  }

  async close(cleanup: CleanupFailure[]): Promise<void> {
    const audit = async (item: CleanupFailure) => {
      const fact: RunCleanupFailure = { schemaVersion: 1, experimentId: this.attempt.experimentId, runId: this.attempt.runId,
        caseId: this.attempt.caseId, resource: item.resource, error: startupErrorFact(item.error), recordedAt: new Date().toISOString() };
      if (!Value.Check(RunCleanupFailureSchema, fact)) throw new Error('Invalid cleanup failure.');
      try { await this.store.append({ type: 'run.cleanup_failed', runId: this.attempt.runId, payload: fact }); }
      catch (error) { cleanup.push({ resource: 'cleanup_audit', error }); }
    };
    for (const item of cleanup.slice()) await audit(item);
    this.unsubscribe?.();
    const beforeClose = cleanup.length;
    await cleanupOperation(cleanup, 'store_close', () => this.store.close());
    // A failed close may retain the original writer; if it cannot append, the caller receives both failures.
    if (cleanup.length > beforeClose) await audit(cleanup[beforeClose]!);
  }
}
