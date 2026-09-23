import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildComparisonContext, type RunInspection } from "../../src/application/comparison.js";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { extractHostZoneSnapshot, renderComparisonReportShell } from "../../src/application/comparison-report-shell.js";
import type { RunRecord, TaskCase } from "../../src/core/schema.js";
import { ComparisonAgent } from "../../src/agents/comparison-agent.js";
import { AgentHost } from "../../src/infrastructure/agent/host.js";

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
    "comparison": "<p>候选有交付物，历史没有。</p>",
    ...extra,
  };
}
function shell(slots?: Record<string, string>) {
  const reportFacts = facts();
  return {
    reportFacts,
    html: renderComparisonReportShell({
      task: "修复报告。",
      facts: reportFacts,
      metrics: reportFacts.metrics ?? {},
      slots: filledSlots(slots),
    }),
  };
}

async function publish(html: string, extra: Partial<Parameters<typeof verifyAndRenderComparisonReport>[0]> = {}) {
  const reportFacts = extra.facts ?? facts();
  return verifyAndRenderComparisonReport({
    html,
    facts: reportFacts,
    result: extra.result ?? { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: extra.attemptRoot ?? ".",
    media: extra.media ?? [],
    ...(extra.evidence ? { evidence: extra.evidence } : {}),
    ...(extra.hostZoneSnapshot ? { hostZoneSnapshot: extra.hostZoneSnapshot } : {}),
    ...(extra.locale ? { locale: extra.locale } : {}),
  });
}

test("layout-only failures still return success html with Host limitations", async () => {
  const headline = await publish(shell({ headline: "" }).html);
  assert.equal("html" in headline, true);
  if ("html" in headline) {
    assert.match(headline.html, /data-host-limitation/);
    assert.match(headline.html, /主要结论缺失/);
  }

  const leaked = await publish(shell({
    "comparison": "<p>见 comparison-attempts/attempt-abcdefgh 与 runId</p>",
  }).html);
  assert.equal("html" in leaked, true);
  if ("html" in leaked) {
    const diffs = leaked.html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
    assert.doesNotMatch(diffs, /comparison-attempts\//);
    assert.doesNotMatch(diffs, /\brunId\b/);
    assert.match(diffs, /见/);
  }

  const verifiedWord = await publish(shell({
    "comparison": "<p>结论已核验。</p>",
  }).html);
  assert.equal("html" in verifiedWord, true);
  if ("html" in verifiedWord) {
    assert.match(verifiedWord.html, /data-host-limitation/);
    assert.match(verifiedWord.html, /核验措辞/);
  }
});

test("contract failures still reject publication", async () => {
  const { html, reportFacts } = shell();
  const snapshot = extractHostZoneSnapshot(html);
  assert.ok(snapshot);
  const edited = html.replace('data-id="host-header"', 'data-id="host-header" data-edited="1"');
  const host = await publish(edited, { hostZoneSnapshot: snapshot, facts: reportFacts });
  assert.equal("html" in host, false);
  if (!("html" in host)) assert.equal(host.code, "host_zone_modified");

  const extraZone = html.replace("</body>", '<section data-agent-zone="verdict"><p>额外判断</p></section></body>');
  const unexpected = await publish(extraZone);
  assert.equal("html" in unexpected, false);

  const verifiedBare = shell({
    "comparison": '<p><span data-claim="verified">The file exists.</span></p>',
  }).html;
  const missingEvidence = await publish(verifiedBare, { evidence: [] });
  assert.equal("html" in missingEvidence, false);
  if (!("html" in missingEvidence)) assert.equal(missingEvidence.code, "evidence_unresolved");

  const visualBare = shell({
    "comparison": '<p><span data-claim="visual">The slide is red.</span></p>',
  }).html;
  const missingMedia = await publish(visualBare);
  assert.equal("html" in missingMedia, false);
  if (!("html" in missingMedia)) assert.equal(missingMedia.code, "media_unavailable");

  const networked = html.replace(
    "<p>候选有交付物，历史没有。</p>",
    '<p style="background:url(https://evil.example/x.png)">候选有交付物，历史没有。</p>',
  );
  const external = await publish(networked);
  assert.equal("html" in external, false);
  if (!("html" in external)) assert.equal(external.code, "report_incomplete");
});

test("unpaired share-card images publish with nearby missing-side limitation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tier-unpaired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const { html } = shell({ comparison: '<img src="media/ok.png" alt="preview">' });
  const verified = await publish(html, {
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
    const visual = verified.html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
    assert.match(visual, /<img\b/);
    assert.match(verified.html, /data-host-limitation/);
  }
});

test("Comparison cancel requires attemptId and does not cancel other attempts", async () => {
  const providerCancel = { a: 0, b: 0 };
  let created = 0;
  let startedA!: () => void;
  let startedB!: () => void;
  const readyA = new Promise<void>((resolve) => { startedA = resolve; });
  const readyB = new Promise<void>((resolve) => { startedB = resolve; });
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => {
        const which = created++ === 0 ? "a" : "b";
        return {
          append: async () => {
            if (which === "a") startedA();
            else startedB();
            await new Promise<string>(() => {});
            return "";
          },
          cancel() {
            providerCancel[which] += 1;
          },
        };
      },
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const context = {
    task: { caseId: "case-1", summary: "Compare." },
    baseline: { summary: "Baseline.", evidenceRefs: [] as const },
    candidates: [] as const,
    telemetry: [] as const,
    artifactRefs: [] as const,
    allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: {
      run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
      models: { candidate: "fixture" },
      activity: {},
      limits: { triggered: [] as const },
      runtime: { productId: "codex" },
      delivery: { changedPaths: [] as const, targetArtifactStatus: "unavailable", verificationStatus: "unavailable" },
      replay: { conditions: [] as const, baselineEvidence: "unavailable", candidateEvidence: "unavailable" },
    },
  };
  const hangingA = comparison.compare({ ...context, attemptId: "attempt-a" });
  await readyA;
  const hangingB = comparison.compare({ ...context, attemptId: "attempt-b" });
  await readyB;
  await assert.rejects(() => comparison.cancel(""), /attemptId/);
  assert.equal(providerCancel.a, 0);
  assert.equal(providerCancel.b, 0);
  await comparison.cancel("attempt-a");
  assert.equal((await hangingA).status, "cancelled");
  assert.equal(providerCancel.a, 1);
  assert.equal(providerCancel.b, 0);
  await comparison.cancel("attempt-b");
  assert.equal((await hangingB).status, "cancelled");
  assert.equal(providerCancel.b, 1);
});
