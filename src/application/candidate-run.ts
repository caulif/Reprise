import { SAFE_ID } from '../core/identity.js';
import { assertTransition } from '../core/state-machine.js';
import type { ArtifactRef, CandidateRunState, EventEnvelope, RunAttempt, RunManifest, RunOutcome, RunRecord } from '../core/schema.js';
import type { DeliveryReceipt, MessageIdentity, RuntimeFailureKind, RuntimeStopReason, TargetRunner, TurnSettlement, UserMessage } from '../core/runtime.js';

const deliveryValues = new Set(['accepted', 'rejected', 'unknown']);
const settlementValues = new Set(['completed', 'failed', 'waiting_input', 'aborted']);

export type CandidateRunPolicy = { turnTimeoutMs: number; maxTargetTurns: number };
type Cleanup = { status: 'released' | 'already_released' };
type RecordedEvent = Pick<EventEnvelope, 'eventId' | 'sequence'>;
type JournalEvent = { type: string; runId: string; operationId: string; payload: unknown };
type Assessment = RunOutcome['task'];
type Termination = RunOutcome['termination'];

/** The minimal persistence surface CandidateRun needs; ExperimentStore already satisfies it. */
export interface CandidateRunJournal {
  commitAttempt(attempt: RunAttempt, operationId?: string): Promise<RecordedEvent>;
  commitManifest(manifest: RunManifest, operationId?: string): Promise<RecordedEvent>;
  append(event: JournalEvent): Promise<RecordedEvent>;
  nextSequence(): number;
}

export type CandidateRunPersistence = {
  journal: CandidateRunJournal;
  attempt: RunAttempt;
  manifest?: RunManifest;
  /** Artifacts committed before completion, retained in the terminal RunRecord. */
  artifactRefs?: readonly ArtifactRef[];
  /** Runs after the target stops but before the isolated workspace is released. */
  captureArtifacts?: () => Promise<readonly ArtifactRef[]>;
};

type MessageCall = { messageId: string; text: string; promise: Promise<CandidateRunState> };

export class CandidateRun {
  readonly #runner: TargetRunner;
  readonly #policy: CandidateRunPolicy;
  readonly #release: (() => Promise<Cleanup>) | undefined;
  readonly #persistence: CandidateRunPersistence | undefined;
  #state: CandidateRunState = 'created';
  #states: CandidateRunState[] = ['created'];
  #turns = 0;
  #settledTurns = 0;
  #outcome: RunOutcome | undefined;
  #record: RunRecord | undefined;
  #artifactRefs: readonly ArtifactRef[];
  #warnings: RunRecord['warnings'] = [];
  #stageReached: Exclude<CandidateRunState, 'finalizing' | 'finished'> = 'created';
  #assessment: Assessment | undefined;
  #firstSequence: number | undefined;
  #finishing: Promise<CandidateRunState> | undefined;
  #messages = new Map<string, MessageCall>();

  constructor(input: { runner: TargetRunner; policy: CandidateRunPolicy; release?: () => Promise<Cleanup>; persistence?: CandidateRunPersistence }) {
    assertPolicy(input.policy);
    if (input.persistence?.manifest && input.persistence.manifest.attempt.runId !== input.persistence.attempt.runId) {
      throw new Error('RunManifest must belong to the persisted RunAttempt.');
    }
    this.#runner = input.runner;
    this.#runner.setRequestTimeout(input.policy.turnTimeoutMs);
    this.#policy = input.policy;
    this.#release = input.release;
    this.#persistence = input.persistence;
    this.#artifactRefs = [...(input.persistence?.artifactRefs ?? [])];
  }

