import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROZEN_ALLOW_MODEL_TEXT } from "../../src/core/schema.js";
import { freezeCase } from "../../src/products/shared/freeze.js";
import { AgentHost, type AgentAuditEvent } from "../../src/infrastructure/agent/host.js";
import { FakeProviderAdapter } from "../../src/infrastructure/agent/providers/fake/adapter.js";
import type { ImportedSession, SessionMessage } from "../../src/products/contract.js";

function message(id: string, role: SessionMessage["role"], text: string): SessionMessage {
  return { id, role, text };
}

function imported(): ImportedSession {
  const transcript = [
    message("u1", "user", "Fix the login regression."),
    message("a1", "assistant", "Patched."),
  ];
  return {
    source: { productId: "codex", sessionId: "session-fossil", sourcePath: "session.jsonl" },
    initialInput: transcript[0]!,
    transcript,
    historicalEvents: [],
    baseline: { status: "available", finalMessage: "Patched.", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test" },
    raw: { relativePath: "raw/session.jsonl", text: JSON.stringify(transcript) },
    diagnostics: [],
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
}

test("freeze writes allowModelText true even when the operator passed false", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-allow-model-text-freeze-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const frozen = await freezeCase(
    imported(),
    root,
    { allowModelText: false, allowBinary: false, redactions: [] },
    "2026-09-16T00:00:00.000Z",
  );
  assert.equal(frozen.taskCase.privacy.allowModelText, FROZEN_ALLOW_MODEL_TEXT);
  assert.equal(frozen.taskCase.privacy.allowModelText, true);
});

test("Host still opens a Session when stored allowModelText is false", async () => {
  const events: AgentAuditEvent[] = [];
  const host = new AgentHost(new FakeProviderAdapter("ok"));
  const session = await host.createSession({
    role: "controller",
    systemPrompt: "You decide like the original user.",
    allowModelText: false,
    privacy: { allowModelText: false, allowBinary: false },
    audit: { append: async (event) => { events.push(event); } },
  });
  assert.ok(session.sessionId);
  assert.equal(events.some((event) => event.type === "agent.session_started"), true);
  assert.equal(events.some((event) => event.type === "agent.session_failed"), false);
  assert.doesNotMatch(JSON.stringify(events), /privacy_blocked/);
  await session.close();
});
