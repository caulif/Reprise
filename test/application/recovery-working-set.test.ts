import test from "node:test";
import assert from "node:assert/strict";
import type { RecoveryContext } from "../../src/agents/recovery-agent.js";
import { recoveryModelPrompt, recoveryWorkingSet } from "../../src/agents/recovery-working-set.js";

function fatContext(): RecoveryContext {
  return {
    task: {
      caseId: "case-fat",
      initialInput: { id: "message-1", role: "user", text: `Write slides. ${"x".repeat(12_000)}` },
    },
    session: { transcriptLength: 715, historicalEventCount: 553 },
    clues: {},
    playbook: { productId: "codex", version: "v1", sha256: "d".repeat(64), text: "# playbook body that must not enter the working set\n" },
    staging: { fileCount: 3, totalBytes: 99 },
    budget: { timeoutMs: 600_000 },
    allowModelText: true,
    continuityKey: "case-fat",
  };
}

test("recovery model prompt omits Host-resolved facts, investigation packet, and playbook body", () => {
  const context = fatContext();
  const prompt = recoveryModelPrompt(context);
  assert.doesNotMatch(prompt, /continuityKey/);
  assert.doesNotMatch(prompt, /"resolved"\s*:/);
  assert.doesNotMatch(prompt, /investigationPacket/);
  assert.doesNotMatch(prompt, /playbook body that must not enter/);
  assert.ok(!prompt.includes(context.playbook.text));
  const parsed = JSON.parse(prompt) as ReturnType<typeof recoveryWorkingSet>;
  assert.equal("resolved" in parsed, false);
  assert.equal("investigationPacket" in parsed, false);
  const task = parsed.task as { initialInput: { truncated: boolean; text: string } };
  assert.equal(task.initialInput.truncated, true);
  assert.ok(task.initialInput.text.length < context.task.initialInput.text.length);
  assert.ok(Buffer.byteLength(prompt) < 80_000);
  const observations = parsed.observations as { root: string; index: string };
  assert.equal(observations.root, "observations");
  assert.equal(observations.index, "observations/INDEX.md");
});
