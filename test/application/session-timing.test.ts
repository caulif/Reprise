import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { TimingFactsSchema } from '../../src/core/timing-schema.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { historicalTurnTiming, candidateTurnTiming, timingComparable } from '../../src/application/session-timing.js';
import { busyMsFromHistoricalEvents } from '../../src/application/session-usage.js';

function historical(type: string, seconds: number, payload: Record<string, unknown> = {}) {
  return { type: 'event_msg', timestamp: new Date(seconds * 1000).toISOString(), payload: { type, ...payload } };
}

function candidate(type: string, seconds: number, payload: Record<string, unknown> = {}): EventEnvelope {
  return { schemaVersion: 1, sequence: seconds, eventId: `event-${seconds}-${type}`, occurredAt: new Date(seconds * 1000).toISOString(), type, runId: 'run-1', payload, checksum: 'a'.repeat(64) };
}

test('historical native durations restore the missing first turn and ignore unrelated later starts', () => {
  const events = [
    historical('task_complete', 100, { turn_id: 'first', duration_ms: 104785 }),
    historical('task_started', 200, { turn_id: 'second' }),
    historical('task_complete', 300, { turn_id: 'second', duration_ms: 99999 }),
    historical('task_started', 400, { turn_id: 'unrelated' }),
  ];
  const timing = historicalTurnTiming(events);
  assert.equal(timing.valueMs, 204784);
  assert.equal(busyMsFromHistoricalEvents(events), 204784);
  assert.deepEqual(timing.coverage, { completedTurns: 2, measuredTurns: 2, openTurns: 1, status: 'partial' });
  assert.ok(timing.sources.every(source => source.kind === 'duration_ms'));
  assert.ok(Value.Check(TimingFactsSchema, timing));
});

test('each historical turn chooses one source, with exact IDs across parallel and reordered events', () => {
  const timing = historicalTurnTiming([
    historical('task_started', 10, { turn_id: 'a' }),
    historical('task_started', 15, { turn_id: 'b' }),
    historical('task_complete', 30, { turn_id: 'a', duration_ms: 19000 }),
    historical('task_complete', 40, { turn_id: 'b' }),
    historical('task_complete', 80, { turn_id: 'c', started_at: 50, completed_at: 80 }),
  ]);
  assert.equal(timing.valueMs, 74000);
  assert.equal(timing.basis, 'turn_wall_clock_sum');
  assert.deepEqual(timing.sources.map(source => source.kind), ['duration_ms', 'matched_events', 'turn_timestamps']);
  assert.equal(timing.coverage.status, 'complete');
});

test('duplicate completed turns are counted once; conflicting native durations remain partial', () => {
  const same = historical('task_complete', 30, { turn_id: 'a', duration_ms: 10 });
  assert.equal(historicalTurnTiming([same, same]).valueMs, 10);
  const timing = historicalTurnTiming([same, historical('task_complete', 31, { turn_id: 'a', duration_ms: 20 }),
    historical('task_complete', 35, { turn_id: 'b', duration_ms: 0 })]);
  assert.equal(timing.valueMs, 0);
  assert.equal(timing.coverage.completedTurns, 2);
  assert.equal(timing.coverage.measuredTurns, 1);
  assert.equal(timing.coverage.status, 'partial');
  assert.ok(timing.diagnostics.includes('conflicting_duration_ms'));
});

test('invalid duration and millisecond epochs are diagnosed instead of guessed', () => {
  const timing = historicalTurnTiming([
    historical('task_complete', 30, { turn_id: 'a', duration_ms: -2 }),
    historical('task_complete', 40, { turn_id: 'b', started_at: 1700000000000, completed_at: 1700000001000 }),
    historical('task_complete', 50, { turn_id: 'c', duration_ms: '1000' }),
    historical('task_complete', 60, { turn_id: 'd', duration_ms: Infinity }),
  ]);
  assert.equal(timing.valueMs, undefined);
  assert.equal(timing.coverage.status, 'unavailable');
  assert.ok(timing.diagnostics.includes('invalid_duration_ms'));
  assert.ok(timing.diagnostics.includes('invalid_turn_timestamps'));
});

test('missing and ambiguous historical starts never pair across turn IDs', () => {
  const timing = historicalTurnTiming([
    historical('task_started', 10, { turn_id: 'a' }),
    historical('task_complete', 20, { turn_id: 'b' }),
    historical('task_started', 30), historical('task_started', 35), historical('task_complete', 40),
  ]);
  assert.equal(timing.valueMs, undefined);
  assert.ok(timing.diagnostics.includes('ambiguous_start'));
});

