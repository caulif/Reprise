import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import { classifyComparisonFailure, comparisonReportModelFromHtml, verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { renderComparisonReportShell } from "../../src/application/comparison-report-shell.js";
import { ComparisonReportModelSchema } from "../../src/core/schema.js";
import { writeComparisonContent } from "../comparison-content-support.js";

const facts: ComparisonReportFacts = {
  run: { runId: "run-1", outcome: "incomplete", terminationCode: "limit.turns", initiatedBy: "harness" },
  models: { baseline: "historical", candidate: "gpt-5.6" }, activity: {}, limits: { triggered: [] },
  runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

async function verify(body: string, locale: "zh" | "en" = "zh") {
  const root = await mkdtemp(join(tmpdir(), "reprise-publication-"));
  try {
    const content = await writeComparisonContent(root, body, locale === "zh" ? "候选交付了文件。" : "The candidate delivered a file.");
    return await verifyAndRenderComparisonReport({ content, hostTask: "修复报告。", facts,
      attemptRoot: root, media: [], evidence: [], locale });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Host owns report layout, facts, status, and current model", async () => {
  const result = await verify("<p>候选有交付物，历史没有。</p>");
  assert.ok("html" in result);
  if (!("html" in result)) return;
  const html = result.html;
  assert.match(html, /data-report-format="2"/);
  assert.match(html, /任务描述/);
  assert.match(html, /主要结论/);
  assert.match(html, /历史结果/);
  assert.match(html, /本次结果/);
  assert.match(html, /data-agent-zone="comparison"/);
  assert.match(html, /data-host="run-diagnostics"/);
  assert.doesNotMatch(html, /分享卡版式未能完全修好/);
  const model = result.model;
  assert.equal(model.status.candidateOutcome, "incomplete");
  assert.equal(model.status.terminationCode, "limit.turns");
  assert.equal(model.formatVersion, 2);
  assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
});

test("current model schema rejects missing or legacy format and audit slots", async () => {
  const result = await verify("<p>可用内容。</p>");
  assert.ok("model" in result);
  if (!("model" in result)) return;
  const current = result.model;
  assert.equal(Value.Check(ComparisonReportModelSchema, current), true);
  const { formatVersion: _removed, ...missing } = current;
  assert.equal(Value.Check(ComparisonReportModelSchema, missing), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...current, formatVersion: 1 }), false);
  assert.equal(Value.Check(ComparisonReportModelSchema, { ...current, slots: { ...current.slots, "key-differences": "old audit" } }), false);
});

test("English share card uses current Host labels without a false layout warning", async () => {
  const result = await verify("<p>The candidate delivered a file.</p>", "en");
  assert.ok("html" in result);
  if ("html" in result) {
    assert.match(result.html, /Historical result/);
    assert.match(result.html, /This run/);
    assert.doesNotMatch(result.html, /Share-card presentation could not be fully repaired/);
  }
});

test("model generated from Host shell uses the current format only", () => {
  const html = renderComparisonReportShell({ task: "修复报告。", facts, metrics: {},
    slots: { headline: "候选交付了文件。", comparison: "<p>候选有交付物。</p>" } });
  const model = comparisonReportModelFromHtml(html, facts, { evidenceRefs: [] }, []);
  assert.equal(model.formatVersion, 2);
  assert.equal(Value.Check(ComparisonReportModelSchema, model), true);
});

test("failure classification distinguishes provider, protocol, evidence, metrics, and media", () => {
  const cases = [
    { code: "agent_failure", kind: "rate_limited", message: "rate limited", expected: "provider" },
    { code: "invalid_envelope", message: "invalid JSON", expected: "protocol" },
    { code: "evidence_unresolved", message: "unknown evidence", expected: "evidence" },
    { code: "host_zone_modified", message: "Host metrics were changed", expected: "metrics" },
    { code: "media_unavailable", message: "media unavailable", expected: "media" },
  ] as const;
  for (const { code, message, expected, ...extra } of cases) {
    const result = classifyComparisonFailure({ result: { status: "failed", failure: { code, message, attempts: 1, ...extra } }, reportPresent: true });
    assert.equal(result.failureClass, expected, code);
  }
});
