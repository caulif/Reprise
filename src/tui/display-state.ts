import { record, text } from '../core/json.js';
import type { CandidateRunState, EventEnvelope } from '../core/schema.js';
import type { CandidateRunPhase } from '../application/candidate-run-phase.js';
import type { MessageKey } from './i18n.js';
import type { PreparePhase } from './widgets.js';
import type { TimelineEntry } from './timeline.js';

/** Operator-facing activity role. Distinct from CandidateRun machineState and livePhase. */
export type ActivityRole = 'recovery' | 'controller' | 'candidate' | 'comparison';

/**
 * Coarse UI stage for the fixed chrome.
 * Recovery/Comparison fine nodes stay “processing” until T16 metadata exists.
 */
export type UiStage =
  | 'recovery_processing'
  | 'controller_opening'
  | 'candidate_starting'
  | 'awaiting_candidate'
  | 'awaiting_controller'
  | 'candidate_reconnecting'
  | 'finalizing'
  | 'finished'
  | 'comparison_processing';

export type ClockScope = 'recovery' | 'candidate' | 'comparison';

export type PhaseClockBounds = {
  readonly recoveryStartedAt?: number;
  readonly recoveryEndedAt?: number;
  readonly candidateStartedAt?: number;
  readonly candidateEndedAt?: number;
  readonly comparisonStartedAt?: number;
  readonly comparisonEndedAt?: number;
};

export type StaleTier = 'waiting' | 'waiting_role' | 'still_waiting' | 'stale';

const STALE_WAITING_MS = 10_000;
const STALE_ROLE_MS = 60_000;
const STALE_LONG_MS = 120_000;

const VISIBLE_ACTIVITY_TYPES = new Set([
  'recovery.started',
  'recovery.completed',
  'agent.invocation_started',
  'agent.invocation_completed',
  'agent.invocation_failed',
  'agent.invocation_cancelled',
  'agent.tool_called',
  'agent.tool_completed',
  'agent.tool_failed',
  'agent.assistant_visible',
  'runtime.tool_started',
  'runtime.tool_finished',
  'runtime.delivery_observed',
  'runtime.turn_started',
  'runtime.turn_settled',
  'runtime.visible_output',
  'runtime.visible_prompt',
  'runtime.runtime_failed',
  'runtime.session_started',
  'runtime.session_failed',
  'controller.started',
  'controller.decision',
  'controller.done',
  'controller.failed',
  'comparison.started',
  'comparison.completed',
  'input.submitted',
]);

/** Silent / metering / private model frames never reset the visible-activity idle clock. */
const NON_VISIBLE_ACTIVITY_TYPES = new Set([
  'agent.model_request',
  'agent.model_output',
  'agent.message_appended',
  'agent.session_started',
  'agent.session_completed',
  'agent.session_failed',
  'agent.session_cancelled',
  'agent.context_compacted',
]);

export function eventActivityRole(event: EventEnvelope): ActivityRole | undefined {
  const type = event.type;
  if (type.startsWith('recovery.')) return 'recovery';
  if (type.startsWith('comparison.')) return 'comparison';
  if (type.startsWith('controller.')) return 'controller';
  if (type.startsWith('runtime.') || type === 'run.attempt_created' || type === 'input.submitted') return 'candidate';
  if (type.startsWith('agent.')) {
    const role = text(record(event.payload).role);
    if (role === 'recovery') return 'recovery';
    if (role === 'controller') return 'controller';
    if (role === 'comparison') return 'comparison';
    return 'recovery';
  }
  if (type === 'run.state_changed') {
    const to = text(record(event.payload).to);
    if (to === 'awaiting_controller' || to === 'created' || to === 'finalizing') return 'controller';
    if (to === 'awaiting_target' || to === 'launching' || to === 'preparing') return 'candidate';
  }
  return undefined;
}

export function isVisibleActivityEvent(event: EventEnvelope): boolean {
  if (NON_VISIBLE_ACTIVITY_TYPES.has(event.type)) return false;
  if (VISIBLE_ACTIVITY_TYPES.has(event.type)) return true;
  // Public progress for the active role only; unknown types do not reset idle.
  return false;
}

