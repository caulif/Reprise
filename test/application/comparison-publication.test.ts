import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComparisonContext, type RunInspection } from "../../src/application/comparison.js";
import {
  classifyComparisonFailure,
  comparisonReportModelFromHtml,
  publishComparisonArtifacts,
  verifyAndRenderComparisonReport,
} from "../../src/application/comparison-publication.js";
import { renderVisualEvidenceSeed } from "../../src/application/comparison-visual-evidence.js";
import {
  extractHostZoneSnapshot,
  hostZonesMismatch,
  metricsFromReportFacts,
  renderComparisonReportFromModel,
  renderComparisonReportShell,
} from "../../src/application/comparison-report-shell.js";
import type { RunRecord, TaskCase } from "../../src/core/schema.js";

const timestamp = "2026-08-15T00:00:00.000Z";
function taskCase(): TaskCase {
  return {
    schemaVersion: 1, caseId: "case-1", source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "修复报告。" },
    transcript: [{ id: "message-1", role: "user", text: "修复报告。" }],
    historicalEvents: [],
    baseline: { status: "available", finalMessage: "Done.", artifactRefs: [], evidenceRefs: ["event:baseline-1"] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "fixture", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}
function runRecord(): RunRecord {
  return {
    attempt: {
      schemaVersion: 1, runId: "run-1", experimentId: "experiment-1", caseId: "case-1",
      candidate: { candidateId: "candidate-1", productId: "codex", requestedModel: "gpt-5.6" },
      policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 },
      createdAt: timestamp,
    },
    state: "finished", stageReached: "awaiting_controller",
    outcome: {
      task: { status: "incomplete", evidenceRefs: [] },
      termination: { kind: "limit_reached", code: "limit.turns", initiatedBy: "harness" },
      cleanup: { status: "complete", remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: "experiment-1", runId: "run-1", firstSequence: 1, lastSequence: 2 },
    artifactRefs: [], warnings: [],
  };
}
const inspection: RunInspection = {
  runId: "run-1", changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 4000,
};

function facts() {
  return buildComparisonContext(taskCase(), [runRecord()], [inspection]).reportFacts;
}

function filledSlots(extra: Record<string, string> = {}) {
  return {
    headline: "候选把讨论推进成了可继续使用的文件。",
    comparison: "<p>候选有交付物，历史没有。</p>",
    ...extra,
  };
}

test("Host template has no visible status cards and keeps facts in the model", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  assert.doesNotMatch(html, /data-host-zone="status"/);
  assert.doesNotMatch(html, /历史证据不足/);
  assert.doesNotMatch(html, /apparently_completed/);
  assert.doesNotMatch(html, /completed\.controller_satisfied/);
  assert.match(html, /data-agent-slot="headline"/);
  assert.match(html, /data-component-template="difference-card"/);
  const header = html.indexOf('data-id="host-header"');
  const metrics = html.indexOf('data-id="host-metrics"');
  const comparison = html.indexOf('data-id="agent-comparison"');
  const details = html.indexOf('data-id="agent-details"');
  const headline = html.indexOf('<p class="note" data-agent-slot="headline"');
  assert.ok(header < headline && headline < comparison && comparison < metrics && metrics < details);
  assert.match(html, /data-report-format="2"/);
  assert.match(html, /<details class="details">/);
  assert.doesNotMatch(html, /class="audit" hidden/);
  assert.doesNotMatch(html, /\.share \[data-component="difference-card"\] \{ display:none/);
  assert.doesNotMatch(html, /<summary>价格与证据<\/summary>/);
  assert.doesNotMatch(html, /本卡由/);
  assert.doesNotMatch(html, /历史侧|候选侧/);
  assert.match(html, /任务描述/);
  assert.match(html, /主要结论/);
  assert.match(html, /历史会话/);
  assert.match(html, /当前会话/);
  assert.match(html, /data-agent-slot="category"/);
  assert.match(html, /data-component-template="pair-pages"/);
  assert.match(html, /gpt-5\.6/);
  assert.doesNotMatch(html, />Baseline</);
  assert.doesNotMatch(html, />Candidate</);
  const envelope = { status: "completed" as const, reportPath: "report.html" as const, evidenceRefs: [] };
  const model = comparisonReportModelFromHtml(html, reportFacts, envelope, []);
  assert.equal(model.status.candidateOutcome, "incomplete");
  assert.equal(model.status.terminationCode, "limit.turns");
  assert.match(html, /data-host="run-diagnostics"/);
});

test("the same report model re-renders identical Host metrics", () => {
  const reportFacts = facts();
  const first = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({ comparison: "<p data-component=\"short-prose\">差异甲</p>" }),
  });
  const envelope = { status: "completed" as const, reportPath: "report.html" as const, evidenceRefs: [] };
  const model = comparisonReportModelFromHtml(first, reportFacts, envelope, []);
  const second = renderComparisonReportFromModel({ model, facts: reportFacts });
  const third = renderComparisonReportFromModel({ model, facts: reportFacts });
  assert.match(second, /data-host="metrics"/);
  assert.match(second, /差异甲/);
  assert.equal(second, third);
});

