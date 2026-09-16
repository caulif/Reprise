import test from "node:test";
import assert from "node:assert/strict";
import { ControllerAgent, type SteeringContext } from "../../src/agents/controller-agent.js";
import { PiAgentHost, type PiTextCaller } from "../../src/infrastructure/agent/host.js";

function context(overrides: Partial<SteeringContext> = {}): SteeringContext {
  return {
    requestId: "controller-request-run-1-1",
    runId: "run-1",
    runState: "created",
    phase: "opening",
    task: {
      initialInput: { id: "message-1", role: "user", text: "Implement it." },
      baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: "Candidate turn has not started.", evidenceRefs: [] },
    trajectory: { summary: "Settled turns: 0.", evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 0, decisionsLimit: 3 },
    promptContent: "phase=opening\n",
    ...overrides,
  };
}

function caller(responses: string[]): PiTextCaller {
  return {
    createSession() {
      return {
        append: async () => {
          const next = responses.shift();
          if (next === undefined) throw new Error("unexpected extra append");
          return next;
        },
        cancel() {},
      };
    },
  };
}

function agent(responses: string[]): ControllerAgent {
  return new ControllerAgent({
    host: new PiAgentHost(caller(responses)),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
}

test("wording that used to be Host-term or unseen-advice still completes", async () => {
  const hostTerm = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "Please read INDEX.md and current-user-view.md", intent: "continue" }),
  ]).decide(context());
  assert.equal(hostTerm.status, "completed");
  const unseen = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "按你建议的优先级来。", intent: "continue" }),
  ]).decide(context());
  assert.equal(unseen.status, "completed");
});

test("precise Controller contracts still reject", async () => {
  const openingDone = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "done", reason: "satisfied" }),
  ]).decide(context());
  assert.equal(openingDone.status, "failed");
  if (openingDone.status === "failed") assert.match(openingDone.failure.message, /opening decision must be send/);

  const blank = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "   ", intent: "continue" }),
  ]).decide(context());
  assert.equal(blank.status, "failed");
  if (blank.status === "failed") assert.match(blank.failure.message, /message must not be blank/);

  const control = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "hello\u0001world", intent: "continue" }),
  ]).decide(context());
  assert.equal(control.status, "failed");
  if (control.status === "failed") assert.match(control.failure.message, /disallowed control character/);

  const unknown = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "Continue.", intent: "continue", evidenceRefs: ["event:foreign-1"] }),
  ]).decide(context());
  assert.equal(unknown.status, "failed");
  if (unknown.status === "failed") assert.match(unknown.failure.message, /unknown evidence reference/);

  const oversized = await agent([
    "understood the historical user demand.",
    JSON.stringify({ type: "send", message: "x".repeat(65_537), intent: "continue" }),
  ]).decide(context());
  assert.equal(oversized.status, "failed");
  if (oversized.status === "failed") assert.match(oversized.failure.message, /exceeds 65536 bytes/);
});