function comparisonScoped(preparePhase: PreparePhase | undefined, comparisonAttemptId?: string): boolean {
  return preparePhase === 'compare' || Boolean(comparisonAttemptId);
}

/** Live CandidateRunPhase must not flip back to candidate after comparison starts. */
export function shouldApplyLivePhase(
  event: EventEnvelope,
  preparePhase: PreparePhase | undefined,
  comparisonAttemptId: string | undefined,
): boolean {
  if (!comparisonScoped(preparePhase, comparisonAttemptId)) return true;
  const role = eventActivityRole(event);
  if (role === 'candidate') return false;
  if (role === 'recovery') return false;
  const phaseType = event.type;
  if (phaseType.startsWith('runtime.') || phaseType === 'run.attempt_created' || phaseType === 'input.submitted') {
    return false;
  }
  // Same comparison attempt only; late events without attemptId still allowed when we have no id yet.
  if (comparisonAttemptId && (phaseType.startsWith('comparison.') || phaseType.startsWith('agent.'))) {
    const attemptId = text(record(event.payload).attemptId);
    if (attemptId && attemptId !== comparisonAttemptId) return false;
  }
  return true;
}

export function activityRoleFromDiagnostics(input: {
  readonly preparePhase?: PreparePhase;
  readonly runPhase?: CandidateRunPhase;
  readonly machineState?: CandidateRunState;
  readonly comparisonAttemptId?: string;
}): ActivityRole | undefined {
  if (comparisonScoped(input.preparePhase, input.comparisonAttemptId)) return 'comparison';
  if (input.runPhase === 'recovery' || input.preparePhase === 'check') return 'recovery';
  if (input.runPhase === 'candidate_reconnecting' || input.runPhase === 'candidate_starting') return 'candidate';
  if (input.preparePhase === 'copy') return 'candidate';
  switch (input.machineState) {
    case 'created':
      return 'controller';
    case 'preparing':
    case 'launching':
    case 'awaiting_target':
      return 'candidate';
    case 'awaiting_controller':
    case 'finalizing':
      return 'controller';
    case 'finished':
      return undefined;
    default:
      return input.runPhase === 'candidate_generating' ? 'candidate' : undefined;
  }
}

export function uiStageFrom(input: {
  readonly preparePhase?: PreparePhase;
  readonly runPhase?: CandidateRunPhase;
  readonly machineState?: CandidateRunState;
  readonly comparisonAttemptId?: string;
}): UiStage | undefined {
  if (comparisonScoped(input.preparePhase, input.comparisonAttemptId)) return 'comparison_processing';
  if (input.runPhase === 'recovery' || input.preparePhase === 'check') return 'recovery_processing';
  if (input.runPhase === 'candidate_reconnecting') return 'candidate_reconnecting';
  if (input.runPhase === 'candidate_starting' || input.preparePhase === 'copy') return 'candidate_starting';
  switch (input.machineState) {
    case 'created':
      return 'controller_opening';
    case 'preparing':
    case 'launching':
      return 'candidate_starting';
    case 'awaiting_target':
      return 'awaiting_candidate';
    case 'awaiting_controller':
      return 'awaiting_controller';
    case 'finalizing':
      return 'finalizing';
    case 'finished':
      return 'finished';
    default:
      return input.runPhase === 'candidate_generating' ? 'awaiting_candidate' : undefined;
  }
}

export function scopedElapsedMs(
  bounds: PhaseClockBounds,
  scope: ClockScope | undefined,
  nowMs: number,
): number | undefined {
  if (!scope) return undefined;
  const started =
    scope === 'recovery' ? bounds.recoveryStartedAt
      : scope === 'comparison' ? bounds.comparisonStartedAt
        : bounds.candidateStartedAt;
  if (!started || started <= 0) return undefined;
  const ended =
    scope === 'recovery' ? bounds.recoveryEndedAt
      : scope === 'comparison' ? bounds.comparisonEndedAt
        : bounds.candidateEndedAt;
  const end = ended && ended > 0 ? ended : nowMs;
  return Math.max(0, end - started);
}

