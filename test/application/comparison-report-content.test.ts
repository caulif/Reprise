import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadComparisonContentSnapshot } from "../../src/application/comparison-report-content.js";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { comparisonPreviewFingerprint, materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";

const facts: ComparisonReportFacts = {
  run: { runId: "run-content", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { baseline: "model-A", candidate: "model-B" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "not_collected", verificationStatus: "not_collected" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "reprise-report-content-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "work", "report"), { recursive: true });
  const file = (name: string) => join(root, "work", "report", name);
  await writeFile(file("content.json"), JSON.stringify({ schemaVersion: 1, headline: "The results are comparable", criticalLimitations: ["Visual output was unavailable"], evidenceRefs: [] }));
  await writeFile(file("body.html"), "<p>The delivered answers address the same request.</p>");
  return { root, file };
}

test("content fragments assemble into Host-owned report and preview the same version", async (t) => {
  const { root, file } = await setup(t);
  const content = await loadComparisonContentSnapshot(root);
  const verified = await verifyAndRenderComparisonReport({
    content, hostTask: "Original user task", facts,
    attemptRoot: root, media: [], evidence: [],
  });
  assert.equal("failureClass" in verified, false);
  if ("failureClass" in verified) return;
  assert.match(verified.html, /Original user task/);
  assert.match(verified.html, /Visual output was unavailable/);
  assert.ok(verified.html.indexOf("Visual output was unavailable") < verified.html.indexOf("The delivered answers"));
  assert.doesNotMatch(verified.html, /ignored old page/);
  const preview = await materializeComparisonReportPreview({
    attemptRoot: root, hostTask: "Original user task", facts, media: [], evidence: [], catalogRevision: 0,
  });
  assert.equal(preview.draftDigest, content.digest);
  assert.equal(preview.validationDigest, comparisonPreviewFingerprint({
    contentDigest: content.digest, facts, hostTask: "Original user task", locale: "zh",
    preparedDigest: preview.preparedDigest, media: [], evidence: [], catalogRevision: 0,
  }));
  await writeFile(file("body.html"), "<p>Changed after preview.</p>");
  assert.notEqual((await loadComparisonContentSnapshot(root)).digest, preview.draftDigest);
});

test("content loader rejects missing, malformed, oversized, and active fragments", async (t) => {
  const { root, file } = await setup(t);
  await writeFile(file("content.json"), "{");
  await assert.rejects(loadComparisonContentSnapshot(root), /content JSON/);
  await writeFile(file("content.json"), JSON.stringify({ schemaVersion: 2, headline: "No", criticalLimitations: [], evidenceRefs: [] }));
  await assert.rejects(loadComparisonContentSnapshot(root), /schemaVersion/);
  await writeFile(file("content.json"), JSON.stringify({ schemaVersion: 1, headline: " ", criticalLimitations: [], evidenceRefs: [] }));
  await assert.rejects(loadComparisonContentSnapshot(root), /must contain text/);
  await writeFile(file("content.json"), JSON.stringify({ schemaVersion: 1, headline: "Valid", criticalLimitations: [], evidenceRefs: [] }));
  for (const body of ["", "<script>alert(1)</script>", "<template><img onerror=alert(1)></template>", "<p style=color:red>Styled</p>", "<div data-host-zone=header>spoof</div>"]) {
    await writeFile(file("body.html"), body);
    await assert.rejects(loadComparisonContentSnapshot(root), /empty|Invalid comparison fragment/, body);
  }
  await writeFile(file("body.html"), "x".repeat(262_145));
  await assert.rejects(loadComparisonContentSnapshot(root), /exceeds/);
});

test("content loader rejects a hidden-only main comparison", async (t) => {
  const { root, file } = await setup(t);
  for (const body of ["<template><p>Hidden analysis</p></template>",
    "<div hidden><p>Hidden analysis</p></div>",
    "<div inert><p>Hidden analysis</p></div>"]) {
    await writeFile(file("body.html"), body);
    await assert.rejects(loadComparisonContentSnapshot(root), /cannot contain|hidden|fragment/i);
  }
});
