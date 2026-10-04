import test from "node:test";
import assert from "node:assert/strict";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import {
  extractOuter, extractHostZoneSnapshot, missingComparisonSlots, hostMetricsMismatch,
  hostZonesMismatch, renderComparisonReportShell,
  formatCost,
} from "../../src/application/comparison-report-shell.js";

function facts(): ComparisonReportFacts {
  return {
    run: { runId: "run-1", outcome: "completed", terminationCode: "controller.satisfied", initiatedBy: "controller" },
    models: { baseline: "baseline-model", candidate: "candidate-model" },
    activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
    delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unknown" },
    replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
  };
}

function filledSlots() {
  return { headline: "本次倾向候选", comparison: "<p>候选结果更完整，但等待更久。</p>" };
}

test("compact layout rejects metrics below comparison and accepts untouched legacy format 2", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({ task: "Compare", facts: reportFacts, metrics: reportFacts.metrics ?? {}, slots: filledSlots() });
  const metrics = extractOuter(html, "data-host-zone", "metrics")!;
  const cost = extractOuter(html, "data-host-zone", "cost-note")!;
  const comparison = extractOuter(html, "data-agent-zone", "comparison")!;
  const moved = html.replace(metrics, "").replace(cost, "").replace(comparison, comparison + metrics + cost);
  assert.match(missingComparisonSlots(moved)!, /headline, metrics, cost-note, then comparison/);
  const snapshot = extractHostZoneSnapshot(html)!;
  const legacy = moved.replace(' data-metrics-layout="compact"', "");
  assert.equal(missingComparisonSlots(legacy), undefined);
  assert.match(hostZonesMismatch(legacy, snapshot, reportFacts.metrics ?? {})!, /Host zone "metrics" was modified/);
  const legacyFingerprint = legacy.replace(/data-fingerprint="[^"]*"/, `data-fingerprint="${JSON.stringify({ b: [null, null, null, null], c: [null, null, null, null] }).replaceAll('"', '&quot;')}"`);
  assert.equal(hostMetricsMismatch(legacyFingerprint, {}), undefined);
});

test("small nonzero costs stay visible and protected while legacy rounding remains readable", () => {
  const metrics = { baseline: { costUsd: 0.0004 }, candidate: { costUsd: 0 } };
  const html = renderComparisonReportShell({ task: "Compare", facts: facts(), metrics, slots: filledSlots() });
  assert.equal(formatCost(metrics.baseline).text, "<0.001");
  assert.equal(formatCost(metrics.candidate).text, "0.00");
  assert.match(html, /&lt;0\.001<span class="unit">\$/);
  assert.equal(hostMetricsMismatch(html, metrics), undefined);
  assert.equal(hostMetricsMismatch(html.replace("&lt;0.001", "0.00"), metrics), "Host metrics numbers were modified.");
  const fingerprint = JSON.stringify({ b: [null, null, 0.0004, null], c: [null, null, 0, null] }).replaceAll('"', '&quot;');
  const legacy = html.replace(' data-metrics-layout="compact"', "")
    .replace(/data-fingerprint="[^"]*"/, `data-fingerprint="${fingerprint}"`).replace("&lt;0.001", "0.00");
  assert.equal(hostMetricsMismatch(legacy, metrics), undefined);
});

test("compact metrics keep precise time and token details folded", () => {
  const html = renderComparisonReportShell({ task: "Compare", facts: facts(), metrics: {
    baseline: { elapsedMs: 105000, tokens: { total: 100, input: 80, output: 20, cached: 30, reasoning: 5 }, costUsd: 0.446 },
    candidate: { elapsedMs: 489000, tokens: { total: 200 }, costUsd: 0.083 },
  }, slots: filledSlots() });
  assert.match(html, /1:45<span class="unit">分:秒/);
  assert.match(html, /8:09<span class="unit">分:秒/);
  assert.match(html, /0\.446<span class="unit">\$/);
  assert.match(html, /0\.083<span class="unit">\$/);
  assert.match(html, /<details class="token-details"><summary>展开 Token 口径/);
  assert.match(html, /缓存输入: 30/);
  assert.match(html, /推理: 5/);
  assert.match(html, /不是供应商账单/);
  assert.match(html, /不同工具的 Token 口径不能直接作为模型效率评分/);
  assert.doesNotMatch(html, /<details class="token-details" open/);
  const metricsBlock = extractOuter(html, "data-host-zone", "metrics")!;
  const fingerprint = JSON.stringify({ b: [105000, 100, 0.446, null], c: [489000, 200, 0.083, null] }).replaceAll('"', '&quot;');
  const oldMetrics = metricsBlock.replace(' data-metrics-layout="compact"', "")
    .replace(/data-fingerprint="[^"]*"/, `data-fingerprint="${fingerprint}"`)
    .replace("1:45", "2").replace("8:09", "8").replace("0.446<span", "0.45<span").replace("0.083<span", "0.08<span");
  assert.equal(hostMetricsMismatch(oldMetrics, {
    baseline: { elapsedMs: 105000, tokens: { total: 100 }, costUsd: 0.446 },
    candidate: { elapsedMs: 489000, tokens: { total: 200 }, costUsd: 0.083 },
  }), undefined);
});
