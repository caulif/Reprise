import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { AgentHost, FakeProviderAdapter } from "../../src/infrastructure/agent/host.js";

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
  const asked = await session.request({ context: {}, schema, timeoutMs: 50, maxRepairAttempts: 0, outputContract: "JSON", promptContent: "return the object" });
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
    promptContent: "return the object",
    requestId: "repair-1",
  });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.invocationId, "repair-1");
    assert.deepEqual(result.value, { ok: true });
  }
  await session.close();
});

test("structured request without promptContent throws", async () => {
  const host = new AgentHost(new FakeProviderAdapter(JSON.stringify({ ok: true })));
  const session = await host.createSession({ role: "recovery", systemPrompt: "fixed", allowModelText: true });
  await assert.rejects(
    () => session.request({
      context: { secret: "must-not-dump" },
      schema,
      timeoutMs: 50,
      maxRepairAttempts: 0,
      promptContent: "   ",
    }),
    /requires promptContent/,
  );
  await assert.rejects(
    () => session.request({
      context: { secret: "must-not-dump" },
      schema,
      timeoutMs: 50,
      maxRepairAttempts: 0,
    } as never),
    /requires promptContent/,
  );
  await session.close();
});

test("repair turns do not emit agent.tool_called", async () => {
  const events: { type: string }[] = [];
  let toolsEnabled = true;
  let attempts = 0;
  const host = new AgentHost({
    createSession: (input) => ({
      setToolsEnabled(enabled: boolean) {
        toolsEnabled = enabled;
      },
      append: async () => {
        attempts += 1;
        if (toolsEnabled) {
          await input.tools[0]?.execute({}, new AbortController().signal);
        }
        return attempts === 1 ? "not-json" : JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: "recovery",
    systemPrompt: "fixed",
    allowModelText: true,
    tools: [{
      name: "ls",
      description: "list",
      parameters: schema,
      execute: async () => ({ content: "ok" }),
    }],
    audit: { append: async (event) => { events.push(event); } },
  });
  const result = await session.request({
    context: {},
    schema,
    timeoutMs: 50,
    maxRepairAttempts: 1,
    outputContract: "Return JSON.",
    promptContent: "INDEX.md must not be resent on repair",
    repairInstruction: "Correct only the JSON.",
  });
  assert.equal(result.status, "completed");
  const toolCalls = events.filter((event) => event.type === "agent.tool_called");
  assert.equal(toolCalls.length, 1);
  const repairMessages = events.filter((event) => event.type === "agent.message_appended" && (event as { payload?: { repair?: boolean } }).payload?.repair);
  assert.equal(repairMessages.length, 1);
  const repairPayload = JSON.stringify(repairMessages[0]);
  assert.match(repairPayload, /Your previous reply was invalid/);
  assert.doesNotMatch(repairPayload, /INDEX\.md must not be resent/);
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
