import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { CandidateRun } from '../../src/application/candidate-run.js';
import { createCandidateRuntimeSink } from '../../src/application/candidate-run-events.js';
import { workspaceProgressFingerprint } from '../../src/application/candidate-run-safety.js';
import { runtimeTargetEvent } from '../../src/core/runtime.js';
import { RunRecordSchema, type RunAttempt, type RunManifest } from '../../src/core/schema.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { ScriptedRunner } from '../support/scripted-runtime.js';

const policy = { turnTimeoutMs: 50, maxTargetTurns: 3 };
const initial = { id: 'message-1', text: 'Start.' };
const identity = { runId: 'run-1', turnIndex: 0, clientMessageId: 'initial-1' };
const timestamp = '2026-08-10T00:00:00.000Z';

function settled(status: 'completed' | 'failed' | 'waiting_input' | 'aborted') {
  return { turnId: 'turn-1', status, confidence: 'native' as const, observedAt: new Date().toISOString(), rawRefs: [] };
}

function persistedRun(): { attempt: RunAttempt; manifest: RunManifest } {
  const attempt: RunAttempt = {
    schemaVersion: 1,
    runId: 'run-1',
    experimentId: 'experiment-1',
    caseId: 'case-1',
    candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-test' },
    policy: { wallClockMs: 1, maxTargetTurns: 3, maxModelCalls: 1, turnTimeoutMs: 50, maxConsecutiveNoProgress: 1 },
    createdAt: timestamp,
  };
  return {
    attempt,
    manifest: {
      schemaVersion: 1,
      attempt,
      resolvedModel: { requested: 'gpt-test', resolved: 'gpt-test' },
      runtime: { productId: 'codex', executable: 'codex.exe' },
      environment: { environmentId: 'environment-1', workspacePath: 'C:/safe/workspace' },
      controller: {
        providerId: 'test', requestedModel: 'test',
        budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
      },
      comparison: {
        providerId: 'test', requestedModel: 'test',
        budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
      },
      startedAt: timestamp,
    },
  };
}

async function temporaryExperiment(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'reprise-candidate-run-'));
}

test('CandidateRun accepts an initial message, waits for settlement, and records all state transitions', async () => {
  const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
  const run = new CandidateRun({ runner, policy, release: async () => ({ status: 'released' }) });
  assert.equal(await run.start(initial, identity), 'awaiting_controller');
  assert.deepEqual(run.states(), ['created', 'preparing', 'launching', 'awaiting_target', 'awaiting_controller']);
  assert.equal(await run.settleController('satisfied'), 'finished');
  assert.equal(run.result().outcome.termination.code, 'completed.controller_satisfied');
  assert.equal(run.result().outcome.termination.failure, undefined);
  assert.equal(runner.started.length, 1);
  assert.equal(runner.stopped, 'completed');
});

test('CandidateRun failBeforeStart never delivers a Target user message', async () => {
  const runner = new ScriptedRunner([], []);
  const run = new CandidateRun({ runner, policy });
  assert.equal(await run.failBeforeStart({ code: 'invalid_output', message: 'Opening decision must be send.' }), 'finished');
  assert.equal(runner.started.length, 0);
  assert.equal(run.result().outcome.termination.code, 'failed.controller');
  assert.equal(run.result().outcome.termination.failure?.code, 'invalid_output');
});

test('CandidateRun distinguishes rejected and unknown delivery without resending', async () => {
  const rejected = new CandidateRun({ runner: new ScriptedRunner([{ delivery: 'rejected', evidence: 'rpc_response' }], []), policy });
  assert.equal(await rejected.start(initial, identity), 'finished');
  assert.equal(rejected.result().outcome.termination.code, 'blocked.input_rejected');
  assert.equal(rejected.result().outcome.termination.failure, undefined);

  const unknownRunner = new ScriptedRunner([{ delivery: 'unknown', evidence: 'rpc_response' }], []);
  const unknown = new CandidateRun({ runner: unknownRunner, policy });
  assert.equal(await unknown.start(initial, identity), 'finished');
  assert.equal(unknown.result().outcome.termination.code, 'uncertain.input_delivery');
  assert.equal(unknownRunner.started.length, 1);
});

test('CandidateRun rejects a reused clientMessageId with different text', async () => {
  const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
  const run = new CandidateRun({ runner, policy });
  const pending = run.start(initial, identity);
  await assert.rejects(run.start({ id: 'message-1', text: 'Other.' }, identity), /already used/);
  assert.equal(await pending, 'awaiting_controller');
});