test("broken image references are stripped and the page can still publish", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({ comparison: '<p>候选有交付物，历史没有。</p><img src="media/missing.png" alt="preview">' }),
  });
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [{
      ref: "media:missing",
      side: "candidate",
      inspectPath: "evidence/missing.png",
      reportHref: "media/missing.png",
      mediaType: "image/png",
      available: true,
    }],
  });
  assert.equal("html" in verified, true);
  if ("html" in verified) {
    assert.doesNotMatch(verified.html, /<img\b[^>]*src="media\/missing\.png"/);
    assert.match(verified.html, /证据未解析/);
    assert.match(verified.html, /候选有交付物/);
  }
});

test("empty media catalog shows an explicit visual-unavailable reason", () => {
  assert.match(renderVisualEvidenceSeed([], "zh"), /data-host="visual-unavailable"/);
  assert.match(renderVisualEvidenceSeed(undefined, "en"), /data-host="visual-unavailable"/);
});

test("Host seeds paired visual evidence and explicit reasons before publication repair", async () => {
  const reportFacts = facts();
  const media = [
    {
      ref: "media:history",
      shortRef: "media-01",
      side: "baseline" as const,
      inspectPath: "history/media/history.png",
      reportHref: "media/history.png",
      mediaType: "image/png",
      available: true,
    },
    {
      ref: "media:ok",
      shortRef: "media-02",
      side: "candidate" as const,
      inspectPath: "evidence/ok.png",
      reportHref: "media/ok.png",
      mediaType: "image/png",
      available: true,
    },
  ];
  const seeded = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    media,
    slots: { headline: "候选把讨论推进成了可继续使用的文件。" },
  });
  assert.match(seeded, /data-host="pairing-candidate"|data-component="page-row"/);
  assert.match(seeded, /data-media-ref="media-01"/);
  assert.match(seeded, /data-media-ref="media-02"/);
  const oneSided = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    media: [media[1]!],
    slots: { headline: "候选把讨论推进成了可继续使用的文件。" },
  });
  assert.match(oneSided, /data-host="visual-unavailable"/);
  assert.match(oneSided, /候选侧已有预览图|历史侧终稿图未能/);
  const emptied = oneSided.replace(
    /<section class="slot" data-agent-zone="comparison" data-id="agent-comparison">[\s\S]*?<\/section>/,
    '<section class="slot" data-agent-zone="comparison" data-id="agent-comparison"></section>',
  );
  const repaired = await verifyAndRenderComparisonReport({
    html: emptied,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [media[1]!],
  });
  assert.equal("html" in repaired, true);
  if ("html" in repaired) {
    assert.match(repaired.html, /data-id="agent-comparison"[^>]*>[\s\S]*?(visual-unavailable|无法判断)/);
  }
});

test("comparison metrics use English-style min and s units", () => {
  const reportFacts = buildComparisonContext(taskCase(), [runRecord()], [{
    runId: "run-1", changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 120_000,
  }]).reportFacts;
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
    locale: "zh",
  });
  assert.match(html, />2<span class="unit">min<\/span>/);
  assert.doesNotMatch(html, />2<span class="unit">分<\/span>/);
  const short = renderComparisonReportShell({
    task: "Fix the report.",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
    locale: "en",
  });
  assert.match(short, />2<span class="unit">min<\/span>/);
});

