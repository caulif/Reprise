import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComparisonContext, type RunInspection } from "../../src/application/comparison.js";
import {
  classifyComparisonFailure,
  comparisonReportModelFromHtml,
  verifyAndRenderComparisonReport,
} from "../../src/application/comparison-publication.js";
import {
  extractHostZoneSnapshot,
  hostStatusMismatch,
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

test("Host status fingerprint fails when outcome text is edited", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({ task: "修复报告。", facts: reportFacts, metrics: reportFacts.metrics ?? {} });
  assert.equal(hostStatusMismatch(html, reportFacts), undefined);
  assert.equal(hostStatusMismatch(html.replace("incomplete", "completed"), reportFacts), "Host status values were modified.");
});

test("the same report model re-renders identical Host metrics and status", () => {
  const reportFacts = facts();
  const first = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: { "key-differences": "<p data-component=\"short-prose\">差异甲</p>" },
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
    slots: {
      "key-differences": "<p>候选完成了交付。</p>",
      "visual-evidence": '<img src="media/missing.png" alt="preview">',
    },
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
    assert.match(verified.html, /候选完成了交付/);
  }
});

test("registered media that exists can be published", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-ok-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: { "visual-evidence": '<img src="media/ok.png" alt="preview">', "key-differences": "<p>候选完成了交付。</p>" },
  });
  const verified = await verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [{
      ref: "media:ok",
      side: "candidate",
      inspectPath: "evidence/ok.png",
      reportHref: "media/ok.png",
      mediaType: "image/png",
      available: true,
    }],
  });
  assert.equal("html" in verified, true);
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

test("Host zone delete, move, and value edits fail closed", () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: { "key-differences": "<p>差异</p>" },
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
  assert.equal(hostZonesMismatch(moved, snapshot, metrics), "Host zone order or count was modified.");
  const edited = html.replace('data-id="host-header"', 'data-id="host-header" data-edited="1"');
  assert.equal(hostZonesMismatch(edited, snapshot, metrics), 'Host zone "header" was modified.');
});

test("unknown evidence and media refs degrade instead of failing the report", async () => {
  const reportFacts = facts();
  const html = renderComparisonReportShell({
    task: "修复报告。",
    facts: reportFacts,
    metrics: reportFacts.metrics ?? {},
    slots: {
      "key-differences": '<p>结论成立。<a data-evidence-ref="ev-99">坏链</a></p>',
      "visual-evidence": '<img data-media-ref="media-99" alt="missing preview">',
    },
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
