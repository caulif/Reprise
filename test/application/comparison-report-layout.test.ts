import test from "node:test";
import assert from "node:assert/strict";
import type { ComparisonReportFacts } from "../../src/agents/comparison-contract.js";
import {
  extractOuter, extractHostZoneSnapshot, missingComparisonSlots, hostMetricsMismatch,
  hostZonesMismatch, renderComparisonReportShell,
  formatCost, agentZoneBlank, extractInner,
  agentContentFromDraft, renderComparisonReportFromModel,
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

test("both report formats retain frozen session dates through rebuild and reject Host date edits", () => {
  for (const formatVersion of [undefined, 3] as const) {
    const format = formatVersion === 3 ? { formatVersion } : {};
    for (const locale of ["zh", "en"] as const) {
      const reportFacts = facts();
      reportFacts.sessionDates = { baseline: "2026-09-20", candidate: "2026-10-15" };
      const html = renderComparisonReportShell({ ...format, task: "Compare", facts: reportFacts, metrics: {}, locale, slots: filledSlots() });
      const header = extractOuter(html, "data-host-zone", "header")!;
      assert.match(header, /<time datetime="2026-09-20">2026-09-20 UTC<\/time>/);
      assert.match(header, /<time datetime="2026-10-15">2026-10-15 UTC<\/time>/);
      const snapshot = extractHostZoneSnapshot(html)!;
      assert.equal(hostZonesMismatch(html.replaceAll("2026-09-20", "2026-09-21"), snapshot, {}, locale), 'Host zone "header" was modified.');
      const extracted = agentContentFromDraft(html);
      assert.ok("slots" in extracted);
      const rebuilt = renderComparisonReportShell({ task: "Compare", facts: reportFacts, metrics: {}, locale, ...extracted });
      assert.equal(extractOuter(rebuilt, "data-host-zone", "header"), header);
      delete reportFacts.sessionDates.candidate;
      const partial = renderComparisonReportShell({ ...format, task: "Compare", facts: reportFacts, metrics: {}, locale });
      assert.match(partial, /2026-09-20 UTC/);
      const unknown = locale === "zh" ? /日期未知/g : /Date unknown/g;
      assert.equal(partial.match(unknown)?.length, 1);
      delete reportFacts.sessionDates;
      const legacy = renderComparisonReportShell({ ...format, task: "Compare", facts: reportFacts, metrics: {}, locale });
      assert.equal(legacy.match(unknown)?.length, 2);
    }
  }
});

test("format 3 keeps recommendation, full-view evidence, differences and three Host metric rows in reading order", () => {
  const reportFacts = facts();
  reportFacts.models.comparison = "analysis-model";
  const metrics = { baseline: { elapsedMs: 104785, tokens: { total: 70480 }, costUsd: 0.446 }, candidate: { elapsedMs: 39000, tokens: { total: 11698718 }, pricingStatus: "pricing_unavailable" as const } };
  const html = renderComparisonReportShell({ formatVersion: 3, task: "Compare", facts: reportFacts, metrics, slots: { headline: "Use A &amp; B", boundary: "Only after <review>", differences: ["A & B is clearer"], comparison: '<figure><img data-media-ref="media-01" src="media/full.png" alt="Complete viewport"></figure>' } });
  const block = extractOuter(html, "data-host-zone", "metrics")!;
  assert.equal((block.match(/<tbody><tr>|<\/tr><tr>/g) ?? []).length, 3);
  assert.match(block, /Token（k）/);
  assert.match(block, />70\.5<\/td>/);
  assert.match(block, />11,698\.7<\/td>/);
  assert.match(block, />0:39<\/td>/);
  assert.match(block, /价格未配置/);
  assert.doesNotMatch(html, /<details|data-host-zone="evidence"|data-agent-zone="details"/);
  assert.match(html, /height:auto; max-height:none; object-fit:contain/);
  const body = html.slice(html.indexOf("<body>"));
  assert.ok(body.indexOf('data-agent-slot="boundary"') < body.indexOf('data-agent-zone="comparison"'));
  assert.ok(body.indexOf('data-agent-zone="comparison"') < body.indexOf('data-agent-zone="differences"'));
  assert.ok(body.indexOf('data-agent-zone="differences"') < body.indexOf('data-host-zone="metrics"'));
  assert.match(html, /报告分析模型 · analysis-model/);
  assert.equal(hostMetricsMismatch(html, metrics), undefined);
  assert.equal(hostMetricsMismatch(html.replace("70.5</td>", "70.4</td>"), metrics), "Host metrics numbers were modified.");
  const extracted = agentContentFromDraft(html);
  assert.ok("slots" in extracted);
  assert.equal(extracted.formatVersion, 3);
  assert.equal(extracted.slots.boundary, "Only after <review>");
  assert.deepEqual(extracted.slots.differences, ["A & B is clearer"]);
  const rebuilt = renderComparisonReportShell({ task: "Compare", facts: reportFacts, metrics, ...extracted });
  assert.match(rebuilt, />Use A &amp; B<\/h1>/);
  assert.doesNotMatch(rebuilt, /&amp;amp;/);
});

test("format 3 keeps tiny tokens, zero and missing distinct, and never labels a requested alias as the actual model", () => {
  const reportFacts = facts();
  reportFacts.models = { candidate: "sonnet", candidateRequested: "sonnet", candidateResolved: "unknown", baseline: "pending" };
  const html = renderComparisonReportShell({ formatVersion: 3, task: "Compare", facts: reportFacts, metrics: { baseline: { tokens: { total: 1 } }, candidate: { tokens: { total: 0 } } }, slots: filledSlots() });
  assert.match(html, /&lt;0\.1<\/td>/);
  assert.match(html, />0\.0<\/td>/);
  assert.match(html, /<strong>未记录<\/strong>/);
  assert.doesNotMatch(html, /sonnet|<strong>pending/);
  const missing = renderComparisonReportShell({ formatVersion: 3, task: "Compare", facts: reportFacts, metrics: {}, slots: filledSlots() });
  assert.match(extractOuter(missing, "data-host-zone", "metrics")!, /未采集/);
  const modelHtml = renderComparisonReportFromModel({ model: { schemaVersion: 1, formatVersion: 3, task: "Compare", headline: "Use A & B", boundary: "Need review", differences: ["Clearer"], status: { baseline: "available", candidate: "available", candidateOutcome: "completed", terminationCode: "done" }, evidenceRefs: [], mediaRefs: [], slots: { header: '<span data-agent-slot="category">Custom &amp; task category</span>', comparison: "<p>Evidence</p>" } }, facts: reportFacts });
  assert.match(modelHtml, /data-report-format="3"/);
  assert.match(modelHtml, />Use A &amp; B<\/h1>/);
  assert.match(modelHtml, /data-difference>Clearer/);
  assert.match(modelHtml, /data-agent-slot="category">Custom &amp; task category<\/span>/);
});

test("format 3 labels timing basis and incomplete coverage beside the metric table", () => {
  const reportFacts = facts();
  reportFacts.metrics = { timingComparable: false, baseline: { elapsedMs: 1000, timing: { basis: "turn_wall_clock_sum", valueMs: 1000, coverage: { completedTurns: 2, measuredTurns: 1, openTurns: 1, status: "partial" }, sources: [], diagnostics: [] } }, candidate: { elapsedMs: 2000, timing: { basis: "run_wall_clock_span", valueMs: 2000, coverage: { completedTurns: 1, measuredTurns: 1, openTurns: 0, status: "complete" }, sources: [], diagnostics: [] } } };
  for (const locale of ["zh", "en"] as const) {
    const html = renderComparisonReportShell({ formatVersion: 3, task: "Compare", facts: reportFacts, metrics: reportFacts.metrics, locale, slots: filledSlots() });
    const note = extractOuter(html, "data-host-zone", "cost-note")!;
    assert.match(note, locale === "zh" ? /记录轮次耗时累计/ : /sum of recorded turn durations/);
    assert.match(note, locale === "zh" ? /已计1\/2个完成轮次，1个未结束/ : /1\/2 completed turns measured, 1 open/);
    assert.match(note, locale === "zh" ? /运行整体区间/ : /whole-run elapsed time/);
    assert.match(note, locale === "zh" ? /不比较速度/ : /do not compare speed/);
  }
});

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

test("compact metrics show all totals once and fold only the token breakdown", () => {
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
  const totals = metricsBlock.slice(0, metricsBlock.indexOf('<details'));
  assert.match(totals, />100<\/div>/);
  assert.match(totals, />200<\/div>/);
  assert.equal((metricsBlock.match(/>100<\/div>/g) ?? []).length, 1);
  const fingerprint = JSON.stringify({ b: [105000, 100, 0.446, null], c: [489000, 200, 0.083, null] }).replaceAll('"', '&quot;');
  const oldMetrics = metricsBlock.replace(' data-metrics-layout="compact"', "")
    .replace(/data-fingerprint="[^"]*"/, `data-fingerprint="${fingerprint}"`)
    .replace("1:45", "2").replace("8:09", "8").replace("0.446<span", "0.45<span").replace("0.083<span", "0.08<span");
  assert.equal(hostMetricsMismatch(oldMetrics, {
    baseline: { elapsedMs: 105000, tokens: { total: 100 }, costUsd: 0.446 },
    candidate: { elapsedMs: 489000, tokens: { total: 200 }, costUsd: 0.083 },
  }), undefined);
});

test("empty shell keeps authoring slots blank without manufacturing a decision or evidence", () => {
  for (const locale of ["zh", "en"] as const) {
    const html = renderComparisonReportShell({ task: "Task from Host", facts: facts(), metrics: {}, locale });
    assert.equal(extractInner(html, "data-agent-slot", "headline"), "");
    assert.equal(agentZoneBlank(html, "comparison"), true);
    assert.equal(agentZoneBlank(html, "details"), true);
    assert.doesNotMatch(extractInner(html, "data-agent-zone", "comparison"), /<img|<table|<article/);
    assert.doesNotMatch(html, /data-media-ref="media-\d+"/);
    assert.equal(missingComparisonSlots(html), undefined);
  }
});

test("visible metrics distinguish missing measurements from zero in both locales", () => {
  for (const locale of ["zh", "en"] as const) {
    const metrics = { candidate: { elapsedMs: 0, tokens: { total: 0 }, costUsd: 0 } };
    const html = renderComparisonReportShell({ task: "Compare", facts: facts(), metrics, locale, slots: filledSlots() });
    const block = extractOuter(html, "data-host-zone", "metrics")!;
    const totals = block.slice(0, block.indexOf('<details'));
    assert.equal((totals.match(/class="num miss"/g) ?? []).length, 3);
    assert.match(totals, />0<span class="unit">s<\/span>/);
    assert.match(totals, />0<\/div>/);
    assert.match(totals, />0\.00<span class="unit">\$/);
    assert.equal(hostMetricsMismatch(html, metrics, locale), undefined);
    assert.equal(hostMetricsMismatch(html.replace('>0.00<span', '>1.00<span'), metrics, locale), "Host metrics numbers were modified.");
  }
});