test('legacy ID-less historical turns match sequentially and repeated starts do not inflate coverage', () => {
  const first = historical('task_started', 10);
  const timing = historicalTurnTiming([first, first, historical('task_complete', 20), historical('task_started', 30), historical('task_complete', 40)]);
  assert.equal(timing.valueMs, 20000);
  assert.equal(timing.coverage.status, 'complete');
  assert.equal(timing.coverage.openTurns, 0);
  assert.ok(timing.diagnostics.includes('duplicate_start'));
  const future = historicalTurnTiming([historical('task_complete', 20, { turn_id: 'a' }), historical('task_started', 30, { turn_id: 'a' })]);
  assert.equal(future.valueMs, undefined);
  assert.equal(future.coverage.openTurns, 1);
});

test('an aborted historical tail prevents complete coverage even without a start event', () => {
  const timing = historicalTurnTiming([historical('task_complete', 10, { turn_id: 'a', duration_ms: 20 }), historical('turn_aborted', 20, { turn_id: 'b' })]);
  assert.equal(timing.coverage.status, 'partial');
  assert.equal(timing.coverage.openTurns, 1);
});

test('partial timing does not turn unknown completions into zero or hide overflow', () => {
  const partial = historicalTurnTiming([historical('task_complete', 10, { turn_id: 'a', duration_ms: 20 }), historical('task_complete', 20, { turn_id: 'b' })]);
  assert.equal(partial.valueMs, 20);
  assert.equal(partial.coverage.status, 'partial');
  const overflow = historicalTurnTiming([historical('task_complete', 10, { turn_id: 'a', duration_ms: Number.MAX_VALUE }), historical('task_complete', 20, { turn_id: 'b', duration_ms: Number.MAX_VALUE })]);
  assert.equal(overflow.valueMs, undefined);
  assert.ok(overflow.diagnostics.includes('duration_sum_overflow'));
});

test('candidate sums submissions by delivery identity and excludes Controller gaps', () => {
  const timing = candidateTurnTiming([
    candidate('input.submitted', 10, { clientMessageId: 'm1', turnIndex: 0 }),
    candidate('runtime.delivery_observed', 12, { clientMessageId: 'm1', receipt: { delivery: 'accepted', turnId: 't1' } }),
    candidate('runtime.turn_settled', 20, { turnId: 't1', observedAt: new Date(20000).toISOString(), status: 'completed' }),
    candidate('input.submitted', 100, { clientMessageId: 'm2', turnIndex: 1 }),
    candidate('runtime.delivery_observed', 102, { clientMessageId: 'm2', receipt: { delivery: 'accepted', turnId: 't2' } }),
    candidate('runtime.turn_settled', 120, { turnId: 't2', status: 'aborted' }),
  ]);
  assert.equal(timing.valueMs, 30000);
  assert.equal(timing.coverage.status, 'complete');
  assert.ok(timing.diagnostics.includes('noncompleted_settlement'));
  assert.ok(timing.sources.every(source => source.kind === 'submission_settlement'));
});

test('candidate parallel turns sum their own intervals rather than union or sequential pairing', () => {
  const timing = candidateTurnTiming([
    candidate('input.submitted', 10, { clientMessageId: 'm1' }),
    candidate('input.submitted', 15, { clientMessageId: 'm2' }),
    candidate('runtime.delivery_observed', 16, { clientMessageId: 'm2', receipt: { delivery: 'accepted', turnId: 't2' } }),
    candidate('runtime.delivery_observed', 17, { clientMessageId: 'm1', receipt: { delivery: 'accepted', turnId: 't1' } }),
    candidate('runtime.turn_settled', 25, { turnId: 't2' }),
    candidate('runtime.turn_settled', 30, { turnId: 't1' }),
  ]);
  assert.equal(timing.valueMs, 30000);
  assert.equal(timing.coverage.completedTurns, 2);
  assert.equal(timing.coverage.openTurns, 0);
});

test('preflight receipts without turn IDs bind a unique pending Host submission', () => {
  const timing = candidateTurnTiming([
    candidate('input.submitted', 10, { clientMessageId: 'm1', turnIndex: 0 }),
    candidate('runtime.delivery_observed', 11, { clientMessageId: 'm1', turnIndex: 0, receipt: { delivery: 'accepted', evidence: 'preflight', messageId: 'm1' } }),
    candidate('runtime.turn_settled', 20, { turnId: 't1' }),
    candidate('input.submitted', 100, { clientMessageId: 'm2', turnIndex: 1 }),
    candidate('runtime.delivery_observed', 101, { clientMessageId: 'm2', turnIndex: 1, receipt: { delivery: 'accepted', evidence: 'preflight' } }),
    candidate('runtime.turn_settled', 120, { turnId: 't2' }),
  ]);
  assert.equal(timing.valueMs, 30000);
  assert.equal(timing.coverage.status, 'complete');
});

