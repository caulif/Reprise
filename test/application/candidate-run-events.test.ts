import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";
import { runOperationId } from "../../src/core/identity.js";
import { isRecord, text } from "../../src/core/json.js";
import {
  appendCandidateRuntimeEvent,
  CandidateRuntimeJournalError,
  createCandidateRuntimeSink,
} from "../../src/application/candidate-run-events.js";

test("appendCandidateRuntimeEvent rejects illegal type, session, sequence, late, and duplicate writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-runtime-journal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, "exp-1");
  await store.acquireWriter();
  t.after(() => store.close());
  await assert.rejects(
    appendCandidateRuntimeEvent({ journal: store, runId: "run-1", sessionId: "sess-1", type: "controller.started", payload: {} }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "type",
  );
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: { sequence: 9, evidenceRefs: [] },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "sequence",
  );
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: { sessionId: "other", evidenceRefs: [] },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "session",
  );
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "",
      type: "runtime.visible_output",
      payload: { evidenceRefs: [] },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "session",
  );
  const first = await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.session_started",
    payload: { productId: "fake" },
    occurredAt: "2026-09-10T00:00:00.000Z",
  });
  const visible = await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.visible_output",
    payload: { text: "hello" },
    occurredAt: "2026-09-10T00:00:01.000Z",
  });
  assert.equal(text(isRecord(visible.payload) ? visible.payload.sessionId : undefined), "sess-1");
  const again = await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.visible_output",
    payload: { text: "hello" },
    occurredAt: "2026-09-10T00:00:01.000Z",
  });
  assert.equal(again.eventId, visible.eventId);
  assert.ok(first.eventId);
  await store.append({ type: "run.outcome_created", runId: "run-1", operationId: "outcome", payload: {} });
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.session_closed",
      payload: {},
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "late",
  );
});

test("createCandidateRuntimeSink fills session ownership for adapter TargetEvents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-runtime-sink-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, "exp-1");
  await store.acquireWriter();
  t.after(() => store.close());
  const committed: string[] = [];
  const sink = createCandidateRuntimeSink({
    journal: store,
    runId: "run-1",
    sessionId: () => "sess-live",
    onCommitted: (event) => committed.push(event.eventId),
  });
  await sink.append({ type: "runtime.session_started", occurredAt: "2026-09-10T00:00:01.000Z", payload: { productId: "fake" } });
  const row = store.events("run-1")[0];
  assert.equal(text(isRecord(row?.payload) ? row.payload.sessionId : undefined), "sess-live");
  assert.equal(committed.length, 1);
});

test('runtime explicit and fingerprint operation IDs are scoped once per run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-runtime-run-ids-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const operationIds: (string | undefined)[] = [];
  for (const runId of ['run-1', 'run-2']) {
    await appendCandidateRuntimeEvent({ journal: store, runId, sessionId: 'sess-1', type: 'runtime.session_started', payload: { productId: 'fake' } });
    const explicit = await appendCandidateRuntimeEvent({ journal: store, runId, sessionId: 'sess-1', type: 'runtime.visible_output', payload: { text: 'explicit' }, operationId: 'same-local' });
    assert.equal(explicit.operationId, runOperationId(runId, 'same-local'));
    const fingerprint = await appendCandidateRuntimeEvent({ journal: store, runId, sessionId: 'sess-1', type: 'runtime.visible_output', payload: { text: 'fingerprint' }, occurredAt: '2026-09-10T00:00:01.000Z' });
    assert.equal((await appendCandidateRuntimeEvent({ journal: store, runId, sessionId: 'sess-1', type: 'runtime.visible_output', payload: { text: 'explicit' }, operationId: 'same-local' })).eventId, explicit.eventId);
    assert.equal((await appendCandidateRuntimeEvent({ journal: store, runId, sessionId: 'sess-1', type: 'runtime.visible_output', payload: { text: 'fingerprint' }, occurredAt: '2026-09-10T00:00:01.000Z' })).eventId, fingerprint.eventId);
    operationIds.push(explicit.operationId, fingerprint.operationId);
  }
  assert.equal(new Set(operationIds).size, 4);
  assert.equal(store.events().length, 6);
});

test("appendCandidateRuntimeEvent rejects turn, message, call, and lifecycle affiliation errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-runtime-affiliation-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = await ExperimentStore.open(root, "exp-1");
  await store.acquireWriter();
  t.after(() => store.close());
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: {},
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "lifecycle",
  );
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.session_started",
    payload: { productId: "fake" },
  });
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: { turnId: "turn-ghost" },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "turn",
  );
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.delivery_observed",
    payload: { turnId: "turn-1", messageId: "msg-1" },
  });
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.visible_output",
    payload: { turnId: "turn-1", messageId: "msg-1" },
  });
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.turn_settled",
    payload: { turnId: "turn-1" },
  });
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: { turnId: "turn-1" },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "turn",
  );
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: { messageId: "msg-unknown" },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "message",
  );
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.tool_finished",
    payload: { callId: "call-1" },
  });
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.tool_finished",
      payload: { callId: "call-1" },
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "call",
  );
  await appendCandidateRuntimeEvent({
    journal: store,
    runId: "run-1",
    sessionId: "sess-1",
    type: "runtime.session_closed",
    payload: {},
  });
  await assert.rejects(
    appendCandidateRuntimeEvent({
      journal: store,
      runId: "run-1",
      sessionId: "sess-1",
      type: "runtime.visible_output",
      payload: {},
    }),
    (error: unknown) => error instanceof CandidateRuntimeJournalError && error.code === "lifecycle",
  );
});
