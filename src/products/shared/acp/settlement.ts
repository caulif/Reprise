import type { TurnSettlement } from '../../../core/runtime.js';

const FAILED_STOP_REASONS: Readonly<Record<string, string>> = {
  max_tokens: 'The agent reached its token limit before finishing the turn.',
  max_turn_requests: 'The agent exceeded its per-turn model request budget.',
  refusal: 'The agent refused to continue the turn.',
};

/**
 * ACP reports the turn outcome as `stopReason` on the `session/prompt` response, so this
 * settlement is native rather than inferred from process exit.
 */
export function acpTurnSettlement(input: { stopReason: string | undefined; turnId: string; observedAt?: string }): TurnSettlement | undefined {
  const stopReason = input.stopReason;
  if (!stopReason) return undefined;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const rawRefs = [{ type: 'session/prompt', stopReason }];
  if (stopReason === 'end_turn') {
    return { turnId: input.turnId, status: 'completed', confidence: 'native', observedAt, rawRefs };
  }
  if (stopReason === 'cancelled') {
    return { turnId: input.turnId, status: 'aborted', confidence: 'native', observedAt, rawRefs };
  }
  const summary = FAILED_STOP_REASONS[stopReason];
  if (!summary) return undefined;
  return {
    turnId: input.turnId,
    status: 'failed',
    confidence: 'native',
    observedAt,
    rawRefs,
    failure: { kind: 'upstream', summary, retryable: false },
  };
}