test('CandidateRun enforces settlement, turn budgets, cancellation, crash, timeout, and cleanup facts', async () => {
  const budgetRunner = new ScriptedRunner(
    [{ delivery: 'accepted', evidence: 'native_admission' }, { delivery: 'accepted', evidence: 'native_admission' }],
    [settled('waiting_input'), settled('waiting_input')],
  );
  const budget = new CandidateRun({ runner: budgetRunner, policy: { ...policy, maxTargetTurns: 2 } });
  await budget.start(initial, identity);
  const next = { id: 'message-2', text: 'Continue.' };
  const nextIdentity = { runId: 'run-1', turnIndex: 1, clientMessageId: 'next-1' };
  const first = budget.submit(next, nextIdentity);
  const retried = budget.submit(next, nextIdentity);
  assert.equal(await first, 'finished');
  assert.equal(await retried, 'finished');
  assert.equal(budgetRunner.sent.length, 1);
  assert.equal(budget.result().outcome.termination.code, 'limit.target_turns');
  await assert.rejects(budget.submit(next, { ...nextIdentity, clientMessageId: 'next-2' }), /finished/);

  const cancelled = new CandidateRun({ runner: new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]), policy });
  await cancelled.start(initial, identity);
  await cancelled.cancel();
  assert.equal(cancelled.result().outcome.termination.code, 'cancelled.user');

  const crashed = new CandidateRun({ runner: new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [new Error('process exited')]), policy });
  assert.equal(await crashed.start(initial, identity), 'finished');
  assert.equal(crashed.result().outcome.termination.code, 'failed.runtime');
  assert.equal(crashed.result().outcome.termination.failure?.origin, 'runtime');

  const timeout = new CandidateRun({ runner: new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [new Promise(() => {})]), policy: { ...policy, turnTimeoutMs: 1 } });
  assert.equal(await timeout.start(initial, identity), 'finished');
  assert.equal(timeout.result().outcome.termination.code, 'limit.turn_timeout');

  const cleanup = new CandidateRun({ runner: new ScriptedRunner([{ delivery: 'rejected', evidence: 'rpc_response' }], [], new Error('cannot stop')), policy, release: async () => { throw new Error('cannot release'); } });
  await cleanup.start(initial, identity);
  assert.equal(cleanup.result().outcome.termination.code, 'blocked.input_rejected');
  assert.equal(cleanup.result().outcome.cleanup.status, 'incomplete');
});

test('CandidateRun records unknown cleanup when runtime stop exceeds the bound', async () => {
  const runner = new ScriptedRunner(
    [{ delivery: 'accepted', evidence: 'native_admission' }],
    [settled('waiting_input')],
    undefined,
    { hangStop: true },
  );
  const run = new CandidateRun({
    runner,
    policy: { ...policy, cleanupTimeoutMs: 20 },
    release: async () => ({ status: 'released' }),
  });
  await run.start(initial, identity);
  assert.equal(await run.settleController('satisfied'), 'finished');
  assert.equal(run.result().outcome.cleanup.status, 'unknown');
  assert.deepEqual(run.result().outcome.cleanup.remainingResourceIds, ['runtime']);
});

