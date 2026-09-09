import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { AgentHost, FakeProviderAdapter } from "../src/infrastructure/agent/host.js";

const schema = Type.Object({ ok: Type.Boolean() });

test("fake adapter supports sequential work then structured request on one Session", async () => {
  const host = new AgentHost(new FakeProviderAdapter((content) => (
    content.includes("JSON") ? JSON.stringify({ ok: true }) : "investigating"
  )));
  const session = await host.createSession({
    role: "comparison",
    systemPrompt: "fixed",
    allowModelText: true,
    model: { providerId: "fake", modelId: "stub" },
    privacy: { allowModelText: true },
  });
  const work = await session.work({ promptContent: "look around", timeoutMs: 50 });
  assert.equal(work.status, "completed");
  if (work.status === "completed") assert.equal(work.value.text, "investigating");
  const asked = await session.request({ context: {}, schema, timeoutMs: 50, maxRepairAttempts: 0, outputContract: "JSON" });
  assert.equal(asked.status, "completed");
  await session.close();
  await session.close();
  const afterClose = await session.work({ promptContent: "again", timeoutMs: 50 });
  assert.equal(afterClose.status, "failed");
  if (afterClose.status === "failed") assert.equal(afterClose.failure.code, "session_closed");
});

test("structured repair stays on the same Session and Invocation", async () => {
  const replies = ["not json", JSON.stringify({ ok: true })];
  const host = new AgentHost(new FakeProviderAdapter(() => replies.shift() ?? ""));
  const session = await host.createSession({ role: "recovery", systemPrompt: "fixed", allowModelText: true });
  const result = await session.request({
    context: {},
    schema,
    timeoutMs: 50,
    maxRepairAttempts: 1,
    outputContract: "Return JSON.",
    requestId: "repair-1",
  });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.invocationId, "repair-1");
    assert.deepEqual(result.value, { ok: true });
  }
  await session.close();
});

test("work never runs JSON repair", async () => {
  const host = new AgentHost(new FakeProviderAdapter("{"));
  const session = await host.createSession({ role: "controller", systemPrompt: "fixed", allowModelText: true });
  const result = await session.work({ promptContent: "prose only", timeoutMs: 50 });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.value.text, "{");
  await assert.rejects(
    () => session.work({ promptContent: "prose only", timeoutMs: 50, maxRepairAttempts: 1 }),
    /cannot run JSON repair/,
  );
  await session.close();
});
