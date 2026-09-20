import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  activityRoleFromDiagnostics,
  applyPhaseClockEvent,
  deriveStaleHint,
  formatElapsedClock,
  scopedElapsedMs,
  shouldApplyLivePhase,
  staleTier,
  uiStageFrom,
} from '../../src/tui/phase-state.js';
import { elapsedForRunning, waitLine } from '../../src/tui/pages/run.js';
import { t } from '../../src/tui/i18n.js';

function event(type: string, payload: Record<string, unknown> = {}, occurredAt = '2026-08-28T00:00:00.000Z') {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

describe('T06 display-state stages and clocks', () => {
  it('projects machineState, activity role, and UI stage separately', () => {
    assert.equal(uiStageFrom({ machineState: 'created' }), 'controller_opening');
    assert.equal(activityRoleFromDiagnostics({ machineState: 'created' }), 'controller');
    assert.equal(uiStageFrom({ machineState: 'awaiting_target' }), 'awaiting_candidate');
    assert.equal(activityRoleFromDiagnostics({ machineState: 'awaiting_target' }), 'candidate');
    assert.equal(uiStageFrom({ machineState: 'awaiting_controller' }), 'awaiting_controller');
    assert.equal(activityRoleFromDiagnostics({ machineState: 'awaiting_controller' }), 'controller');
    assert.equal(uiStageFrom({ preparePhase: 'compare' }), 'comparison_processing');
    assert.equal(activityRoleFromDiagnostics({ preparePhase: 'compare' }), 'comparison');
    assert.equal(uiStageFrom({ runPhase: 'recovery' }), 'recovery_processing');
  });

  it('keeps comparison scope when late candidate events arrive', () => {
    assert.equal(
      shouldApplyLivePhase(event('runtime.visible_output', {}), 'compare', 'attempt-1'),
      false,
    );
    assert.equal(
      shouldApplyLivePhase(event('agent.assistant_visible', { role: 'comparison', attemptId: 'attempt-1' }), 'compare', 'attempt-1'),
      true,
    );
    assert.equal(
      shouldApplyLivePhase(event('agent.assistant_visible', { role: 'comparison', attemptId: 'other' }), 'compare', 'attempt-1'),
      false,
    );
  });

  it('freezes ended phase clocks and leaves unknown starts unrecorded', () => {
    const bounds = {
      candidateStartedAt: 1_000,
      candidateEndedAt: 61_000,
      comparisonStartedAt: 100_000,
    };
    assert.equal(scopedElapsedMs(bounds, 'candidate', 999_000), 60_000);
    assert.equal(formatElapsedClock(scopedElapsedMs(bounds, 'candidate', 999_000)), '01:00');
    assert.equal(scopedElapsedMs(bounds, 'comparison', 160_000), 60_000);
    assert.equal(scopedElapsedMs({}, 'candidate', 50_000), undefined);
    assert.equal(
      elapsedForRunning({ entries: [], runStartedAt: 0 }, 50_000, 'zh'),
      t('zh', 'unrecordedBoundary'),
    );
  });

  it('derives recovery/run/comparison boundaries from events', () => {
    let bounds = applyPhaseClockEvent({}, event('recovery.started', {}, '2026-08-28T00:00:00.000Z'));
    bounds = applyPhaseClockEvent(bounds, event('recovery.completed', {}, '2026-08-28T00:01:00.000Z'));
    bounds = applyPhaseClockEvent(bounds, event('run.attempt_created', {}, '2026-08-28T00:02:00.000Z'));
    bounds = applyPhaseClockEvent(bounds, event('run.outcome_created', {}, '2026-08-28T00:05:00.000Z'));
    bounds = applyPhaseClockEvent(bounds, event('comparison.started', { attemptId: 'a1' }, '2026-08-28T00:06:00.000Z'));
    bounds = applyPhaseClockEvent(bounds, event('comparison.completed', { attemptId: 'a1' }, '2026-08-28T00:08:00.000Z'));
    assert.equal(scopedElapsedMs(bounds, 'recovery', 0), 60_000);
    assert.equal(scopedElapsedMs(bounds, 'candidate', 0), 180_000);
    assert.equal(scopedElapsedMs(bounds, 'comparison', 0), 120_000);
  });

  it('keeps an end boundary unknown when no start event was recorded', () => {
    const endedAt = Date.parse('2026-08-28T00:08:00.000Z');
    const bounds = applyPhaseClockEvent({}, event('comparison.completed', {}, '2026-08-28T00:08:00.000Z'));
    assert.equal(bounds.comparisonEndedAt, endedAt);
    assert.equal(bounds.comparisonStartedAt, undefined);
    assert.equal(scopedElapsedMs(bounds, 'comparison', endedAt + 60_000), undefined);
  });
});

describe('T06 R08 stale wait ladder', () => {
  const base = {
    entries: [] as const,
    selected: 0,
    filter: 'ALL' as const,
    following: true,
    cancelling: false,
    currentState: 'awaiting_target' as const,
    elapsed: '00:00',
    turns: { used: 0 },
    calls: { used: 0 },
    runPhase: 'candidate_generating' as const,
    activityRole: 'candidate' as const,
    lastVisibleActivityAt: '2026-08-28T00:00:00.000Z',
    runStartedAt: Date.parse('2026-08-28T00:00:00.000Z'),
    locale: 'zh' as const,
    productLabel: 'Codex',
  };

  it('advances 10/60/120 tiers without inventing progress or changing role', () => {
    assert.equal(staleTier(5_000), 'waiting');
    assert.equal(staleTier(10_000), 'waiting_role');
    assert.equal(staleTier(60_000), 'still_waiting');
    assert.equal(staleTier(120_000), 'stale');

    const at10 = waitLine({ ...base, tick: Date.parse('2026-08-28T00:00:10.000Z') }, 'zh');
    assert.match(at10 ?? '', /等待候选新活动/);
    assert.match(at10 ?? '', /10 秒前/);

    const at60 = waitLine({ ...base, tick: Date.parse('2026-08-28T00:01:00.000Z') }, 'zh');
    assert.match(at60 ?? '', /仍在等待/);
    assert.match(at60 ?? '', /可取消/);

    const at120 = waitLine({ ...base, tick: Date.parse('2026-08-28T00:02:00.000Z') }, 'zh');
    assert.match(at120 ?? '', /2 分钟没有新的可见活动/);
    assert.match(at120 ?? '', /Ctrl\+C/);

    const afterVisible = waitLine({
      ...base,
      lastVisibleActivityAt: '2026-08-28T00:01:55.000Z',
      tick: Date.parse('2026-08-28T00:02:00.000Z'),
    }, 'zh');
    assert.match(afterVisible ?? '', /正在等待/);
  });

  it('token-style observed events do not clear visible-activity idle via lastVisibleActivityAt', () => {
    const hint = deriveStaleHint({
      idleMs: 90_000,
      roleLabel: t('zh', 'activityRoleComparison'),
    });
    assert.equal(hint?.key, 'runWaitCancellable');
    const observedOnly = waitLine({
      ...base,
      activityRole: 'comparison',
      preparePhase: 'compare',
      lastObservedEventAt: '2026-08-28T00:01:50.000Z',
      lastVisibleActivityAt: '2026-08-28T00:00:00.000Z',
      tick: Date.parse('2026-08-28T00:02:00.000Z'),
    }, 'zh');
    assert.match(observedOnly ?? '', /2 分钟没有新的可见活动/);
  });

  it('keeps candidate elapsed frozen after end while comparison clock runs alone', () => {
    const frozen = elapsedForRunning({
      entries: [],
      phaseClocks: {
        candidateStartedAt: 1_000,
        candidateEndedAt: 125_000,
        comparisonStartedAt: 200_000,
      },
      preparePhase: 'compare',
      comparisonAttemptId: 'attempt-1',
      runStartedAt: 200_000,
    }, 260_000, 'zh');
    assert.equal(frozen, '01:00');
    const candidateView = elapsedForRunning({
      entries: [],
      phaseClocks: {
        candidateStartedAt: 1_000,
        candidateEndedAt: 125_000,
      },
      runPhase: 'candidate_generating',
      runStartedAt: 1_000,
    }, 999_000, 'zh');
    assert.equal(candidateView, '02:04');
  });
});
