import { SAFE_ID } from '../core/identity.js';
import { assertTransition } from '../core/state-machine.js';
import type { ArtifactRef, CandidateRunState, CandidateSessionHandle, EventEnvelope, RunAttempt, RunManifest, RunOutcome, RunRecord } from '../core/schema.js';
import { isCandidateRuntimeJournalType, type DeliveryReceipt, type MessageIdentity, type RuntimeStopReason, type TargetRunner, type TurnSettlement, type UserMessage } from '../core/runtime.js';
import { cleanupCandidateRun, DEFAULT_CLEANUP_TIMEOUT_MS } from './candidate-run-cleanup.js';
import { appendCandidateRuntimeEvent } from './candidate-run-events.js';
import {
  annotateRuntimeError,
  assessmentFor,
  errorFact,
  finishFromSettlement,
  messageFact,
  terminationFor,
} from './candidate-run-facts.js';

const deliveryValues = new Set(['accepted', 'rejected', 'unknown']);
const settlementValues = new Set(['completed', 'failed', 'waiting_input', 'aborted']);

export type CandidateRunPolicy = { turnTimeoutMs: number; maxTargetTurns: number; cleanupTimeoutMs?: number };
type Cleanup = { status: 'released' | 'already_released' };
type RecordedEvent = Pick<EventEnvelope, 'eventId' | 'sequence'>;
type JournalEvent = { type: string; runId: string; operationId?: string; payload: unknown; occurredAt?: string };
type Assessment = RunOutcome['task'];