test('CandidateRun records failed and aborted settlements with causes and cleanup evidence', async () => {
  for (const settlementStatus of ['failed', 'aborted'] as const) {
    const root = await temporaryExperiment();
    try {
      const store = await ExperimentStore.open(root, 'experiment-1');
      await store.acquireWriter();
      const { attempt, manifest } = persistedRun();
      const runner = new ScriptedRunner(
        [{ delivery: 'accepted', evidence: 'native_admission' }],
        [settled(settlementStatus)],
      );
      const run = new CandidateRun({
        runner,
        policy,
        release: async () => ({ status: 'released' }),
        persistence: { journal: store, attempt, manifest },
      });

      assert.equal(await run.start(initial, identity), 'finished');
      const result = run.result();
      const failure = result.outcome.termination.failure;
      assert.equal(result.outcome.termination.code, 'failed.runtime');
      assert.equal(failure?.code, 'failed.runtime');
      assert.equal(failure?.message, `Target turn settled as ${settlementStatus}.`);
      assert.notEqual(failure?.message, 'undefined');
      assert.notEqual(failure?.message, 'undefined');
      assert.ok(result.record);
      assert.deepEqual(result.record?.outcome, result.outcome);

      const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; eventId: string; payload: unknown });
      const outcomeEvent = events.find((event) => event.type === 'run.outcome_created');
      const cleanupEvents = events.filter((event) => ['runtime.stop_completed', 'runtime.stop_failed', 'environment.release_completed', 'environment.release_failed'].includes(event.type));
      assert.ok(outcomeEvent);
      assert.deepEqual(outcomeEvent?.payload, result.outcome);
      assert.deepEqual(result.outcome.cleanup.evidenceRefs, cleanupEvents.map((event) => `event:${event.eventId}`));
      assert.equal(result.outcome.cleanup.status, 'complete');
      await store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('CandidateRun maps an upstream settlement into a classified runtime failure', async () => {
  const runner = new ScriptedRunner(
    [{ delivery: 'accepted', evidence: 'native_admission' }],
    [{
      turnId: 'turn-1',
      status: 'failed',
      confidence: 'native',
      observedAt: new Date().toISOString(),
      rawRefs: [],
      failure: { kind: 'upstream', summary: 'HTTP 503 from the model endpoint.', retryable: true, reconnectCount: 5 },
    }],
  );
  const run = new CandidateRun({ runner, policy, release: async () => ({ status: 'released' }) });
  assert.equal(await run.start(initial, identity), 'finished');
  const failure = run.result().outcome.termination.failure;
  assert.equal(run.result().outcome.termination.code, 'failed.runtime');
  assert.equal(failure?.code, 'failed.runtime.upstream_unavailable');
  assert.equal(failure?.message, 'HTTP 503 from the model endpoint.');
  assert.equal(run.result().outcome.cleanup.status, 'complete');
});

test('CandidateRun records a controller safety stop without claiming a user cancellation', async () => {
  const run = new CandidateRun({
    runner: new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]),
    policy,
  });
  await run.start(initial, identity);
  assert.equal(await run.settleController('no_further_value'), 'finished');
  assert.equal(run.result().outcome.termination.kind, 'stalled');
  assert.equal(run.result().outcome.termination.initiatedBy, 'controller');
});

test('CandidateRun applies its turn timeout to the runner and clears a settled turn timer', async () => {
  class ImmediateRunner extends ScriptedRunner {
    timeout: number | undefined;
    override setRequestTimeout(milliseconds: number): void { this.timeout = milliseconds; }
  }
  const runner = new ImmediateRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
  const run = new CandidateRun({ runner, policy: { ...policy, turnTimeoutMs: 60_000 } });
  assert.equal(await run.start(initial, identity), 'awaiting_controller');
  assert.equal(runner.timeout, 60_000);
});

test('CandidateRun lets cancellation win over an in-flight target wait', async () => {
  const run = new CandidateRun({
    runner: new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [new Promise(() => {})]),
    policy: { ...policy, turnTimeoutMs: 50 },
  });
  const starting = run.start(initial, identity);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  assert.equal(await run.cancel(), 'finished');
  assert.equal(await starting, 'finished');
  assert.equal(run.result().outcome.termination.code, 'cancelled.user');
  assert.deepEqual(run.states().slice(-2), ['finalizing', 'finished']);
});

