import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import { RunDiagnostics } from '../../src/tui/run-diagnostics.js';
import { applyPhaseClockEvent, scopedElapsedMs, type PhaseClockBounds } from '../../src/tui/phase-state.js';
import { IntakeTui } from '../../src/tui/intake-tui.js';
import { mockTui } from '../../scripts/tui-audit-lib.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExperiment } from '../../src/application/experiment.js';
import { readExperimentEvents } from '../../src/application/experiment-event-read.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

function event(type: string, at: number, payload: Record<string, unknown> = {}): EventEnvelope {
  return { schemaVersion: 1, sequence: at, eventId: `event-${at}`, occurredAt: new Date(at).toISOString(),
    type, payload, checksum: '0'.repeat(64) };
}

test('live diagnostic clock bounds match replay and a later comparison reopens only its clock', () => {
  const diagnostics = new RunDiagnostics();
  const events = [event('recovery.started', 1000), event('recovery.completed', 5000),
    event('runtime.session_started', 6000), event('run.finished', 18000),
    event('comparison.started', 20000, { attemptId: 'comparison-1' }), event('comparison.completed', 30000),
    event('comparison.started', 40000, { attemptId: 'comparison-2' })];
  let replay: PhaseClockBounds = {};
  for (const item of events) { diagnostics.observe(item, undefined); replay = applyPhaseClockEvent(replay, item); }
  for (const scope of ['recovery', 'candidate', 'comparison'] as const) {
    assert.equal(scopedElapsedMs(diagnostics.state, scope, 45000), scopedElapsedMs(replay, scope, 45000));
  }
  assert.equal(diagnostics.state.comparisonEndedAt, 0);
  assert.equal(diagnostics.state.comparisonAttemptId, 'comparison-2');
});

test('late candidate frames do not replace comparison activity and earlier snapshots stay stable', () => {
  const diagnostics = new RunDiagnostics();
  diagnostics.beginPhase('candidate_starting');
  diagnostics.startClock('candidate', 1000);
  diagnostics.observe(event('runtime.runtime_failed', 2000, { message: 'Reconnecting 2/5' }), undefined);
  const candidateSnapshot = diagnostics.state;
  diagnostics.observe(event('comparison.started', 3000, { attemptId: 'comparison-1' }), 'compare');
  const comparisonSnapshot = diagnostics.state;
  diagnostics.observe(event('runtime.delivery_observed', 4000, { status: 'accepted' }), undefined);
  assert.equal(diagnostics.state.runPhase, comparisonSnapshot.runPhase);
  assert.equal(diagnostics.state.lastVisibleActivityAt, new Date(3000).toISOString());
  assert.equal(diagnostics.state.lastObservedEventAt, new Date(4000).toISOString());
  assert.equal(candidateSnapshot.comparisonAttemptId, undefined);
  assert.equal(candidateSnapshot.lastObservedEventAt, new Date(2000).toISOString());
  diagnostics.beginPhase('recovery');
  assert.equal(diagnostics.state.reconnectCount, 0);
  assert.equal(diagnostics.state.comparisonAttemptId, undefined);
  assert.equal(diagnostics.state.candidateStartedAt, 1000, 'phase reset retains earlier phase clocks');
});

test('actual error navigation clears event diagnostics and all phase clocks without changing navigation ownership', () => {
  const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  app.runDiagnostics.beginPhase('candidate_starting');
  app.runDiagnostics.startClock('candidate', 1000);
  app.runDiagnostics.observe(event('runtime.runtime_failed', 2000, { message: 'Reconnecting 3/5' }), undefined);
  app.runDiagnostics.observe(event('comparison.started', 3000, { attemptId: 'comparison-1' }), 'compare');
  const generation = app.generation;
  app.showError(new Error('fixture failure'), 'home');
  assert.equal(app.page, 'error');
  assert.equal(app.generation, generation);
  assert.equal(app.runDiagnostics.state.comparisonAttemptId, undefined);
  assert.equal(app.runDiagnostics.state.runStartedAt, 0);
  assert.equal(scopedElapsedMs(app.runDiagnostics.state, 'candidate', 5000), undefined);
  assert.equal(app.runDiagnostics.state.reconnectCount, 0);
  app.runDiagnostics.beginPhase('recovery');
  app.runDiagnostics.startClock('recovery', 6000);
  assert.equal(app.runDiagnostics.state.runPhase, 'recovery');
  assert.equal(app.runDiagnostics.state.lastRuntimeEventAt, undefined);
  assert.equal(app.runDiagnostics.state.comparisonStartedAt, 0);
});

test('a real offline experiment delivers the same event diagnostics live and after disk reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-diagnostic-reopen-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot);
  const live = new RunDiagnostics();
  await startExperiment({ ...base, compare: false, onEvent: item => live.observe(item, undefined) }).result;
  const reopened = new RunDiagnostics();
  const { events } = await readExperimentEvents({ dataDir: base.dataDir, experimentId: base.experimentId });
  for (const item of events) reopened.observe(item, undefined);
  assert.deepEqual(live.state, reopened.state);
  assert.equal(live.state.machineState, 'finished');
  assert.equal(live.state.cleanupStatus, 'complete');
  assert.equal(live.state.modelOutputSeen, true);
});