test("registered media that exists can be published", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "history.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      comparison: '<img src="media/history.png" alt="historical preview"><img src="media/ok.png" alt="preview">',
    }),
  });
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [
      {
        ref: "media:history",
        shortRef: "media-01",
        side: "baseline",
        inspectPath: "history/media/history.png",
        reportHref: "media/history.png",
        mediaType: "image/png",
        available: true,
      },
      {
        ref: "media:ok",
        shortRef: "media-02",
        side: "candidate",
        inspectPath: "evidence/ok.png",
        reportHref: "media/ok.png",
        mediaType: "image/png",
        available: true,
      },
    ],
  });
  assert.equal("html" in verified, true);
});

test("one-sided share-card images publish with nearby missing-side note", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-one-side-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      comparison: '<p data-host="visual-unavailable">候选侧已有预览图；历史侧终稿图未能恢复或渲染。</p><img src="media/ok.png" alt="preview">',
    }),
  });
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
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
  if ("html" in verified) {
    assert.match(verified.html, /<img\b[^>]*src="media\/ok\.png"/);
    assert.match(verified.html, /data-host-limitation|data-host="visual-unavailable"/);
    assert.match(verified.html, /历史侧|未能恢复|单侧/);
  }
});

test("failure classes distinguish provider, protocol, evidence, metrics, and media", () => {
  assert.equal(classifyComparisonFailure({
    result: { status: "failed", failure: { kind: "transient_upstream", code: "agent_failure", message: "HTTP 529", attempts: 1 } },
    reportPresent: false,
  }).failureClass, "provider");
  assert.equal(classifyComparisonFailure({
    result: { status: "failed", failure: { kind: "protocol", code: "invalid_envelope", message: "invalid JSON", attempts: 1 } },
    reportPresent: true,
  }).failureClass, "protocol");
  assert.equal(classifyComparisonFailure({
    result: { status: "failed", failure: { code: "evidence_unresolved", message: "unknown evidence reference", attempts: 1 } },
    reportPresent: true,
  }).failureClass, "evidence");
  assert.equal(classifyComparisonFailure({
    result: { status: "failed", failure: { code: "host_zone_modified", message: "Host metrics numbers were modified.", attempts: 1 } },
    reportPresent: true,
  }).failureClass, "metrics");
  assert.equal(classifyComparisonFailure({
    result: { status: "failed", failure: { code: "media_unavailable", message: "Comparison media reference is not publishable: media/x.png", attempts: 1 } },
    reportPresent: true,
  }).failureClass, "media");
});

test("Host diagnostic cards and Agent difference-card both remain visible on the share card", () => {
  const reportFacts = facts();
  const diagnostic = {
    failureClass: "protocol",
    phase: "compose",
    candidateCompleted: "no",
    reason: "Host zone was modified.",
    details: ["metrics tampered"],
    traces: [],
  };
  const page = renderComparisonReportShell({
    title: "Comparison unavailable",
    task: "对照未能完成这次比较",
    facts: reportFacts,
    metrics: metricsFromReportFacts(reportFacts),
    diagnostic,
  });
  const diagnosticBody = page.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.match(diagnosticBody, /data-host="diagnostic-card"/);
  assert.doesNotMatch(diagnosticBody, /data-component="difference-card"/);
  assert.match(diagnosticBody, /Host zone was modified/);
  assert.doesNotMatch(page, /\.share \[data-component="difference-card"\] \{ display:none/);
  assert.match(page, /\[data-component="difference-card"\]/);
  const agentCard = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": '<article data-component="difference-card"><h3>实际交付</h3><p>候选有文件。</p></article>',
    }),
  });
  const agentBody = agentCard.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
  assert.match(agentBody, /data-component="difference-card"/);
});

test("missing comparison zone fails share-card order", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const withoutVisual = html.replace(
    /<section class="slot" data-agent-zone="comparison"[\s\S]*?<\/section>/,
    "",
  );
  const verified = await verifyAndRenderComparisonReport({
    html: withoutVisual,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in verified, false);
  if (!("html" in verified)) {
    assert.match(verified.message, /Share card order|missing data-agent-zone="comparison"/);
  }
});

test("AGENT_ZONES lists format-2 comparison and details", async () => {
  const { AGENT_ZONES } = await import("../../src/core/comparison-html.js");
  assert.deepEqual(AGENT_ZONES, ["comparison", "details"]);
});