test('CandidateRun persists attempt, manifest, facts, and terminal record in one trace', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const { attempt, manifest } = persistedRun();
    const artifactRefs = [{ artifactId: 'candidate-workspace.patch', experimentId: 'experiment-1', runId: 'run-1' }];
    const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
    const run = new CandidateRun({ runner, policy, persistence: { journal: store, attempt, manifest, artifactRefs } });
    const first = run.start(initial, identity);
    const retry = run.start(initial, identity);
    assert.equal(await first, 'awaiting_controller');
    assert.equal(await retry, 'awaiting_controller');
    assert.equal(runner.started.length, 1);
    await run.settleController('satisfied');

    const result = run.result();
    assert.equal(Value.Check(RunRecordSchema, result.record), true);
    assert.equal(result.record?.session?.sessionId, 'scripted-session');
    assert.equal(result.record?.trace.lastSequence, store.nextSequence() - 1);
    assert.deepEqual(result.record?.artifactRefs, artifactRefs);
    const replay = store.replay('run-1');
    assert.deepEqual(replay.attempt, attempt);
    assert.deepEqual(replay.manifest, manifest);
    assert.deepEqual(replay.finishedPayload, result.record);
    assert.deepEqual((replay.finishedPayload as { artifactRefs: unknown }).artifactRefs, artifactRefs);

    const events = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; payload?: { text?: string } });
    assert.equal(events.findIndex((event) => event.type === 'run.attempt_created') < events.findIndex((event) => event.type === 'run.manifest_created'), true);
    assert.equal(events.find((event) => event.type === 'input.submitted')?.payload?.text, 'Start.');
    assert.ok(events.some((event) => event.type === 'candidate.session_bound'));
    assert.equal(events.at(-1)?.type, 'run.finished');
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CandidateRun captures artifacts before it releases its isolated workspace', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const { attempt, manifest } = persistedRun();
    let released = false;
    const captured = [{ artifactId: 'candidate-workspace.diff', experimentId: 'experiment-1', runId: 'run-1' }];
    const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
    const run = new CandidateRun({
      runner, policy,
      release: async () => { released = true; return { status: 'released' }; },
      persistence: {
        journal: store, attempt, manifest,
        captureArtifacts: async () => {
          assert.equal(released, false);
          return captured;
        },
      },
    });
    await run.start(initial, identity);
    await run.settleController('satisfied');
    assert.deepEqual(run.result().record?.artifactRefs, captured);
    assert.equal(released, true);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CandidateRun persists a preparation failure without a manifest as not assessed', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const { attempt } = persistedRun();
    const runner = new ScriptedRunner([], []);
    const run = new CandidateRun({ runner, policy, persistence: { journal: store, attempt } });
    assert.equal(await run.start(initial, identity), 'finished');
    assert.equal(runner.started.length, 0);
    assert.equal(run.result().outcome.task.status, 'not_assessed');
    assert.equal(store.replay('run-1').manifest, undefined);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CandidateRun records cancel requested before finish and ignores a late settlement', async () => {
  let settle!: (value: ReturnType<typeof settled>) => void;
  const pending = new Promise<ReturnType<typeof settled>>((resolve) => { settle = resolve; });
  const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [pending]);
  const run = new CandidateRun({ runner, policy: { turnTimeoutMs: 5_000, maxTargetTurns: 3 } });
  const started = run.start(initial, identity);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(await run.cancel(), 'finished');
  assert.equal(run.result().outcome.termination.code, 'cancelled.user');
  settle(settled('waiting_input'));
  assert.equal(await started, 'finished');
  assert.equal(run.result().outcome.termination.code, 'cancelled.user');
  assert.equal(run.states().at(-1), 'finished');
});

