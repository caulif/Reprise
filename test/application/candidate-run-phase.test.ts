import test from "node:test";
import assert from "node:assert/strict";
import { candidateRunDisplayFromEvents, candidateRunPhaseFromEvent } from "../../src/application/candidate-run-phase.js";
import type { EventEnvelope } from "../../src/core/schema.js";

function event(type: string, payload: unknown = {}): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    occurredAt: "2026-09-10T00:00:00.000Z",
    type,
    payload,
    checksum: "a".repeat(64),
  };
}

test("candidate run phase is projected from persisted event types", () => {
  assert.equal(candidateRunPhaseFromEvent(event("recovery.completed")), "recovery");
  assert.equal(candidateRunPhaseFromEvent(event("runtime.session_started")), "candidate_starting");
  assert.equal(candidateRunPhaseFromEvent(event("runtime.turn_started")), "candidate_generating");
  assert.equal(
    candidateRunPhaseFromEvent(event("runtime.runtime_failed", { message: "Reconnecting 1 / 3" })),
    "candidate_reconnecting",
  );
});

test("candidate run display projects machine, failed, and cleanup from outcome events", () => {
  const display = candidateRunDisplayFromEvents([
    event("runtime.session_started"),
    { ...event("run.state_changed", { from: "awaiting_target", to: "awaiting_controller" }), sequence: 2 },
    { ...event("run.state_changed", { from: "awaiting_controller", to: "finalizing" }), sequence: 3 },
    {
      ...event("run.outcome_created", {
        termination: { kind: "failed", code: "failed.runtime", initiatedBy: "harness" },
        cleanup: { status: "unknown" },
      }),
      sequence: 4,
    },
  ]);
  assert.equal(display.livePhase, "candidate_starting");
  assert.equal(display.machineState, "finalizing");
  assert.equal(display.failed, true);
  assert.equal(display.cleanupStatus, "unknown");
  const finished = candidateRunDisplayFromEvents([
    { ...event("run.state_changed", { from: "finalizing", to: "finished" }), sequence: 5 },
    {
      ...event("run.outcome_created", {
        termination: { kind: "completed", code: "completed.controller" },
        cleanup: { status: "complete" },
      }),
      sequence: 6,
    },
  ]);
  assert.equal(finished.machineState, "finished");
  assert.equal(finished.failed, false);
  assert.equal(finished.cleanupStatus, "complete");
});