/** The minimal persistence surface CandidateRun needs; ExperimentStore already satisfies it. */
export interface CandidateRunJournal {
  commitAttempt(attempt: RunAttempt, operationId?: string): Promise<RecordedEvent>;
  commitManifest(manifest: RunManifest, operationId?: string): Promise<RecordedEvent>;
  append(event: JournalEvent): Promise<EventEnvelope>;
  nextSequence(): number;
  events(runId: string): readonly EventEnvelope[];
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
  #handle: CandidateSessionHandle | undefined;

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
  session(): CandidateSessionHandle {
    if (!this.#handle) throw new Error('CandidateRun has not bound a session.');
    return this.#handle;
  }
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
    this.#assessment = { status: 'incomplete', decidedBy: 'controller', evidenceRefs: evidence ? [`event:${evidence.eventId}`] : [] };
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
    if (this.#finishing) return this.#finishing;
    await this.#append('run.cancel_requested', { requestedBy: 'user' }, 'cancel-request');
    if (this.#finishing) return this.#finishing;
    return this.#finish('cancelled.user', 'cancelled');
  }

  async stopByHarness(code: 'limit.controller_calls' | 'limit.wall_clock' | 'stalled.no_progress'): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    await this.#append('harness.stop_requested', { code }, `harness-stop-${code}`);
    return this.#finish(code, 'shutdown');
  }

  async #start(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    this.#ensure('created');
    this.#assertIdentity(identity);
    if (this.#persistence) this.#track(await this.#persistence.journal.commitAttempt(this.#persistence.attempt));
    await this.#move('preparing');
    if (this.#persistence && !this.#persistence.manifest) return this.#finish('blocked.manifest_unavailable', 'failed');
    if (this.#persistence?.manifest) this.#track(await this.#persistence.journal.commitManifest(this.#persistence.manifest));
    await this.#move('launching');
    await this.#append('input.submitted', messageFact(message, identity), `input-${identity.clientMessageId}`);
    if (this.#finishing) return this.#finishing;
    try {
      const receipt = await this.#runner.start(message, identity);
      this.#handle = this.#runner.session();
      this.#assertHandle();
      await this.#append('runtime.session_started', { sessionId: this.#handle.sessionId, productId: this.#handle.productId }, 'session-started');
      await this.#append('candidate.session_bound', this.#handle, 'session-bound');
      return await this.#advance(receipt, identity);
    } catch (error) {
      return this.#finish('failed.runtime', 'failed', error);
    }
  }

  async #submit(message: UserMessage, identity: MessageIdentity): Promise<CandidateRunState> {
    this.#ensure('awaiting_controller');
    this.#assertIdentity(identity);
    if (identity.turnIndex !== this.#turns) throw new Error('Message identity turn index does not match CandidateRun.');
    await this.#move('awaiting_target');
    await this.#append('input.submitted', messageFact(message, identity), `input-${identity.clientMessageId}`);
    if (this.#finishing) return this.#finishing;
    try {
      return await this.#advance(await this.#runner.send(message, identity), identity);
    } catch (error) {
      return this.#finish('failed.runtime', 'failed', error);
    }
  }

  async #advance(receipt: DeliveryReceipt, identity: MessageIdentity): Promise<CandidateRunState> {
    // A terminal cleanup can race an in-flight native turn wait. Its outcome wins.
    if (this.#finishing) return this.#finishing;
    assertReceipt(receipt);
    await this.#append('runtime.delivery_observed', { clientMessageId: identity.clientMessageId, turnIndex: identity.turnIndex, receipt }, `delivery-${identity.clientMessageId}`);
    if (this.#finishing) return this.#finishing;
    if (receipt.delivery === 'rejected') return this.#finish('blocked.input_rejected', 'failed');
    if (receipt.delivery === 'unknown') return this.#finish('uncertain.input_delivery', 'failed');
    this.#turns += 1;
    if (this.#state === 'launching') await this.#move('awaiting_target');
    try {
      const settlement = await this.#waitForTurn();
      if (this.#finishing) return this.#finishing;
      assertSettlement(settlement);
      await this.#append('runtime.turn_settled', settlement, `settlement-${identity.turnIndex}`);
      if (this.#finishing) return this.#finishing;
      if (settlement.status !== 'waiting_input' && settlement.status !== 'completed') {
        const mapped = finishFromSettlement(settlement);
        return this.#finish(mapped.code, 'failed', mapped.cause);
      }
      this.#settledTurns += 1;
      if (this.#turns >= this.#policy.maxTargetTurns) return this.#finish('limit.target_turns', 'shutdown');
      await this.#move('awaiting_controller');
      return this.#state;
    } catch (error) {
      if (this.#finishing) return this.#finishing;
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
    const cleanup = await cleanupCandidateRun(reason, {
      runner: this.#runner,
      ...(this.#release ? { release: this.#release } : {}),
      timeoutMs: this.#policy.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
      appendCleanup: async (type, payload, operationId) => {
        const event = await this.#append(type, payload, operationId);
        return event?.eventId;
      },
      captureArtifacts: () => this.#captureArtifacts(),
    });
    const termination = terminationFor(code, cause);
    this.#outcome = { task: this.#assessment ?? assessmentFor(code, this.#settledTurns > 0, Boolean(this.#persistence?.manifest)), termination, cleanup };
    await this.#append('run.outcome_created', this.#outcome, 'outcome');
    await this.#move('finished');
    this.#record = this.#buildRecord();
    if (this.#record) await this.#append('run.finished', this.#record, 'finished');
    return this.#state;
  }

  #assertHandle(): void {
    if (!this.#handle?.sessionId) throw new Error('TargetRunner.session() did not return a sessionId.');
  }

  #assertIdentity(identity: MessageIdentity): void {
    if (this.#persistence && identity.runId !== this.#persistence.attempt.runId) {
      throw new Error('Message identity runId does not match CandidateRun.');
    }
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
      if (timedOut) this.#runner.cancelWait('Harness stopped waiting for this turn.');
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
    if (isCandidateRuntimeJournalType(type)) {
      const event = await appendCandidateRuntimeEvent({
        journal: this.#persistence.journal,
        runId: this.#persistence.attempt.runId,
        sessionId: this.#handle?.sessionId ?? 'unstarted',
        type,
        payload,
        operationId,
      });
      this.#track(event);
      return event;
    }
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
      ...(this.#handle ? { session: this.#handle } : {}),
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
  if (policy.cleanupTimeoutMs !== undefined && (!Number.isInteger(policy.cleanupTimeoutMs) || policy.cleanupTimeoutMs < 1)) {
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

