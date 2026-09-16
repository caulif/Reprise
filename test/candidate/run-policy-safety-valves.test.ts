import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CandidateRun } from '../../src/application/candidate-run.js';
import { createCandidateRuntimeSink } from '../../src/application/candidate-run-events.js';
import { workspaceProgressFingerprint } from '../../src/application/candidate-run-safety.js';
import { runtimeTargetEvent } from '../../src/core/runtime.js';
import type { RunAttempt, RunManifest } from '../../src/core/schema.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { ScriptedRunner } from '../support/scripted-runtime.js';

const initial = { id: 'message-1', text: 'Start.' };
const identity = { runId: 'run-1', turnIndex: 0, clientMessageId: 'initial-1' };
const timestamp = '2026-08-10T00:00:00.000Z';

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
  const countedRoot = await mkdtemp(join(tmpdir(), 'reprise-candidate-calls-'));
  const silentRoot = await mkdtemp(join(tmpdir(), 'reprise-candidate-silent-'));
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