test("failure diagnostics retain useful analysis from non-standard Agent zones", async () => {
  const { comparisonFailureDiagnostic } = await import("../../src/application/comparison-publication.js");
  const diagnostic = comparisonFailureDiagnostic({
    result: { status: "failed", failure: { code: "report_incomplete", message: "missing key differences", attempts: 1 } },
    facts: facts(),
    reportPresent: true,
    attemptId: "attempt-1",
    draftHtml: '<section data-agent-zone="verdict"><h2>候选有实际交付</h2><p>历史仅给出建议。</p></section>',
  });
  assert.match(diagnostic.draftAnalysis ?? "", /候选有实际交付/);
  assert.match(diagnostic.draftAnalysis ?? "", /历史仅给出建议/);
  const page = renderComparisonReportShell({
    title: "Comparison unavailable",
    task: "对照未能完成这次比较",
    facts: facts(),
    metrics: metricsFromReportFacts(facts()),
    diagnostic,
  });
  assert.match(page, /已有分析/);
  assert.match(page, /候选有实际交付/);
  assert.doesNotMatch(page, /data-host-zone="status"/);
});

test("failure pages keep standard Agent zone analysis", async () => {
  const { comparisonFailureDiagnostic, draftAgentSlots } = await import("../../src/application/comparison-publication.js");
  const draftHtml = renderComparisonReportShell({
    task: "修复报告。",
    facts: facts(),
    metrics: metricsFromReportFacts(facts()),
    slots: filledSlots({ "comparison": "<p>候选写出了可继续使用的文件。</p>" }),
  });
  const diagnostic = comparisonFailureDiagnostic({
    result: { status: "failed", failure: { code: "host_zone_modified", message: "Host zone was modified.", attempts: 1 } },
    facts: facts(),
    reportPresent: true,
    attemptId: "attempt-1",
    draftHtml,
  });
  const page = renderComparisonReportShell({
    title: "Comparison unavailable",
    task: "对照未能完成这次比较",
    facts: facts(),
    metrics: metricsFromReportFacts(facts()),
    diagnostic,
    slots: draftAgentSlots(draftHtml),
  });
  assert.match(page, /候选写出了可继续使用的文件/);
  assert.match(page, /对照未能完成/);
});

test("unsupported top-level Agent zones are not published", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  }).replace(
    "</body>",
    '<section data-agent-zone="verdict"><p>额外判断</p></section></body>',
  );
  const snapshot = extractHostZoneSnapshot(html);
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
    ...(snapshot ? { hostZoneSnapshot: snapshot } : {}),
  });
  assert.equal("html" in verified, false);
  if (!("html" in verified)) {
    assert.equal(verified.code, "report_incomplete");
    assert.match(verified.message, /unsupported data-agent-zone="verdict"/);
  }
});

test("Host zone delete, move, and value edits fail closed", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const snapshot = extractHostZoneSnapshot(html);
  assert.ok(snapshot);
  const metrics = metricsFromReportFacts(reportFacts);
  assert.equal(hostZonesMismatch(html, snapshot, metrics), undefined);
  const deleted = html.replace(/<section class="board"[\s\S]*?data-host-zone="metrics"[\s\S]*?<\/section>/, "");
  assert.match(hostZonesMismatch(deleted, snapshot, metrics) ?? "", /metrics/);
  const moved = html.replace(
    /(<section class="board"[\s\S]*?data-host-zone="metrics"[\s\S]*?<\/section>)([\s\S]*?)(<section class="slot" data-host-zone="evidence"[\s\S]*?<\/section>)/,
    "$2$3$1",
  );
  assert.equal(hostZonesMismatch(moved, snapshot, metrics) === "Host zone order or count was modified."
    || /Share card order/.test(hostZonesMismatch(moved, snapshot, metrics) ?? ""), true);
  const edited = html.replace('data-id="host-header"', 'data-id="host-header" data-edited="1"');
  assert.equal(hostZonesMismatch(edited, snapshot, metrics), 'Host zone "header" was modified.');
});