test('CandidateRun commits the attempt before the runtime sees the first message', async () => {
  const root = await temporaryExperiment();
  try {
    const store = await ExperimentStore.open(root, 'experiment-1');
    await store.acquireWriter();
    const { attempt, manifest } = persistedRun();
    const order: string[] = [];
    const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [settled('waiting_input')]);
    const originalStart = runner.start.bind(runner);
    runner.start = async (message, identity) => {
      order.push('runtime');
      return originalStart(message, identity);
    };
    const run = new CandidateRun({
      runner,
      policy,
      persistence: {
        journal: {
          commitAttempt: async (value, operationId) => {
            order.push('attempt');
            return store.commitAttempt(value, operationId);
          },
          commitManifest: (value, operationId) => store.commitManifest(value, operationId),
          append: (event) => store.append(event),
          nextSequence: () => store.nextSequence(),
          events: (runId) => store.events(runId),
        },
        attempt,
        manifest,
      },
    });
    await run.start(initial, identity);
    assert.deepEqual(order.slice(0, 2), ['attempt', 'runtime']);
    await run.cancel();
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ModelCallRunner extends ScriptedRunner {
  readonly #sink: ReturnType<typeof createCandidateRuntimeSink>;
  readonly #kind: 'turn_started' | 'usage_reported';

  constructor(
    sink: ReturnType<typeof createCandidateRuntimeSink>,
    kind: 'turn_started' | 'usage_reported',
    deliveries: ConstructorParameters<typeof ScriptedRunner>[0],
    settlements: ConstructorParameters<typeof ScriptedRunner>[1],
  ) {
    super(deliveries, settlements);
    this.#sink = sink;
    this.#kind = kind;
  }

  override async waitForTurn() {
    await this.#sink.append(runtimeTargetEvent(this.#kind, { sessionId: this.handle.sessionId, evidenceRefs: [] }));
    return super.waitForTurn();
  }
}

function multiTurn(count: number) {
  return {
    deliveries: Array.from({ length: count }, () => ({ delivery: 'accepted' as const, evidence: 'native_admission' as const })),
    settlements: Array.from({ length: count }, (_, index) => ({
      turnId: `turn-${index + 1}`,
      status: 'waiting_input' as const,
      confidence: 'native' as const,
      observedAt: new Date().toISOString(),
      rawRefs: [],
    })),
  };
}

test('CandidateRun truncates on countable Target model calls and not when the Runtime emits none', async () => {
  const countedRoot = await temporaryExperiment();
  const silentRoot = await temporaryExperiment();
  try {
    const countedStore = await ExperimentStore.open(countedRoot, 'experiment-1');
    await countedStore.acquireWriter();
    const { attempt, manifest } = persistedRun();
    const countedSink = createCandidateRuntimeSink({
      journal: countedStore,
      runId: attempt.runId,
      sessionId: () => 'scripted-session',
    });
    const countedTurns = multiTurn(3);
    const counted = new CandidateRun({
      runner: new ModelCallRunner(countedSink, 'turn_started', countedTurns.deliveries, countedTurns.settlements),
      policy: { turnTimeoutMs: 50, maxTargetTurns: 8, maxModelCalls: 1 },
      persistence: { journal: countedStore, attempt, manifest },
    });
    assert.equal(await counted.start(initial, identity), 'finished');
    assert.equal(counted.result().outcome.termination.code, 'limit.model_calls');
    await countedStore.close();

    const silentStore = await ExperimentStore.open(silentRoot, 'experiment-1');
    await silentStore.acquireWriter();
    const silentTurns = multiTurn(2);
    const silent = new CandidateRun({
      runner: new ScriptedRunner(silentTurns.deliveries, silentTurns.settlements),
      policy: { turnTimeoutMs: 50, maxTargetTurns: 8, maxModelCalls: 1 },
      persistence: { journal: silentStore, attempt, manifest },
    });
    assert.equal(await silent.start(initial, identity), 'awaiting_controller');
    assert.equal(await silent.submit({ id: 'message-2', text: 'Continue.' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'next-1' }), 'awaiting_controller');
    assert.equal(await silent.settleController('satisfied'), 'finished');
    assert.equal(silent.result().outcome.termination.code, 'completed.controller_satisfied');
    await silentStore.close();
  } finally {
    await rm(countedRoot, { recursive: true, force: true });
    await rm(silentRoot, { recursive: true, force: true });
  }
});

test('CandidateRun stalls after consecutive identical workspace fingerprints and resets when a file changes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'reprise-candidate-fp-'));
  try {
    await writeFile(join(workspace, 'note.txt'), 'same\n');
    const turns = multiTurn(4);
    const stalled = new CandidateRun({
      runner: new ScriptedRunner(turns.deliveries, turns.settlements),
      policy: { turnTimeoutMs: 50, maxTargetTurns: 8, maxConsecutiveNoProgress: 2 },
      progressFingerprint: () => workspaceProgressFingerprint(workspace),
    });
    assert.equal(await stalled.start(initial, identity), 'awaiting_controller');
    assert.equal(await stalled.submit({ id: 'message-2', text: 'Again.' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'next-1' }), 'awaiting_controller');
    assert.equal(await stalled.submit({ id: 'message-3', text: 'Again.' }, { runId: 'run-1', turnIndex: 2, clientMessageId: 'next-2' }), 'finished');
    assert.equal(stalled.result().outcome.termination.code, 'stalled.no_progress');

    await writeFile(join(workspace, 'note.txt'), 'same\n');
    const progressing = new CandidateRun({
      runner: new ScriptedRunner(turns.deliveries, turns.settlements),
      policy: { turnTimeoutMs: 50, maxTargetTurns: 8, maxConsecutiveNoProgress: 2 },
      progressFingerprint: () => workspaceProgressFingerprint(workspace),
    });
    assert.equal(await progressing.start(initial, identity), 'awaiting_controller');
    await writeFile(join(workspace, 'note.txt'), 'changed\n');
    assert.equal(await progressing.submit({ id: 'message-2', text: 'Again.' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'next-1' }), 'awaiting_controller');
    await mkdir(join(workspace, '.reprise'), { recursive: true });
    await writeFile(join(workspace, '.reprise', 'noise.txt'), 'ignored\n');
    assert.equal(await progressing.submit({ id: 'message-3', text: 'Again.' }, { runId: 'run-1', turnIndex: 2, clientMessageId: 'next-2' }), 'awaiting_controller');
    assert.equal(await progressing.settleController('satisfied'), 'finished');
    assert.equal(progressing.result().outcome.termination.code, 'completed.controller_satisfied');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