export function formatElapsedClock(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function staleTier(idleMs: number): StaleTier | undefined {
  if (!Number.isFinite(idleMs) || idleMs < 0) return undefined;
  if (idleMs < STALE_WAITING_MS) return 'waiting';
  if (idleMs < STALE_ROLE_MS) return 'waiting_role';
  if (idleMs < STALE_LONG_MS) return 'still_waiting';
  return 'stale';
}

export function roleMessageKey(role: ActivityRole | undefined): MessageKey {
  switch (role) {
    case 'recovery':
      return 'activityRoleRecovery';
    case 'controller':
      return 'activityRoleController';
    case 'comparison':
      return 'activityRoleComparison';
    case 'candidate':
    default:
      return 'activityRoleCandidate';
  }
}

export function deriveStaleHint(input: {
  readonly idleMs: number;
  readonly roleLabel?: string;
}): { readonly key: MessageKey; readonly vars?: Record<string, string | number> } | undefined {
  const tier = staleTier(input.idleMs);
  if (!tier) return undefined;
  const seconds = Math.max(1, Math.floor(input.idleMs / 1000));
  switch (tier) {
    case 'waiting':
      return { key: 'runWaitBrief' };
    case 'waiting_role':
      return {
        key: 'runWaitRole',
        vars: { role: input.roleLabel ?? '', seconds },
      };
    case 'still_waiting':
      return { key: 'runWaitCancellable' };
    case 'stale':
      return { key: 'runStaleHint' };
  }
}

export function countActiveParallel(entries: readonly TimelineEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.placeholder && entry.itemId?.startsWith('now:')) count += 1;
  }
  return count;
}

function parseOccurredAtMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export function applyPhaseClockEvent(
  bounds: PhaseClockBounds,
  event: EventEnvelope,
): PhaseClockBounds {
  const at = parseOccurredAtMs(event.occurredAt);
  if (at === undefined) return bounds;
  switch (event.type) {
    case 'recovery.started':
      return { ...omitEnded(bounds, 'recovery'), recoveryStartedAt: at };
    case 'recovery.completed':
      return {
        ...bounds,
        recoveryEndedAt: at,
        recoveryStartedAt: bounds.recoveryStartedAt ?? at,
      };
    case 'run.attempt_created':
    case 'runtime.session_started':
      return {
        ...omitEnded(bounds, 'candidate'),
        candidateStartedAt: bounds.candidateStartedAt ?? at,
      };
    case 'run.outcome_created':
    case 'run.finished':
      return {
        ...bounds,
        candidateEndedAt: at,
        candidateStartedAt: bounds.candidateStartedAt ?? at,
      };
    case 'comparison.started':
      return { ...omitEnded(bounds, 'comparison'), comparisonStartedAt: at };
    case 'comparison.completed':
      return {
        ...bounds,
        comparisonEndedAt: at,
        comparisonStartedAt: bounds.comparisonStartedAt ?? at,
      };
    default:
      return bounds;
  }
}

function omitEnded(bounds: PhaseClockBounds, scope: ClockScope): PhaseClockBounds {
  if (scope === 'recovery') {
    const { recoveryEndedAt: _drop, ...rest } = bounds;
    return rest;
  }
  if (scope === 'comparison') {
    const { comparisonEndedAt: _drop, ...rest } = bounds;
    return rest;
  }
  const { candidateEndedAt: _drop, ...rest } = bounds;
  return rest;
}

export function uiStageLabelKey(stage: UiStage): MessageKey {
  switch (stage) {
    case 'recovery_processing':
      return 'uiStageRecoveryProcessing';
    case 'controller_opening':
      return 'uiStageControllerOpening';
    case 'candidate_starting':
      return 'uiStageCandidateStarting';
    case 'awaiting_candidate':
      return 'uiStageAwaitingCandidate';
    case 'awaiting_controller':
      return 'uiStageAwaitingController';
    case 'candidate_reconnecting':
      return 'uiStageCandidateReconnecting';
    case 'finalizing':
      return 'uiStageFinalizing';
    case 'finished':
      return 'uiStageFinished';
    case 'comparison_processing':
      return 'uiStageComparisonProcessing';
  }
}