test("Host zone serialization differences are semantic, while metric edits still fail", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({ task: "修复报告。", facts: reportFacts, metrics: reportFacts.metrics ?? {}, slots: filledSlots() });
  const snapshot = extractHostZoneSnapshot(html);
  assert.ok(snapshot);
  const reformatted = html
    .replaceAll('data-id="host-metrics"', "data-id='host-metrics'")
    .replaceAll('data-host-zone="metrics"', "data-host-zone='metrics'")
    .replaceAll('data-host-zone="header"', "data-host-zone='header'");
  assert.equal(hostZonesMismatch(reformatted, snapshot, metricsFromReportFacts(reportFacts)), undefined);
  const spaced = html.replace(/></g, ">\n  <");
  assert.equal(hostZonesMismatch(spaced, snapshot, metricsFromReportFacts(reportFacts)), undefined);
  assert.equal(hostZonesMismatch(reformatted.replace('data-fingerprint=', 'data-fingerprint="tampered" data-old='), snapshot, metricsFromReportFacts(reportFacts)) !== undefined, true);
});

test("unknown evidence and media refs degrade instead of failing the report", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      comparison: '<p>结论成立。<a data-evidence-ref="ev-99">坏链</a></p><img data-media-ref="media-99" alt="missing preview">',
    }),
  });
  const snapshot = extractHostZoneSnapshot(html);
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
    evidence: [],
    ...(snapshot ? { hostZoneSnapshot: snapshot } : {}),
  });
  assert.equal("html" in verified, true);
  if ("html" in verified) {
    assert.match(verified.html, /结论成立/);
    assert.match(verified.html, /坏链/);
    assert.doesNotMatch(verified.html, /data-evidence-ref="ev-99"/);
    assert.doesNotMatch(verified.html, /data-media-ref="media-99"/);
    assert.match(verified.html, /证据未解析/);
  }
});

test("filling headline does not count as a Host zone edit", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const snapshot = extractHostZoneSnapshot(html);
  assert.ok(snapshot);
  const filled = html.replace(
    '<p class="note" data-agent-slot="headline">候选把讨论推进成了可继续使用的文件。</p>',
    '<p class="note" data-agent-slot="headline">改写后的结论。</p>',
  );
  assert.equal(hostZonesMismatch(filled, snapshot, metricsFromReportFacts(reportFacts)), undefined);
});

test("copied component templates keep component CSS hooks", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": '<article data-component="difference-card"><h3>实际交付</h3><p>候选有文件。</p></article>',
    }),
  });
  assert.match(html, /\[data-component="difference-card"\]/);
  assert.match(html, /data-component="difference-card"/);
  assert.match(html, /<template data-component-template="headline"/);
});

test("empty headline or comparison still publish after Host repair", async () => {
  const reportFacts = facts();
  const emptyHeadline = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: { "comparison": "<p>有差异</p>" },
  });
  const missingHeadline = await verifyAndRenderComparisonReport({
    html: emptyHeadline,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [], headline: "信封里的主要结论。" },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in missingHeadline, true);
  if ("html" in missingHeadline) {
    assert.match(missingHeadline.html, /信封里的主要结论/);
    assert.match(missingHeadline.html, /有差异/);
  }
  const emptyHeadlineNoEnvelope = await verifyAndRenderComparisonReport({
    html: emptyHeadline,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in emptyHeadlineNoEnvelope, true);
  if ("html" in emptyHeadlineNoEnvelope) {
    assert.match(emptyHeadlineNoEnvelope.html, /data-host-limitation/);
    assert.match(emptyHeadlineNoEnvelope.html, /主要结论缺失/);
  }
  const emptyDiffs = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: { headline: "一句结论。" },
  });
  const missingDiffs = await verifyAndRenderComparisonReport({
    html: emptyDiffs,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in missingDiffs, true);
  if ("html" in missingDiffs) {
    // Empty comparison is reseeded from Host media facts (unavailable note when none registered).
    assert.match(missingDiffs.html, /未登记可用的预览图|无法判断/);
    assert.match(missingDiffs.html, /一句结论/);
  }
});

test("above-the-fold process dump and visual claims without media still publish", async () => {
  const reportFacts = facts();
  const processDump = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": "<p>第1轮 第2轮 第3轮 第4轮 第5轮 第6轮 第7轮 第8轮 第9轮</p>",
    }),
  });
  const dumped = await verifyAndRenderComparisonReport({
    html: processDump,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in dumped, true);
  if ("html" in dumped) {
    assert.match(dumped.html, /data-host-limitation/);
    assert.match(dumped.html, /复述了完整过程/);
  }
  const visual = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({ "comparison": "<p>已完成视觉检查，看过PPT。</p>" }),
  });
  const claimed = await verifyAndRenderComparisonReport({
    html: visual,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in claimed, true);
  if ("html" in claimed) {
    assert.match(claimed.html, /data-host-limitation/);
    assert.match(claimed.html, /视觉检查/);
  }
});

