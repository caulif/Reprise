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
    evidence: {
      catalogCount: 2,
      verifiedCount: 1,
      evidenceRefs: ["event:transcript-0-aaaa"],
      verified: [{ ref: "event:transcript-0-aaaa", kind: "historical_event" }],
    },
  };
}

test("recovery model prompt is a text briefing without Host JSON fields", () => {
  const context = fatContext();
  const prompt = recoveryModelPrompt(context);
  assert.match(prompt, /^# Recovery briefing\n/);
  assert.match(prompt, /Task: Write slides\./);
  assert.match(prompt, /\(truncated; full text at observations\/task\/initial-input\.txt\)/);
  assert.match(prompt, /Evidence level: transcript; 715 historical messages, 553 historical events/);
  assert.match(prompt, /Clues: cwd=unknown; historicalCommit=unknown; sourceVersion=unknown/);
  assert.match(prompt, /Playbook: codex v1, text at observations\/playbook\.md/);
  assert.match(prompt, /sample refs: event:transcript-0-aaaa/);
  assert.doesNotMatch(prompt, /schemaVersion/);
  assert.doesNotMatch(prompt, /allowModelText/);
  assert.doesNotMatch(prompt, /timeoutMs/);
  assert.doesNotMatch(prompt, /continuityKey/);
  assert.doesNotMatch(prompt, /investigationPacket/);
  assert.doesNotMatch(prompt, /playbook body that must not enter/);
  assert.ok(!prompt.includes(context.playbook.text));
  assert.ok(!prompt.includes(context.playbook.sha256));
  assert.ok(prompt.length < context.task.initialInput.text.length);
  assert.ok(Buffer.byteLength(prompt) < 80_000);
});

test("recovery briefing includes source summary facts without dumping the tree JSON", () => {
  const context = fatContext();
  context.staging = {
    seed: "sparse",
    fileCount: 0,
    totalBytes: 0,
    sourceMount: "source",
    workspaceAlias: "workspace",
    summaryPath: ".reprise/recovery-work/source-summary.json",
    source: {
      copyEligible: false,
      budgetExceeded: true,
      fileCount: 50_001,
      totalBytes: 2,
      summary: { topLevelCount: 2, truncated: false, entries: [{ name: "apps", kind: "directory" }] },
    },
  };
  const prompt = recoveryModelPrompt(context);
  assert.match(prompt, /Work copy seed: sparse; currently 0 files, 0 bytes/);
  assert.match(prompt, /Source directory: 50001 files, 2 bytes; whole-tree copy eligible=no; copy budget exceeded=yes/);
  assert.doesNotMatch(prompt, /node_modules\/leftpad/);
  const parsed = recoveryWorkingSet(context);
  const staging = parsed.staging as { seed: string; source: { fileCount: number } };
  assert.equal(staging.seed, "sparse");
  assert.equal(staging.source.fileCount, 50_001);
});