test('raw and Host candidate settlements deduplicate by turn and retain Host boundary', () => {
  const timing = candidateTurnTiming([
    candidate('input.submitted', 10, { clientMessageId: 'm1' }),
    candidate('runtime.delivery_observed', 11, { clientMessageId: 'm1', receipt: { delivery: 'accepted', turnId: 't1' } }),
    candidate('runtime.turn_settled', 19, { turn: { id: 't1' } }),
    candidate('runtime.turn_settled', 20, { turnId: 't1', observedAt: new Date(20000).toISOString(), status: 'completed' }),
  ]);
  assert.equal(timing.valueMs, 10000);
  assert.equal(timing.coverage.completedTurns, 1);
  assert.ok(timing.diagnostics.includes('duplicate_completion'));
});

test('candidate unsettled/rejected submissions and unmatched settlements stay partial', () => {
  const timing = candidateTurnTiming([
    candidate('input.submitted', 10), candidate('runtime.turn_settled', 20, { turnId: 'a' }),
    candidate('input.submitted', 30),
    candidate('runtime.delivery_observed', 31, { receipt: { delivery: 'rejected' } }),
  ]);
  assert.equal(timing.valueMs, 10000);
  assert.equal(timing.coverage.status, 'partial');
  assert.equal(timing.coverage.openTurns, 1);
  const ambiguous = candidateTurnTiming([candidate('input.submitted', 10), candidate('input.submitted', 11), candidate('runtime.turn_settled', 20, { turnId: 'a' })]);
  assert.equal(ambiguous.valueMs, undefined);
});

test('timing comparability requires complete coverage and identical proven boundary sources', () => {
  const historicalFacts = historicalTurnTiming([historical('task_complete', 20, { turn_id: 'a', duration_ms: 10000 })]);
  const nativeCandidate = candidateTurnTiming([candidate('runtime.turn_started', 10, { turnId: 'b' }), candidate('runtime.turn_settled', 20, { turnId: 'b', duration_ms: 10000 })]);
  const submittedCandidate = candidateTurnTiming([candidate('input.submitted', 10), candidate('runtime.turn_settled', 20, { turnId: 'b' })]);
  const sameProduct = { baseline: 'codex', candidate: 'codex' };
  assert.equal(timingComparable(historicalFacts, nativeCandidate, sameProduct), true);
  assert.equal(timingComparable(historicalFacts, nativeCandidate, { baseline: 'codex', candidate: 'claude-code' }), false);
  assert.equal(timingComparable(historicalFacts, submittedCandidate, sameProduct), false);
  assert.equal(timingComparable(undefined, nativeCandidate), false);
  assert.equal(timingComparable({ ...historicalFacts, coverage: { ...historicalFacts.coverage, status: 'partial' } }, nativeCandidate, sameProduct), false);
  assert.equal(timingComparable({ ...historicalFacts, diagnostics: ['conflicting_duration_ms'] }, nativeCandidate, sameProduct), false);
});

test('invalid candidate native durations cannot disappear behind a valid duplicate or nested field', () => {
  const baseline = historicalTurnTiming([historical('task_complete', 20, { turn_id: 'a', duration_ms: 10000 })]);
  for (const invalid of [-3, '10000', Infinity, null]) {
    for (const payload of [{ turnId: 'b', duration_ms: invalid }, { turn: { id: 'b', duration_ms: invalid } },
      { turnId: 'b', duration_ms: 10000, turn: { id: 'b', duration_ms: invalid } }]) {
      const timing = candidateTurnTiming([
        candidate('runtime.turn_started', 10, { turnId: 'b' }),
        candidate('runtime.turn_settled', 19, payload),
        candidate('runtime.turn_settled', 20, { turnId: 'b', duration_ms: 10000 }),
      ]);
      assert.equal(timing.valueMs, 10000);
      assert.ok(timing.diagnostics.includes('invalid_duration_ms'));
      assert.equal(timingComparable(baseline, timing, { baseline: 'codex', candidate: 'codex' }), false);
    }
  }
});

test('a candidate start after the same turn ID settled remains an uncovered open interval', () => {
  const timing = candidateTurnTiming([
    candidate('runtime.turn_started', 10, { turnId: 'a' }),
    candidate('runtime.turn_settled', 20, { turnId: 'a', duration_ms: 10000 }),
    candidate('runtime.turn_started', 30, { turnId: 'a' }),
  ]);
  assert.equal(timing.valueMs, 10000);
  assert.equal(timing.coverage.openTurns, 1);
  assert.equal(timing.coverage.status, 'partial');
  assert.ok(timing.diagnostics.includes('unsettled_submissions'));
});