test("metrics before comparison fail share-card order", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const metrics = html.match(/<section class="board" data-host-zone="metrics"[\s\S]*?<\/section>/)?.[0];
  assert.ok(metrics);
  const without = html.replace(metrics, "");
  const headerClose = without.indexOf("</header>");
  assert.ok(headerClose > 0);
  const swapped = `${without.slice(0, headerClose + "</header>".length)}${metrics}${without.slice(headerClose + "</header>".length)}`;
  const verified = await verifyAndRenderComparisonReport({
    html: swapped,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in verified, false);
  if (!("html" in verified)) assert.match(verified.message, /Share card order/);
});

test("details zone inside the share card fails publication", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const delivery = html.match(/<section class="slot" data-agent-zone="details"[\s\S]*?<\/section>/)?.[0];
  assert.ok(delivery);
  const without = html.replace(delivery, "");
  const headerClose = without.indexOf("</header>");
  const misplaced = `${without.slice(0, headerClose + "</header>".length)}${delivery}${without.slice(headerClose + "</header>".length)}`;
  const verified = await verifyAndRenderComparisonReport({
    html: misplaced,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in verified, false);
  if (!("html" in verified)) assert.match(verified.message, /Share card order|outside the share card/);
});

test("current harness comparison model is not the candidate vs title", () => {
  const reportFacts = buildComparisonContext(taskCase(), [runRecord()], [inspection], {
    comparisonModel: "deepseek-flash",
  }).reportFacts;
  assert.equal(reportFacts.models.comparison, "deepseek-flash");
  assert.notEqual(reportFacts.models.candidate, "deepseek-flash");
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  assert.doesNotMatch(html, /本卡由/);
  assert.doesNotMatch(html, /data-host="comparison-operator"/);
  assert.match(html, /vs gpt-5\.6/);
  assert.doesNotMatch(html, /vs deepseek-flash/);
});

