import type { CandidateRunState, EventEnvelope } from '../core/schema.js';
import { record, text } from '../core/json.js';
import { candidateRunPhaseFromEvent, candidateRunDisplayFromEvents, isCandidateRunState, type CandidateRunPhase } from '../application/candidate-run-phase.js';
import { applyPhaseClockEvent, eventActivityRole, isVisibleActivityEvent, shouldApplyLivePhase, type ClockScope, type PhaseClockBounds } from './phase-state.js';
import type { PreparePhase } from './widgets.js';

type Diagnostics = {
  readonly runPhase: CandidateRunPhase | undefined;
  readonly machineState: CandidateRunState | undefined;
  readonly runFailed: boolean;
  readonly cleanupStatus: string | undefined;
  readonly lastRuntimeEventAt: string | undefined;
  readonly lastObservedEventAt: string | undefined;
  readonly lastVisibleActivityAt: string | undefined;
  readonly lastRuntimeEventKind: string | undefined;
  readonly modelOutputSeen: boolean;
  readonly reconnectCount: number;
  readonly reconnectTotal: number;
  readonly comparisonAttemptId: string | undefined;
};

type Clocks = {
  readonly runStartedAt: number;
  readonly recoveryStartedAt: number;
  readonly recoveryEndedAt: number;
  readonly candidateStartedAt: number;
  readonly candidateEndedAt: number;
  readonly comparisonStartedAt: number;
  readonly comparisonEndedAt: number;
};

function emptyDiagnostics(): Diagnostics {
  return { runPhase: undefined, machineState: undefined, runFailed: false, cleanupStatus: undefined,
    lastRuntimeEventAt: undefined, lastObservedEventAt: undefined, lastVisibleActivityAt: undefined,
    lastRuntimeEventKind: undefined, modelOutputSeen: false, reconnectCount: 0, reconnectTotal: 0,
    comparisonAttemptId: undefined };
}

function emptyClocks(): Clocks {
  return { runStartedAt: 0, recoveryStartedAt: 0, recoveryEndedAt: 0, candidateStartedAt: 0,
    candidateEndedAt: 0, comparisonStartedAt: 0, comparisonEndedAt: 0 };
}

function clockBounds(state: Clocks): PhaseClockBounds {
  return {
    ...(state.recoveryStartedAt ? { recoveryStartedAt: state.recoveryStartedAt } : {}),
    ...(state.recoveryEndedAt ? { recoveryEndedAt: state.recoveryEndedAt } : {}),
    ...(state.candidateStartedAt ? { candidateStartedAt: state.candidateStartedAt } : {}),
    ...(state.candidateEndedAt ? { candidateEndedAt: state.candidateEndedAt } : {}),
    ...(state.comparisonStartedAt ? { comparisonStartedAt: state.comparisonStartedAt } : {}),
    ...(state.comparisonEndedAt ? { comparisonEndedAt: state.comparisonEndedAt } : {}),
  };
}

export class RunDiagnostics {
  #state: Diagnostics & Clocks = { ...emptyDiagnostics(), ...emptyClocks() };

  get state(): Diagnostics & Clocks { return this.#state; }

  reset(): void { this.#state = { ...emptyDiagnostics(), ...emptyClocks() }; }

  beginPhase(phase: 'recovery' | 'candidate_starting'): void {
    this.#state = { ...this.#state, ...emptyDiagnostics(), runPhase: phase };
  }

  startClock(scope: ClockScope, now: number): void {
    this.#state = { ...this.#state, runStartedAt: now,
      [`${scope}StartedAt`]: now, [`${scope}EndedAt`]: 0 };
  }

  freezeClock(scope: ClockScope, now: number): void {
    const key = `${scope}EndedAt` as const;
    if (!this.#state[key]) this.#state = { ...this.#state, [key]: now };
  }

  observe(event: EventEnvelope, preparePhase: PreparePhase | undefined): void {
    const next = { ...this.#state, lastObservedEventAt: event.occurredAt,
      lastRuntimeEventAt: event.occurredAt, lastRuntimeEventKind: event.type };
    if (event.type === 'comparison.started') {
      const attemptId = text(record(event.payload).attemptId);
      if (attemptId) next.comparisonAttemptId = attemptId;
    }
    const bounds = applyPhaseClockEvent(clockBounds(next), event);
    next.recoveryStartedAt = bounds.recoveryStartedAt ?? 0;
    next.recoveryEndedAt = bounds.recoveryEndedAt ?? 0;
    next.candidateStartedAt = bounds.candidateStartedAt ?? 0;
    next.candidateEndedAt = bounds.candidateEndedAt ?? 0;
    next.comparisonStartedAt = bounds.comparisonStartedAt ?? 0;
    next.comparisonEndedAt = bounds.comparisonEndedAt ?? 0;
    const role = eventActivityRole(event);
    const currentRole = preparePhase === 'compare' || next.comparisonAttemptId ? 'comparison'
      : next.runPhase === 'recovery' || preparePhase === 'check' ? 'recovery'
        : next.machineState === 'awaiting_controller' || next.machineState === 'created' || next.machineState === 'finalizing'
          ? 'controller' : 'candidate';
    if (isVisibleActivityEvent(event) && (!role || role === currentRole)) next.lastVisibleActivityAt = event.occurredAt;
    if (shouldApplyLivePhase(event, preparePhase, next.comparisonAttemptId)) {
      const phase = candidateRunPhaseFromEvent(event);
      if (phase) next.runPhase = phase;
    }
    if (event.type === 'run.state_changed') {
      const to = text(record(event.payload).to);
      if (isCandidateRunState(to)) next.machineState = to;
    }
    if (event.type === 'run.outcome_created') {
      const display = candidateRunDisplayFromEvents([event]);
      next.runFailed = display.failed;
      next.cleanupStatus = display.cleanupStatus;
    }
    if (event.type === 'runtime.visible_output' || event.type === 'runtime.turn_settled') next.modelOutputSeen = true;
    if (event.type === 'runtime.runtime_failed') {
      const match = /Reconnecting\s+(\d+)\s*\/\s*(\d+)/i.exec(text(record(event.payload).message) ?? '');
      if (match) { next.reconnectCount = Number(match[1]); next.reconnectTotal = Number(match[2]); }
    }
    this.#state = next;
  }
}
