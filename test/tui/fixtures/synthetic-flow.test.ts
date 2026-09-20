import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTimelineEvent } from '../../../src/tui/timeline.js';
import {
  createFakeClock,
  createScriptedSyntheticWorkflow,
  envelope,
  longPublicResponse,
  PUBLIC_DETAIL_END,
  sampleTimelineEntries,
  SYNTHETIC_EXPERIMENT_ROOT,
  SYNTHETIC_FLOW_BASE_ISO,
  SYNTHETIC_RUN_ID,
  SYNTHETIC_TASK_TEXT,
  syntheticCandidateEvents,
  syntheticCandidateOutcome,
  syntheticComparisonEvents,
  syntheticComparisonResult,
  syntheticExperimentResult,
  syntheticFlowEvents,
  syntheticRecoveryEvents,
} from './synthetic-flow.js';

test('fake clock advances without sleeping and drives event timestamps', () => {
  const clock = createFakeClock(SYNTHETIC_FLOW_BASE_ISO);
  assert.equal(clock.now(), SYNTHETIC_FLOW_BASE_ISO);
  assert.equal(clock.nowMs(), Date.parse(SYNTHETIC_FLOW_BASE_ISO));
  clock.advance(121_000);
  assert.equal(clock.nowMs() - Date.parse(SYNTHETIC_FLOW_BASE_ISO), 121_000);
  assert.match(clock.now(), /^2026-08-11T00:12:01/);
  clock.set('2026-08-11T00:20:00.000Z');
  assert.equal(clock.now(), '2026-08-11T00:20:00.000Z');
});

test('syntheticFlowEvents covers recovery → candidate → comparison with monotonic sequences', () => {
  const clock = createFakeClock();
  assert.equal(SYNTHETIC_RUN_ID, 'run-synthetic-1');
  assert.match(SYNTHETIC_EXPERIMENT_ROOT, /synthetic-flow/);
  assert.match(PUBLIC_DETAIL_END, /PUBLIC_DETAIL_END/);
  assert.equal(syntheticRecoveryEvents({ repeatedToolFailures: 1 })[0]?.type, 'recovery.started');
  assert.equal(syntheticCandidateEvents({ multiLineLive: true })[0]?.type, 'run.state_changed');
  assert.equal(syntheticComparisonEvents({ comparison: { status: 'skipped' } }).at(-1)?.type, 'comparison.completed');
  const events = syntheticFlowEvents({
    clock,
    repeatedToolFailures: 3,
    multiLineLive: true,
    includeToolCallId: false,
    longMessageLines: 4,
    comparison: { status: 'failed', failure: { kind: 'protocol', code: 'agent_failure' } },
    candidate: { task: 'incomplete', termination: 'stalled', cleanup: 'incomplete' },
  });
  assert.ok(events.length >= 12);
  assert.equal(events[0]?.type, 'recovery.started');
  assert.equal(events.at(-1)?.type, 'comparison.completed');
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index]!.occurredAt >= events[index - 1]!.occurredAt);
  }
  const failures = events.filter((event) => event.type === 'agent.tool_failed');
  assert.equal(failures.length, 3);
  assert.ok(failures.every((event) => !('toolCallId' in (event.payload as object))));
  const live = events.find((event) => event.type === 'runtime.tool_started');
  assert.match(JSON.stringify(live?.payload), /first live line\\nsecond live line/);
  assert.ok(!('callId' in ((live?.payload as object) ?? {})));
  assert.match(longPublicResponse(4), new RegExp(`public response line 4\\n${PUBLIC_DETAIL_END}`));
  assert.ok(projectTimelineEvent(envelope('input.submitted', { turnIndex: 0, text: SYNTHETIC_TASK_TEXT })).length > 0);
});

test('comparison and candidate outcomes parameterize independently', () => {
  const matrix = [
    { comparison: { status: 'completed' as const }, candidate: { task: 'apparently_completed' as const, termination: 'completed' as const, cleanup: 'complete' as const } },
    { comparison: { status: 'completed' as const, valueStatus: 'insufficient_evidence' as const }, candidate: { task: 'apparently_completed' as const, termination: 'completed' as const, cleanup: 'complete' as const } },
    { comparison: { status: 'failed' as const }, candidate: { task: 'apparently_completed' as const, termination: 'completed' as const, cleanup: 'complete' as const } },
    { comparison: { status: 'cancelled' as const }, candidate: { task: 'apparently_completed' as const, termination: 'completed' as const, cleanup: 'complete' as const } },
    { comparison: { status: 'skipped' as const }, candidate: { task: 'apparently_completed' as const, termination: 'completed' as const, cleanup: 'complete' as const } },
    { comparison: { status: 'completed' as const }, candidate: { task: 'incomplete' as const, termination: 'stalled' as const, cleanup: 'incomplete' as const } },
    { comparison: { status: 'cancelled' as const }, candidate: { task: 'not_assessed' as const, termination: 'cancelled' as const, cleanup: 'unknown' as const } },
    { comparison: { status: 'failed' as const }, candidate: { task: 'indeterminate' as const, termination: 'uncertain' as const, cleanup: 'not_needed' as const } },
  ];
  for (const row of matrix) {
    const result = syntheticExperimentResult({ comparison: row.comparison, candidate: row.candidate });
    const outcome = (result.record as { outcome: ReturnType<typeof syntheticCandidateOutcome> }).outcome;
    const comparison = (result.comparison as { result: ReturnType<typeof syntheticComparisonResult> }).result as {
      status: string;
      value?: { status?: string };
    };
    assert.equal(outcome.task.status, row.candidate.task);
    assert.equal(outcome.termination.kind, row.candidate.termination);
    assert.equal(outcome.cleanup.status, row.candidate.cleanup);
    assert.equal(comparison.status, row.comparison.status === 'completed' ? 'completed' : row.comparison.status);
    if (row.comparison.status === 'completed' && 'valueStatus' in row.comparison && row.comparison.valueStatus === 'insufficient_evidence') {
      assert.equal(comparison.value?.status, 'insufficient_evidence');
    }
  }
  const cancelledOk = syntheticExperimentResult({
    comparison: { status: 'cancelled' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
  });
  assert.equal((cancelledOk.comparison as { result: { status: string } }).result.status, 'cancelled');
  assert.equal(
    ((cancelledOk.record as { outcome: { task: { status: string } } }).outcome).task.status,
    'apparently_completed',
  );
});

test('sampleTimelineEntries and scripted workflow stay Runtime-free', () => {
  const entries = sampleTimelineEntries(createFakeClock());
  assert.equal(entries.length, 3);
  assert.equal(entries[2]?.itemId, 'now:candidate');
  const { workflow, handles, clock } = createScriptedSyntheticWorkflow({
    clock: createFakeClock(),
    comparison: { status: 'cancelled' },
    candidate: { task: 'apparently_completed', termination: 'completed', cleanup: 'complete' },
  });
  assert.equal(typeof workflow.preflight, 'function');
  assert.equal(typeof handles.releaseRecovery, 'function');
  assert.equal(clock.now(), SYNTHETIC_FLOW_BASE_ISO);
  const emitted: string[] = [];
  handles.emitCandidateEvents((event) => emitted.push(event.type));
  assert.ok(emitted.includes('input.submitted'));
  assert.ok(emitted.includes('run.outcome_created'));
  assert.ok(!emitted.includes('recovery.started'));
});
