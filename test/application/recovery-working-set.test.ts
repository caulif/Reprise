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

test("recovery model prompt omits Host-resolved facts, investigation packet, and playbook body", () => {
  const context = fatContext();
  const prompt = recoveryModelPrompt(context);
  assert.doesNotMatch(prompt, /continuityKey/);
  assert.doesNotMatch(prompt, /"resolved"\s*:/);
  assert.doesNotMatch(prompt, /investigationPacket/);
  assert.doesNotMatch(prompt, /playbook body that must not enter/);
  assert.doesNotMatch(prompt, /full catalog row that must not enter/);
  assert.ok(!prompt.includes(context.playbook.text));
  const parsed = JSON.parse(prompt) as ReturnType<typeof recoveryWorkingSet>;
  assert.equal("resolved" in parsed, false);
  assert.equal("investigationPacket" in parsed, false);
  const task = parsed.task as { initialInput: { truncated: boolean; text: string; fullTextPath: string } };
  assert.equal(task.initialInput.truncated, true);
  assert.ok(task.initialInput.text.length < context.task.initialInput.text.length);
  assert.equal(task.initialInput.fullTextPath, "observations/task/initial-input.txt");
  assert.ok(Buffer.byteLength(prompt) < 80_000);
  const observations = parsed.observations as { root: string; index: string };
  assert.equal(observations.root, "observations");
  assert.equal(observations.index, "observations/INDEX.md");
  const evidence = parsed.evidence as { catalogCount: number; catalogIndex: string; evidenceRefs: string[] };
  assert.equal(evidence.catalogCount, 2);
  assert.equal(evidence.catalogIndex, "observations/INDEX.tsv");
  assert.deepEqual(evidence.evidenceRefs, ["event:transcript-0-aaaa"]);
  const playbook = parsed.playbook as { textPath: string };
  assert.equal(playbook.textPath, "observations/playbook.md");
});

test("recovery working set carries source mount summary rather than a full tree", () => {
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
  const parsed = recoveryWorkingSet(context);
  const staging = parsed.staging as { seed: string; sourceMount: string; source: { fileCount: number; summary: { entries: unknown[] } } };
  assert.equal(staging.seed, "sparse");
  assert.equal(staging.sourceMount, "source");
  assert.equal(staging.source.fileCount, 50_001);
  assert.equal(staging.source.summary.entries.length, 1);
  assert.doesNotMatch(JSON.stringify(parsed), /node_modules\/leftpad/);
});