  states(): readonly CandidateRunState[] { return this.#states; }
  result(): { outcome: RunOutcome; record?: RunRecord } {
    if (!this.#outcome) throw new Error('CandidateRun has not finished.');
    return { outcome: this.#outcome, ...(this.#record ? { record: this.#record } : {}) };
  }

  async start(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    return this.#once(message, identity, () => this.#start(message, identity));
  }

  async submit(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    return this.#once(message, identity, () => this.#submit(message, identity));
  }

  async settleController(reason: 'satisfied' | 'blocked' | 'requires_real_user_decision' | 'no_further_value'): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    const evidence = await this.#append('controller.done', { reason }, 'controller-done');
    if (reason === 'satisfied') {
      this.#assessment = { status: 'apparently_completed', decidedBy: 'controller', evidenceRefs: evidence ? [`event:${evidence.eventId}`] : [] };
      return this.#finish('completed.controller_satisfied', 'completed');
    }
    const code = reason === 'requires_real_user_decision' ? 'blocked.requires_user_decision' : reason === 'blocked' ? 'blocked.controller_done' : 'stalled.controller_no_further_value';
    return this.#finish(code, reason === 'blocked' || reason === 'requires_real_user_decision' ? 'failed' : 'shutdown');
  }

  async failController(failure: { code: string; message: string }): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    await this.#append('controller.failed', failure, 'controller-failed');
    return this.#finish('failed.controller', 'failed', Object.assign(new Error(failure.message), { code: failure.code }));
  }

  /** Opening decision failed before the first Target message; never submit frozen initialInput. */
  async failBeforeStart(failure: { code: string; message: string }): Promise<CandidateRunState> {
    this.#ensure('created');
    if (this.#persistence) this.#track(await this.#persistence.journal.commitAttempt(this.#persistence.attempt));
    await this.#append('controller.failed', failure, 'controller-failed');
    return this.#finish('failed.controller', 'failed', Object.assign(new Error(failure.message), { code: failure.code }));
  }

  async cancel(): Promise<CandidateRunState> {
    if (this.#state === 'finished') return this.#state;
    await this.#append('run.cancel_requested', { requestedBy: 'user' }, 'cancel-request');
    return this.#finish('cancelled.user', 'cancelled');
  }

  async stopByHarness(code: 'limit.controller_calls' | 'limit.wall_clock' | 'stalled.no_progress'): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    await this.#append('harness.stop_requested', { code }, `harness-stop-${code}`);
    return this.#finish(code, 'shutdown');
  }

  async #start(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    this.#ensure('created');
    if (this.#persistence) this.#track(await this.#persistence.journal.commitAttempt(this.#persistence.attempt));
    await this.#move('preparing');
    if (this.#persistence && !this.#persistence.manifest) return this.#finish('blocked.manifest_unavailable', 'failed');
    if (this.#persistence?.manifest) this.#track(await this.#persistence.journal.commitManifest(this.#persistence.manifest));
    await this.#move('launching');
    await this.#append('input.submitted', messageFact(message, identity), `input-${identity.clientMessageId}`);
    try {
      return await this.#advance(await this.#runner.start(message, identity), identity);
    } catch (error) {
      return this.#finish('failed.runtime', 'failed', error);
    }
  }

  async #submit(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    if (identity.turnIndex !== this.#turns) throw new Error('Message identity turn index does not match CandidateRun.');
    await this.#move('awaiting_target');
    await this.#append('input.submitted', messageFact(message, identity), `input-${identity.clientMessageId}`);
    try {
      return await this.#advance(await this.#runner.send(message, identity), identity);
    } catch (error) {
      return this.#finish('failed.runtime', 'failed', error);
    }
  }

  async #advance(receipt: DeliveryReceipt, identity: MessageIdentity): Promise<CandidateRunState> {
    // A terminal cleanup can race an in-flight native turn wait. Its outcome wins.
    if (this.#state === 'finished') return this.#state;
    assertReceipt(receipt);
    await this.#append('runtime.delivery_observed', { clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, receipt }, `delivery-${identity.clientMessageId}`);
    if (receipt.delivery === 'rejected') return this.#finish('blocked.input_rejected', 'failed');
    if (receipt.delivery === 'unknown') return this.#finish('uncertain.input_delivery', 'failed');
    this.#turns += 1;
    if (this.#state === 'launching') await this.#move('awaiting_target');
    try {
      const settlement = await this.#waitForTurn();
      assertSettlement(settlement);
      await this.#append('runtime.turn_settled', settlement, `settlement-${identity.turnIndex}`);
      if (settlement.status !== 'waiting_input' && settlement.status !== 'completed') {
        const mapped = finishFromSettlement(settlement);
        return this.#finish(mapped.code, 'failed', mapped.cause);
      }
      this.#settledTurns += 1;
      if (this.#turns >= this.#policy.maxTargetTurns) return this.#finish('limit.target_turns', 'shutdown');
      await this.#move('awaiting_controller');
      return this.#state;
    } catch (error) {
      return this.#finish(isTimeout(error) ? 'limit.turn_timeout' : 'failed.runtime', 'failed', annotateRuntimeError(error));
    }
  }

  async #finish(code: string, reason: RuntimeStopReason, cause?: unknown): Promise<CandidateRunState> {
    if (this.#state === 'finished') return this.#state;
    if (this.#finishing) return this.#finishing;
    this.#finishing = this.#finishOnce(code, reason, cause);
    return this.#finishing;
  }

  async #finishOnce(code: string, reason: RuntimeStopReason, cause?: unknown): Promise<CandidateRunState> {
    if (this.#state === 'finished') return this.#state;
    const stageReached = this.#state === 'finalizing' ? this.#stageReached : this.#state;
    this.#stageReached = stageReached;
    await this.#append('run.stop_requested', { code, reason }, `stop-${code}`);
    if (this.#state !== 'finalizing') await this.#move('finalizing');
    const cleanup = await this.#cleanup(reason);
    const termination = terminationFor(code, cause);
    this.#outcome = { task: this.#assessment ?? assessmentFor(code, this.#settledTurns > 0, Boolean(this.#persistence?.manifest)), termination, cleanup };
    await this.#append('run.outcome_created', this.#outcome, 'outcome');
    await this.#move('finished');
    this.#record = this.#buildRecord();
    if (this.#record) await this.#append('run.finished', this.#record, 'finished');
    return this.#state;
  }

  async #cleanup(reason: RuntimeStopReason): Promise<RunOutcome['cleanup']> {
    let status: RunOutcome['cleanup']['status'] = 'complete';
    let remainingResourceIds: string[] = [];
    const evidenceRefs: string[] = [];
    const appendCleanup = async (type: string, payload: unknown, operationId: string): Promise<void> => {
      const event = await this.#append(type, payload, operationId);
      if (event) evidenceRefs.push(`event:${event.eventId}`);
    };
    try {
      await this.#runner.stop(reason);
      await appendCleanup('runtime.stop_completed', { reason }, 'runtime-stop');
    } catch (error) {
      status = 'incomplete';
      remainingResourceIds = remainingResources(error);
      await appendCleanup('runtime.stop_failed', { ...errorFact(error), remainingResourceIds }, 'runtime-stop-failed');
    }
    await this.#captureArtifacts();
    if (this.#release) {
      try {
        await this.#release();
        await appendCleanup('environment.release_completed', {}, 'environment-release');
      } catch (error) {
        status = 'incomplete';
        await appendCleanup('environment.release_failed', errorFact(error), 'environment-release-failed');
      }
    }
    return { status, remainingResourceIds, evidenceRefs };
  }

  async #waitForTurn(): Promise<TurnSettlement> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const native = this.#runner.waitForTurn();
    // The abandoned wait must not surface as an unhandled rejection once the race has been decided.
    void native.catch(() => undefined);
    try {
      return await Promise.race([
        native,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error('turn timeout')); }, this.#policy.turnTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (timedOut) this.#runner.cancelWait?.('Harness stopped waiting for this turn.');
    }
  }

  async #captureArtifacts(): Promise<void> {
    if (!this.#persistence?.captureArtifacts) return;
    try {
      this.#artifactRefs = [...this.#artifactRefs, ...await this.#persistence.captureArtifacts()];
    } catch (error) {
      this.#warnings.push({ code: 'artifact.capture_failed', message: errorFact(error).message, evidenceRefs: [] });
    }
  }

  async #append(type: string, payload: unknown, operationId: string): Promise<RecordedEvent | undefined> {
    if (!this.#persistence) return undefined;
    const event = await this.#persistence.journal.append({ type, runId: this.#persistence.attempt.runId, operationId, payload });
    this.#track(event);
    return event;
  }

  async #move(next: CandidateRunState): Promise<void> {
    assertTransition(this.#state, next);
    await this.#append('run.state_changed', { from: this.#state, to: next }, `state-${this.#states.length}`);
    this.#state = next;
    this.#states.push(next);
  }

  #once(message: UserMessage, identity: MessageIdentity, operation: () => Promise<CandidateRunState>): Promise<CandidateRunState> {
    assertMessage(message, identity);
    if (this.#persistence && identity.runId !== this.#persistence.attempt.runId) throw new Error('Message identity does not belong to the persisted RunAttempt.');
    const existing = this.#messages.get(identity.clientMessageId);
    if (existing) {
      if (existing.messageId !== message.id || existing.text !== message.text) throw new Error('clientMessageId was already used with different input.');
      return existing.promise;
    }
    const promise = operation();
    this.#messages.set(identity.clientMessageId, { messageId: message.id, text: message.text, promise });
    return promise;
  }

  #track(event: RecordedEvent): void {
    this.#firstSequence ??= event.sequence;
  }

  #buildRecord(): RunRecord | undefined {
    if (!this.#persistence || this.#firstSequence === undefined) return undefined;
    const outcome = this.#outcome;
    if (!outcome) throw new Error('CandidateRun outcome was not created.');
    return {
      attempt: this.#persistence.attempt,
      ...(this.#persistence.manifest ? { manifest: this.#persistence.manifest } : {}),
      state: 'finished',
      stageReached: this.#stageReached,
      outcome,
      trace: {
        experimentId: this.#persistence.attempt.experimentId,
        runId: this.#persistence.attempt.runId,
        firstSequence: this.#firstSequence,
        lastSequence: this.#persistence.journal.nextSequence(),
      },
      artifactRefs: [...this.#artifactRefs],
      warnings: [...this.#warnings],
    };
  }

  #ensure(expected: CandidateRunState): void {
    if (this.#state !== expected) throw new Error(`CandidateRun is ${this.#state}, expected ${expected}.`);
  }
}

function assertPolicy(policy: CandidateRunPolicy): void {
  if (!Number.isInteger(policy.turnTimeoutMs) || policy.turnTimeoutMs < 1 || !Number.isInteger(policy.maxTargetTurns) || policy.maxTargetTurns < 1) {
    throw new Error('CandidateRun policy must contain positive integer limits.');
  }
}

function assertMessage(message: UserMessage, identity: MessageIdentity): void {
  if (!SAFE_ID.test(message.id) || typeof message.text !== 'string' || !SAFE_ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !SAFE_ID.test(identity.clientMessageId)) {
    throw new Error('CandidateRun message identity is invalid.');
  }
}

function assertReceipt(receipt: DeliveryReceipt): void {
  if (!receipt || !deliveryValues.has(receipt.delivery) || typeof receipt.evidence !== 'string') throw new Error('Runtime returned an invalid delivery receipt.');
}

function assertSettlement(settlement: TurnSettlement): void {
  if (!settlement || !SAFE_ID.test(settlement.turnId) || !settlementValues.has(settlement.status) || typeof settlement.observedAt !== 'string') {
    throw new Error('Runtime returned an invalid turn settlement.');
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'turn timeout';
}

function messageFact(message: UserMessage, identity: MessageIdentity): Record<string, unknown> {
  return { messageId: message.id, clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, text: message.text };
}

function errorFact(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

function remainingResources(error: unknown): string[] {
  if (!error || typeof error !== 'object' || !('remainingResourceIds' in error)) return [];
  const value: unknown = (error as { remainingResourceIds?: unknown }).remainingResourceIds;
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === 'string' && SAFE_ID.test(id));
  return ids.length === value.length ? ids : [];
}

function terminationFor(code: string, cause: unknown): Termination {
  if (code.startsWith('completed.')) return { kind: 'completed', code, initiatedBy: 'controller' };
  if (code.startsWith('limit.')) return { kind: 'limit_reached', code, initiatedBy: 'harness' };
  if (code.startsWith('cancelled.')) return { kind: 'cancelled', code, initiatedBy: 'user' };
  if (code.startsWith('blocked.')) return { kind: 'blocked', code, initiatedBy: 'controller' };
  if (code.startsWith('stalled.')) return { kind: 'stalled', code, initiatedBy: code === 'stalled.controller_no_further_value' ? 'controller' : 'harness' };
  if (code === 'failed.controller') return { kind: 'failed', code, initiatedBy: 'controller', failure: { origin: 'controller', code: 'agent_failure', message: errorFact(cause).message, evidenceRefs: [] } };
  if (code.startsWith('uncertain.')) return { kind: 'uncertain', code, initiatedBy: 'harness' };
  return { kind: 'failed', code, initiatedBy: 'harness', failure: { origin: 'runtime', code: specificFailureCode(code, cause), message: errorFact(cause).message, evidenceRefs: [] } };
}

function finishFromSettlement(settlement: TurnSettlement): { code: string; cause: Error } {
  const specific = runtimeFailureCode(settlement.failure?.kind);
  const message = settlement.failure?.summary ?? `Target turn settled as ${settlement.status}.`;
  return { code: 'failed.runtime', cause: Object.assign(new Error(message), { code: specific }) };
}

function annotateRuntimeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (hasFailureCode(error)) return error;
  const specific = runtimeFailureCode(kindFromThrownMessage(error.message));
  if (specific === 'failed.runtime') return error;
  return Object.assign(error, { code: specific });
}

function specificFailureCode(code: string, cause: unknown): string {
  return hasFailureCode(cause) ? cause.code : code;
}

function runtimeFailureCode(kind: RuntimeFailureKind | undefined): string {
  if (kind === 'upstream') return 'failed.runtime.upstream_unavailable';
  if (kind === 'authentication') return 'failed.runtime.authentication';
  if (kind === 'protocol') return 'failed.runtime.protocol';
  if (kind === 'process') return 'failed.runtime.process';
  return 'failed.runtime';
}

function kindFromThrownMessage(message: string): RuntimeFailureKind | undefined {
  if (/unrecognized turn|invalid json-rpc|protocol error/i.test(message)) return 'protocol';
  if (/app-server exited|process exited|failed to start:|EPIPE/i.test(message)) return 'process';
  if (/HTTP\s*503|\b503\b|temporarily unavailable/i.test(message)) return 'upstream';
  if (/unauthorized|invalid api key|HTTP\s*401/i.test(message)) return 'authentication';
  return undefined;
}

function hasFailureCode(value: unknown): value is { code: string } {
  if (!value || typeof value !== 'object' || !('code' in value)) return false;
  return typeof value.code === 'string' && value.code.length > 0;
}

function assessmentFor(code: string, settled: boolean, hasManifest: boolean): Assessment {
  if (!hasManifest) return { status: 'not_assessed', evidenceRefs: [] };
  if (code.startsWith('limit.') && settled) return { status: 'incomplete', evidenceRefs: [] };
  return { status: settled ? 'indeterminate' : 'not_assessed', evidenceRefs: [] };
}
