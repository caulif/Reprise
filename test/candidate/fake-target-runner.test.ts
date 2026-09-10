import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { CandidateRun } from '../../src/application/candidate-run.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { CandidateRuntimeEventSchema, CandidateRuntimeEventTypeSchema, UserVisibleTurnSchema } from '../../src/core/schema.js';
import { isCandidateRuntimeJournalType } from '../../src/core/runtime.js';
import { assertCandidateRuntimeJournal, candidateRuntimeJournalPayload } from '../../src/application/candidate-run-events.js';
import { FakeProductRuntime, type FakeRunnerMode } from '../fixtures/fake-pack/runtime.js';
import { fakeActivityTranslator } from '../fixtures/fake-pack/projection.js';

const identity = { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' };
const message = { id: 'm1', text: 'ping' };

async function runner(mode: FakeRunnerMode, root: string, events: { type: string; payload: unknown }[]) {
  const runtime = new FakeProductRuntime();
  runtime.mode = mode;
  const resolved = await runtime.validateCandidate({ productId: 'fake', requestedModel: 'fake-model' });
  const environment = { environmentId: 'env-1', runId: 'run-1', root };
  return runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event); } },
    candidateLaunchFor(resolved, environment),
  );
}

test('Fake runner rejects a workspace that is not CandidateLaunchContext.workspaceRoot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-launch-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const runtime = new FakeProductRuntime();
  const resolved = await runtime.validateCandidate({ productId: 'fake', requestedModel: 'fake-model' });
  await assert.rejects(
    runtime.createRunner(
      resolved,
      { environmentId: 'env-1', runId: 'run-1', root },
      { append: async () => undefined },
      candidateLaunchFor(resolved, { runId: 'run-1', root: join(root, 'other') }),
    ),
    /workspaceRoot/,
  );
});

test('Fake runner covers accepted complete, rejected, unknown, waiting, failed, timeout, and late cancel', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-modes-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const acceptedEvents: { type: string; payload: unknown }[] = [];
  const accepted = await runner('accepted-complete', root, acceptedEvents);
  const receipt = await accepted.start(message, identity);
  assert.equal(receipt.delivery, 'accepted');
  const settlement = await accepted.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(accepted.session().sessionId, 'fake-session-1');
  await accepted.close();
  assert.ok(acceptedEvents.some((event) => event.type === 'runtime.session_started'));
  assert.ok(acceptedEvents.some((event) => event.type === 'runtime.visible_output'));
  assert.ok(acceptedEvents.some((event) => event.type === 'runtime.turn_settled'));
  assert.equal(acceptedEvents.every((event) => isCandidateRuntimeJournalType(event.type)), true);

  const rejected = await runner('rejected', root, []);
  assert.equal((await rejected.start(message, identity)).delivery, 'rejected');

  const unknown = await runner('unknown-delivery', root, []);
  assert.equal((await unknown.start(message, identity)).delivery, 'unknown');

  const waiting = await runner('waiting-input', root, []);
  await waiting.start(message, identity);
  assert.equal((await waiting.waitForTurn()).status, 'waiting_input');

  const failed = await runner('failed', root, []);
  await failed.start(message, identity);
  assert.equal((await failed.waitForTurn()).status, 'failed');

  const timed = await runner('timeout', root, []);
  await timed.start(message, identity);
  const wait = timed.waitForTurn();
  timed.cancelWait('Harness stopped waiting for this turn.');
  await assert.rejects(wait, /Harness stopped waiting/);

  const lateEvents: { type: string; payload: unknown }[] = [];
  const late = await runner('cancel-late', root, lateEvents);
  await late.start(message, identity);
  await assert.rejects(late.waitForTurn(), /Harness stopped waiting/);
});

test('CandidateRun binds the Fake session and closes it after settlement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-run-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const events: { type: string; payload: unknown }[] = [];
  const target = await runner('accepted-complete', root, events);
  const run = new CandidateRun({
    runner: target,
    policy: { turnTimeoutMs: 200, maxTargetTurns: 2 },
  });
  await run.start(message, identity);
  await run.settleController('satisfied');
  assert.equal(run.session().sessionId, 'fake-session-1');
  assert.equal(run.states().at(-1), 'finished');
});

test('UserVisibleTurn projection is deterministic for the Fake event sequence', () => {
  const settlement = {
    turnId: 'fake-turn-1',
    status: 'completed' as const,
    confidence: 'native' as const,
    observedAt: '2026-09-09T00:00:01.000Z',
    rawRefs: [],
  };
  const events = [{
    schemaVersion: 1 as const,
    sequence: 1,
    eventId: 'evt-1',
    occurredAt: '2026-09-09T00:00:00.000Z',
    type: 'runtime.visible_output',
    payload: { text: 'Done.' },
    checksum: '0'.repeat(64),
  }];
  const view = fakeActivityTranslator.projectTurn({
    turnIndex: 1,
    settlement,
    events,
    allowModelText: true,
  });
  assert.equal(Value.Check(UserVisibleTurnSchema, view), true);
  assert.equal(view.status, 'completed');
  assert.equal(view.assistantText, 'Done.');
  const again = fakeActivityTranslator.projectTurn({
    turnIndex: 1,
    settlement,
    events,
    allowModelText: true,
  });
  assert.deepEqual(view, again);
  const blocked = fakeActivityTranslator.projectTurn({
    turnIndex: 1,
    settlement,
    events,
    allowModelText: false,
  });
  assert.equal(blocked.status, 'unavailable');
});

test('CandidateRuntimeEvent schema is the journal payload, not a top-level envelope', () => {
  const payload = {
    schemaVersion: 1,
    sessionId: 'fake-session-1',
    evidenceRefs: [],
  };
  assert.equal(Value.Check(CandidateRuntimeEventSchema, payload), true);
  assert.equal(Value.Check(CandidateRuntimeEventTypeSchema, 'session_started'), true);
  assert.equal(Value.Check(CandidateRuntimeEventSchema, { evidenceRefs: [] }), false);
  assert.equal(Value.Check(CandidateRuntimeEventSchema, {
    eventId: 'evt-1',
    sequence: 1,
    type: 'session_started',
    occurredAt: '2026-09-09T00:00:00.000Z',
    payload: {},
    evidenceRefs: [],
  }), false);
});

test('journal types accept only runtime.<CandidateRuntimeEventType>', () => {
  assert.equal(isCandidateRuntimeJournalType('runtime.session_started'), true);
  assert.equal(isCandidateRuntimeJournalType('codex.item_completed'), false);
  assert.equal(isCandidateRuntimeJournalType('runtime.heartbeat'), false);
});

test('candidate runtime journal payload carries sessionId and evidenceRefs', () => {
  const payload = candidateRuntimeJournalPayload('sess-1', { item: { type: 'agentMessage', text: 'hi' } });
  assert.equal(payload.sessionId, 'sess-1');
  assert.deepEqual(payload.evidenceRefs, []);
  assert.equal((payload.item as { type?: string }).type, 'agentMessage');
  const envelope = {
    schemaVersion: 1 as const,
    sequence: 1,
    eventId: 'evt-1',
    occurredAt: '2026-09-09T00:00:00.000Z',
    type: 'runtime.visible_output',
    payload,
    checksum: '0'.repeat(64),
  };
  assert.equal(Value.Check(CandidateRuntimeEventSchema, payload), true);
  assertCandidateRuntimeJournal(envelope);
  assert.throws(() => assertCandidateRuntimeJournal({ ...envelope, type: 'codex.item_completed' }));
  assert.throws(() => assertCandidateRuntimeJournal({ ...envelope, payload: { evidenceRefs: [] } }));
});
