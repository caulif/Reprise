import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import {
  publishComparisonArtifacts,
  verifyAndRenderComparisonReport,
} from "../../src/application/comparison-publication.js";
import { agentZoneBlank, renderComparisonReportShell } from "../../src/application/comparison-report-shell.js";
import { writeComparisonContent } from "../comparison-content-support.js";

const stamp = "2026-09-01T00:00:00.000Z";

function facts(): ComparisonReportFacts {
  return {
    run: {
      runId: "run-1",
      outcome: "completed",
      terminationCode: "completed",
      initiatedBy: "operator",
      elapsedMs: 1_000,
      candidateElapsedMs: 900,
    },
    models: { candidate: "model-a", baseline: "model-b", comparison: "harness" },
    activity: { candidateTurns: 1, controllerCalls: 0, toolCalls: { total: 0, succeeded: 0, failed: 0, rejectedApprovals: 0 } },
    limits: { triggered: [] },
    runtime: { productId: "codex" },
    delivery: { changedPaths: ["out.txt"], targetArtifactStatus: "present", verificationStatus: "passed" },
    replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
    metrics: {
      baseline: { elapsedMs: 800, tokens: { total: 10 }, costUsd: 0.01, usageStatus: "collected", pricingStatus: "collected", pricingVersion: "v1", collectedAt: stamp },
      candidate: { elapsedMs: 900, tokens: { total: 12 }, costUsd: 0.02, usageStatus: "collected", pricingStatus: "collected", pricingVersion: "v1", collectedAt: stamp },
    },
  };
}

function shell(comparison: string): string {
  return renderComparisonReportShell({
    task: "修复报告。",
    facts: facts(),
    metrics: facts().metrics ?? {},
    slots: {
      headline: "候选有交付。",
      category: "交付",
      task: "修复报告。",
      comparison,
      details: "",
    },
  });
}

test("image-only comparison zone survives verify without Host pairing reseed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b6-img-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "history.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const body = '<img src="media/history.png" alt="historical preview"><img src="media/ok.png" alt="preview">';
  const html = shell(body);
  assert.equal(agentZoneBlank(html, "comparison"), false);
  const verified = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(root, body), hostTask: "修复报告。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [
      { ref: "media:history", shortRef: "media-01", side: "baseline", inspectPath: "history/media/history.png", reportHref: "media/history.png", mediaType: "image/png", available: true },
      { ref: "media:ok", shortRef: "media-02", side: "candidate", inspectPath: "evidence/ok.png", reportHref: "media/ok.png", mediaType: "image/png", available: true },
    ],
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  assert.match(verified.html, /src="media\/history\.png"/);
  assert.match(verified.html, /src="media\/ok\.png"/);
  const comparison = verified.html.match(/data-agent-zone="comparison"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
  assert.doesNotMatch(comparison, /data-host="pairing-candidate"/);
});

test("table-only comparison zone is not blank and survives verify without Host reseed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b6-table-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  const table = '<table data-component="diff-table"><tr><td></td><td></td></tr></table>';
  const html = shell(table);
  assert.equal(agentZoneBlank(html, "comparison"), false);
  const verified = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(root, table), hostTask: "修复报告。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [],
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  const comparison = verified.html.match(/data-agent-zone="comparison"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
  assert.match(comparison, /data-component="diff-table"/);
  assert.doesNotMatch(comparison, /data-host="pairing-candidate"|data-host="visual-unavailable"/);
});

test("empty comparison zone still gets Host seed or cannot-determine fill", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-b6-empty-zone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const html = shell("<!-- only comment -->");
  assert.equal(agentZoneBlank(html, "comparison"), true);
  const verified = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(root, "<!-- only comment -->"), hostTask: "修复报告。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [{
      ref: "media:ok",
      shortRef: "media-01",
      side: "candidate",
      inspectPath: "evidence/ok.png",
      reportHref: "media/ok.png",
      mediaType: "image/png",
      available: true,
    }],
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  assert.equal(agentZoneBlank(verified.html, "comparison"), false);
  assert.match(verified.html, /data-host="(?:visual-unavailable|one-sided-visual|visual-candidates)"/);
});

test("share card keeps diff-table visible and publishes content-addressed media matching report-model", async (t) => {
  const attempt = await mkdtemp(join(tmpdir(), "reprise-b6-attempt-"));
  const experiment = await mkdtemp(join(tmpdir(), "reprise-b6-experiment-"));
  t.after(() => rm(attempt, { recursive: true, force: true }));
  t.after(() => rm(experiment, { recursive: true, force: true }));
  await mkdir(join(attempt, "media"), { recursive: true });
  await writeFile(join(attempt, "media", "ok.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const reportFacts = facts();
  const media = [{
    ref: "media:ok" as const,
    shortRef: "media-01",
    side: "candidate" as const,
    inspectPath: "evidence/ok.png",
    reportHref: "media/ok.png",
    mediaType: "image/png",
    available: true,
  }];
  const body = '<table data-component="diff-table"><tr><td>值</td></tr></table><img src="media/ok.png" alt="preview">';
  const html = shell(body);
  assert.doesNotMatch(html, /\.share \[data-component="diff-table"\] \{ display:none/);
  const verified = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(attempt, body), hostTask: "修复报告。",
    facts: reportFacts, result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: attempt, media,
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  const published = await publishComparisonArtifacts({
    attemptRoot: attempt, experimentRoot: experiment, html: verified.html, media, model: verified.model,
  });
  assert.match(published.html, /src="media\/[a-f0-9]{24}\.png"/);
  assert.equal(await readFile(join(experiment, "report.html"), "utf8"), published.html);
  const modelJson = await readFile(join(experiment, "report-model.json"), "utf8");
  assert.match(modelJson, /"formatVersion":2/);
  assert.match(modelJson, /media\/[a-f0-9]{24}\.png/);
  assert.doesNotMatch(modelJson, /media\/ok\.png/);
});