test("share-card presentation reverse cases still publish after Host repair", async () => {
  const reportFacts = facts();
  const base = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const strongHeadline = base.replace(
    '<p class="note" data-agent-slot="headline">候选把讨论推进成了可继续使用的文件。</p>',
    '<p class="note" data-agent-slot="headline"><strong>候选把讨论推进成了可继续使用的文件。</strong></p>',
  );
  const strong = await verifyAndRenderComparisonReport({
    html: strongHeadline,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in strong, true);
  if ("html" in strong) {
    assert.doesNotMatch(strong.html, /<strong>/i);
    assert.match(strong.html, /候选把讨论推进成了可继续使用的文件/);
  }

  const underlined = base.replace(
    "<p>候选有交付物，历史没有。</p>",
    '<p>候选有交付物，<a href="environment/build.py" style="text-decoration:underline">历史没有</a>。</p>',
  );
  const underline = await verifyAndRenderComparisonReport({
    html: underlined,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in underline, true);
  if ("html" in underline) {
    assert.doesNotMatch(underline.html, /text-decoration:underline/);
  }

  const writtenBy = base.replace(
    '<p class="note" data-agent-slot="headline">候选把讨论推进成了可继续使用的文件。</p>',
    '<p class="note" data-agent-slot="headline">本卡由 deepseek-flash 写出</p>',
  );
  const byline = await verifyAndRenderComparisonReport({
    html: writtenBy,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in byline, true);
  if ("html" in byline) {
    assert.doesNotMatch(byline.html, /本卡由/);
  }

  const sideLabel = base.replace(
    "<p>候选有交付物，历史没有。</p>",
    "<p>历史侧有交付物，候选侧没有。</p>",
  );
  const sides = await verifyAndRenderComparisonReport({
    html: sideLabel,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in sides, true);
  if ("html" in sides) {
    assert.doesNotMatch(sides.html, /历史侧|候选侧/);
    assert.match(sides.html, /历史会话/);
    assert.match(sides.html, /当前会话/);
  }

  const hiddenSides = base.replace(
    'data-id="agent-details">',
    'data-id="agent-details"><p>历史侧自述未改正文。</p>',
  );
  const hiddenOk = await verifyAndRenderComparisonReport({
    html: hiddenSides,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in hiddenOk, true);

  const ok = await verifyAndRenderComparisonReport({
    html: base,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in ok, true);
  if ("html" in ok) {
    assert.match(ok.html, /\.share a \{ color:inherit; text-decoration:none; \}/);
    assert.doesNotMatch(ok.html, /本卡由/);
    assert.doesNotMatch(ok.html, /历史侧|候选侧/);
  }
});

test("data-claim publication checks and English report shell fail closed", async () => {
  const reportFacts = facts();
  const verifiedBare = renderComparisonReportShell({
    task: "Fix the report.",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": '<p><span data-claim="verified">The file exists.</span></p>',
    }),
  });
  const missingEvidence = await verifyAndRenderComparisonReport({
    html: verifiedBare,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
    evidence: [],
  });
  assert.equal("html" in missingEvidence, false);
  if (!("html" in missingEvidence)) {
    assert.equal(missingEvidence.code, "evidence_unresolved");
  }
  const visualBare = renderComparisonReportShell({
    task: "Fix the report.",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": '<p><span data-claim="visual">The slide is red.</span></p>',
    }),
  });
  const missingMedia = await verifyAndRenderComparisonReport({
    html: visualBare,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
  });
  assert.equal("html" in missingMedia, false);
  if (!("html" in missingMedia)) {
    assert.equal(missingMedia.code, "media_unavailable");
  }
  const parenthetical = renderComparisonReportShell({
    task: "Fix the report.",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      "comparison": '<p><span data-claim="verified">The generator emptied add_pie</span>（<a data-evidence-ref="ev-03">candidate generator</a>）</p>',
    }),
  });
  const parentheticalOk = await verifyAndRenderComparisonReport({
    html: parenthetical,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: ["ev-03"] },
    attemptRoot: ".",
    media: [],
    evidence: [{ side: "candidate", shortRef: "ev-03", inspectPath: "candidate/build.py", reportHref: "environment/build.py" }],
  });
  assert.equal("html" in parentheticalOk, true);
  const parentheticalUnknown = await verifyAndRenderComparisonReport({
    html: parenthetical,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: ".",
    media: [],
    evidence: [],
  });
  assert.equal("html" in parentheticalUnknown, false);
  if (!("html" in parentheticalUnknown)) {
    assert.equal(parentheticalUnknown.code, "evidence_unresolved");
  }
  const english = renderComparisonReportShell({
    task: "Fix the report.",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({ headline: "The candidate wrote a usable file.", "comparison": "<p>The candidate delivered a file.</p>" }),
    locale: "en",
  });
  assert.match(english, /lang="en"/);
  assert.match(english, />Task</);
  assert.match(english, />Main conclusion</);
  assert.match(english, />Historical session</);
  assert.match(english, />Current session</);
  assert.doesNotMatch(english, /[\u3400-\u9FFF]/);
  const snapshot = extractHostZoneSnapshot(english);
  assert.ok(snapshot);
  assert.equal(hostZonesMismatch(english, snapshot, metricsFromReportFacts(reportFacts), "en"), undefined);
  const zh = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots(),
  });
  const zhSnapshot = extractHostZoneSnapshot(zh);
  assert.ok(zhSnapshot);
  assert.match(zh, /data-report-format="2"/);
  assert.match(zh, /data-agent-zone="comparison"/);
  assert.equal(hostZonesMismatch(zh, zhSnapshot, metricsFromReportFacts(reportFacts)), undefined);
});

test("share card keeps diff-table visible and publishes content-addressed media before HTML", async (t) => {
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
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: filledSlots({
      comparison: '<table data-component="diff-table"><tr><td>值</td></tr></table><img src="media/ok.png" alt="preview">',
    }),
  });
  assert.doesNotMatch(html, /\.share \[data-component="diff-table"\] \{ display:none/);
  const verified = await verifyAndRenderComparisonReport({
    html, facts: reportFacts, result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: attempt, media,
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  const published = await publishComparisonArtifacts({
    attemptRoot: attempt, experimentRoot: experiment, html: verified.html, media, model: verified.model,
  });
  assert.match(published.html, /src="media\/[a-f0-9]{24}\.png"/);
  assert.equal(await readFile(join(experiment, "report.html"), "utf8"), published.html);
  assert.match(await readFile(join(experiment, "report-model.json"), "utf8"), /"formatVersion":2/);
});
