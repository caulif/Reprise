import test from "node:test";
import assert from "node:assert/strict";
import type { RecoveryContext } from "../src/agents/recovery-agent.js";
import { recoveryModelPrompt, recoveryWorkingSet } from "../src/agents/recovery-working-set.js";

function fatContext(): RecoveryContext {
  const catalog = Array.from({ length: 715 }, (_, index) => ({
    ref: `event:transcript-${index}-${"ab".repeat(8)}`,
    source: "transcript" as const,
    index,
    contentHash: "c".repeat(64),
  }));
  return {
    task: {
      caseId: "case-fat",
      initialInput: { id: "message-1", role: "user", text: `Write slides. ${"x".repeat(12_000)}` },
    },
    session: { transcriptLength: 715, historicalEventCount: 553 },
    clues: {},
    resolved: {
      evidenceRefs: catalog.map((entry) => entry.ref),
      catalog,
      patches: [],
      preimages: [],
    },
    investigationPacket: {
      schemaVersion: 1,
      laterUserTurns: [],
      candidatePaths: ["deck.html"],
      preimagePaths: [],
      patchPaths: [],
      isRepo: false,
      truncated: false,
    },
    playbook: { productId: "codex", version: "v1", sha256: "d".repeat(64), text: "# playbook body that must not enter the working set\n" },
    staging: { fileCount: 3, totalBytes: 99 },
    budget: { timeoutMs: 600_000 },
    allowModelText: true,
    continuityKey: "case-fat",
  };
}

test("recovery model prompt omits the thick catalog and playbook body", () => {
  const context = fatContext();
  const prompt = recoveryModelPrompt(context);
  assert.doesNotMatch(prompt, /continuityKey/);
  assert.doesNotMatch(prompt, /"catalog"\s*:/);
  assert.doesNotMatch(prompt, /playbook body that must not enter/);
  assert.ok(!prompt.includes(context.playbook.text));
  const parsed = JSON.parse(prompt) as ReturnType<typeof recoveryWorkingSet>;
  const resolved = parsed.resolved as { catalogCount: number; evidenceRefCount: number; evidenceRefs: string[] };
  assert.equal(resolved.catalogCount, 715);
  assert.equal(resolved.evidenceRefCount, 715);
  assert.equal(resolved.evidenceRefs.length, 16);
  const task = parsed.task as { initialInput: { truncated: boolean; text: string } };
  assert.equal(task.initialInput.truncated, true);
  assert.ok(task.initialInput.text.length < context.task.initialInput.text.length);
  assert.ok(Buffer.byteLength(prompt) < 80_000);
});
