import test from 'node:test';
import assert from 'node:assert/strict';
import { taskCase, runRecord } from '../support/comparison-fixtures.js';
import { buildComparisonContext, type RunInspection } from '../../src/application/comparison.js';
import { historicalTurnTiming } from '../../src/application/session-timing.js';

const inspection: RunInspection = { runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 120000 };

test('Comparison freezes cumulative turn timing independently from whole-run span', () => {
  const task = taskCase();
  task.historicalEvents = [{ type: 'task_complete', turn_id: 'history-1', duration_ms: 104785 }];
  const turnTiming = historicalTurnTiming([{ type: 'task_complete', turn_id: 'candidate-1', duration_ms: 4000 }]);
  const facts = buildComparisonContext(task, [runRecord()], [{ ...inspection, turnTiming }]).reportFacts;
  assert.equal(facts.metrics?.baseline?.elapsedMs, 104785);
  assert.equal(facts.metrics?.candidate?.elapsedMs, 4000);
  assert.equal(facts.metrics?.candidate?.spanElapsedMs, 120000);
  assert.equal(facts.run.candidateElapsedMs, 120000);
  assert.deepEqual(facts.metrics?.candidate?.timing, turnTiming);
});

test('Comparison preserves legacy span provenance and cannot call it comparable turn timing', () => {
  const facts = buildComparisonContext(taskCase(), [runRecord()], [inspection]).reportFacts;
  assert.equal(facts.metrics?.candidate?.elapsedMs, 120000);
  assert.equal(facts.metrics?.candidate?.timing?.basis, 'run_wall_clock_span');
  assert.equal(facts.metrics?.timingComparable, false);
});

test('missing candidate turn timing never falls back to a misleading known span', () => {
  const turnTiming = historicalTurnTiming([{ type: 'task_complete', turn_id: 'unknown-duration' }]);
  const facts = buildComparisonContext(taskCase(), [runRecord()], [{ ...inspection, turnTiming }]).reportFacts;
  assert.equal(facts.metrics?.candidate?.elapsedMs, undefined);
  assert.equal(facts.metrics?.candidate?.spanElapsedMs, 120000);
  assert.equal(facts.metrics?.candidate?.timing?.coverage.status, 'unavailable');
});
