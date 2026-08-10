import { assertTransition } from '../core/state-machine.js';
import type { ArtifactRef, CandidateRunState, EventEnvelope, RunAttempt, RunManifest, RunOutcome, RunRecord } from '../core/schema.js';
import type { DeliveryReceipt, MessageIdentity, RuntimeStopReason, TargetRunner, TurnSettlement, UserMessage } from '../core/runtime.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const deliveryValues = new Set(['accepted', 'rejected', 'unknown']);
const settlementValues = new Set(['completed', 'failed', 'waiting_input', 'aborted']);

export type CandidateRunPolicy = { turnTimeoutMs: number; maxTargetTurns: number };
type Cleanup = { status: 'released' | 'already_released' };
type Fidelity = RunRecord['fidelity'];
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
  fidelity?: Fidelity;
  /** Artifacts committed before completion, retained in the terminal RunRecord. */
  artifactRefs?: readonly ArtifactRef[];
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
  #stageReached: Exclude<CandidateRunState, 'finalizing' | 'finished'> = 'created';
  #assessment: Assessment | undefined;
  #firstSequence: number | undefined;
  #messages = new Map<string, MessageCall>();

  constructor(input: { runner: TargetRunner; policy: CandidateRunPolicy; release?: () => Promise<Cleanup>; persistence?: CandidateRunPersistence }) {
    assertPolicy(input.policy);
    if (input.persistence?.manifest && input.persistence.manifest.attempt.runId !== input.persistence.attempt.runId) {
      throw new Error('RunManifest must belong to the persisted RunAttempt.');
    }
    this.#runner = input.runner;
    this.#policy = input.policy;
    this.#release = input.release;
    this.#persistence = input.persistence;
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

  async complete(): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    const evidence = await this.#append('controller.done', { decision: 'satisfied' }, 'controller-done');
    this.#assessment = { status: 'apparently_completed', decidedBy: 'controller', evidenceRefs: evidence ? [`event:${evidence.eventId}`] : [] };
    return this.#finish('completed.controller_satisfied', 'completed');
  }

  async cancel(): Promise<CandidateRunState> {
    if (this.#state === 'finished') return this.#state;
    await this.#append('run.cancel_requested', { requestedBy: 'user' }, 'cancel-request');
    return this.#finish('cancelled.user', 'cancelled');
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
    assertReceipt(receipt);
    await this.#append('runtime.delivery_observed', { clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, receipt }, `delivery-${identity.clientMessageId}`);
    if (receipt.delivery === 'rejected') return this.#finish('blocked.input_rejected', 'failed');
    if (receipt.delivery === 'unknown') return this.#finish('uncertain.input_delivery', 'failed');
    this.#turns += 1;
    if (this.#state === 'launching') await this.#move('awaiting_target');
    try {
      const settlement = await Promise.race([
        this.#runner.waitForTurn(),
        timeoutAfter(this.#policy.turnTimeoutMs),
      ]);
      assertSettlement(settlement);
      await this.#append('runtime.turn_settled', settlement, `settlement-${identity.turnIndex}`);
      if (settlement.status !== 'waiting_input' && settlement.status !== 'completed') return this.#finish('failed.runtime', 'failed');
      this.#settledTurns += 1;
      if (this.#turns >= this.#policy.maxTargetTurns) return this.#finish('limit.target_turns', 'failed');
      await this.#move('awaiting_controller');
      return this.#state;
    } catch (error) {
      return this.#finish(isTimeout(error) ? 'limit.turn_timeout' : 'failed.runtime', 'failed', error);
    }
  }

  async #finish(code: string, reason: RuntimeStopReason, cause?: unknown): Promise<CandidateRunState> {
    if (this.#state === 'finished') return this.#state;
    const stageReached = this.#state === 'finalizing' ? this.#stageReached : this.#state;
    this.#stageReached = stageReached;
    await this.#append('run.stop_requested', { code, reason }, `stop-${code}`);
    if (this.#state !== 'finalizing') await this.#move('finalizing');
    const cleanup = await this.#cleanup(reason);
    const termination = terminationFor(code, cause);
    this.#outcome = { task: this.#assessment ?? assessmentFor(code, this.#settledTurns > 0, Boolean(this.#persistence?.manifest)), termination, cleanup };
    const outcomeEvent = await this.#append('run.outcome_created', this.#outcome, 'outcome');
    await this.#move('finished');
    this.#record = this.#buildRecord(outcomeEvent);
    if (this.#record) await this.#append('run.finished', this.#record, 'finished');
    return this.#state;
  }

  async #cleanup(reason: RuntimeStopReason): Promise<RunOutcome['cleanup']> {
    let status: RunOutcome['cleanup']['status'] = 'complete';
    try {
      await this.#runner.stop(reason);
      await this.#append('runtime.stop_completed', { reason }, 'runtime-stop');
    } catch (error) {
      status = 'incomplete';
      await this.#append('runtime.stop_failed', errorFact(error), 'runtime-stop-failed');
    }
    if (this.#release) {
      try {
        await this.#release();
        await this.#append('environment.release_completed', {}, 'environment-release');
      } catch (error) {
        status = 'incomplete';
        await this.#append('environment.release_failed', errorFact(error), 'environment-release-failed');
      }
    }
    return { status, remainingResourceIds: [], evidenceRefs: [] };
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

  #buildRecord(outcomeEvent: RecordedEvent | undefined): RunRecord | undefined {
    if (!this.#persistence || this.#firstSequence === undefined) return undefined;
    const evidenceRefs = outcomeEvent ? [`event:${outcomeEvent.eventId}`] : [];
    const outcome = evidenceRefs.length > 0 && this.#outcome
      ? { ...this.#outcome, cleanup: { ...this.#outcome.cleanup, evidenceRefs } }
      : this.#outcome;
    if (!outcome) throw new Error('CandidateRun outcome was not created.');
    this.#outcome = outcome;
    return {
      attempt: this.#persistence.attempt,
      ...(this.#persistence.manifest ? { manifest: this.#persistence.manifest } : {}),
      state: 'finished',
      stageReached: this.#stageReached,
      outcome,
      fidelity: this.#persistence.fidelity ?? defaultFidelity(this.#persistence.manifest),
      trace: {
        experimentId: this.#persistence.attempt.experimentId,
        runId: this.#persistence.attempt.runId,
        firstSequence: this.#firstSequence,
        lastSequence: this.#persistence.journal.nextSequence(),
      },
      artifactRefs: [...(this.#persistence.artifactRefs ?? [])],
      warnings: [],
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
  if (!ID.test(message.id) || typeof message.text !== 'string' || !ID.test(identity.runId) || !Number.isInteger(identity.turnIndex) || identity.turnIndex < 0 || !ID.test(identity.clientMessageId)) {
    throw new Error('CandidateRun message identity is invalid.');
  }
}

function assertReceipt(receipt: DeliveryReceipt): void {
  if (!receipt || !deliveryValues.has(receipt.delivery) || typeof receipt.evidence !== 'string') throw new Error('Runtime returned an invalid delivery receipt.');
}

function assertSettlement(settlement: TurnSettlement): void {
  if (!settlement || !ID.test(settlement.turnId) || !settlementValues.has(settlement.status) || typeof settlement.observedAt !== 'string') {
    throw new Error('Runtime returned an invalid turn settlement.');
  }
}

function timeoutAfter(milliseconds: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('turn timeout')), milliseconds));
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'turn timeout';
}

function messageFact(message: UserMessage, identity: MessageIdentity): Record<string, unknown> {
  return { messageId: message.id, clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex };
}

function errorFact(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : String(error) };
}

function terminationFor(code: string, cause: unknown): Termination {
  if (code.startsWith('completed.')) return { kind: 'completed', code, initiatedBy: 'controller' };
  if (code.startsWith('limit.')) return { kind: 'limit_reached', code, initiatedBy: 'harness' };
  if (code.startsWith('cancelled.')) return { kind: 'cancelled', code, initiatedBy: 'user' };
  if (code.startsWith('blocked.')) return { kind: 'blocked', code, initiatedBy: 'harness' };
  if (code.startsWith('uncertain.')) return { kind: 'uncertain', code, initiatedBy: 'harness' };
  return { kind: 'failed', code, initiatedBy: 'harness', failure: { origin: 'runtime', code, message: errorFact(cause).message, evidenceRefs: [] } };
}

function assessmentFor(code: string, settled: boolean, hasManifest: boolean): Assessment {
  if (!hasManifest) return { status: 'not_assessed', evidenceRefs: [] };
  if (code.startsWith('limit.') && settled) return { status: 'incomplete', evidenceRefs: [] };
  return { status: settled ? 'indeterminate' : 'not_assessed', evidenceRefs: [] };
}

function defaultFidelity(manifest: RunManifest | undefined): Fidelity {
  return manifest
    ? { environment: 'matched', externalWorld: 'unknown', modelResolution: manifest.resolvedModel.resolved === 'unknown' ? 'unknown' : 'verified', comparisonClass: 'exploratory', reasons: [] }
    : { environment: 'observational', externalWorld: 'unknown', modelResolution: 'unknown', comparisonClass: 'observational', reasons: ['Run manifest was unavailable.'] };
}