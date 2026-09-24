import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import { writeComparisonContent } from "../comparison-content-support.js";
import { ComparisonAgent } from "../../src/agents/comparison-agent.js";
import { AgentHost } from "../../src/infrastructure/agent/host.js";

const facts: ComparisonReportFacts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { baseline: "historical", candidate: "candidate" }, activity: {}, limits: { triggered: [] },
  runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

async function publish(body: string, extra: Partial<Parameters<typeof verifyAndRenderComparisonReport>[0]> = {}) {
  const root = extra.attemptRoot ?? await mkdtemp(join(tmpdir(), "reprise-tier-"));
  try {
    const content = await writeComparisonContent(root, body, "候选把讨论推进成了可继续使用的文件。");
    return await verifyAndRenderComparisonReport({ content, hostTask: "修复报告。", facts,
      attemptRoot: root, media: extra.media ?? [], evidence: extra.evidence ?? [],
      ...(extra.locale ? { locale: extra.locale } : {}) });
  } finally {
    if (!extra.attemptRoot) await rm(root, { recursive: true, force: true });
  }
}

test("layout repairs only visible text and flags unsupported verification wording", async () => {
  const leaked = await publish('<p>见 comparison-attempts/attempt-abcdefgh 与 runId</p>');
  assert.ok("html" in leaked);
  if ("html" in leaked) {
    const comparison = leaked.html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? "";
    assert.doesNotMatch(comparison, /comparison-attempts\/|\brunId\b/);
  }
  const verifiedWord = await publish("<p>结论已核验。</p>");
  assert.ok("html" in verifiedWord);
  if ("html" in verifiedWord) assert.match(verifiedWord.html, /核验措辞/);
});

test("content contract rejects unsafe markup while unresolved claims fail publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tier-contract-"));
  try {
    await assert.rejects(writeComparisonContent(root, '<p style="background:url(https://evil.example/x.png)">差异</p>'), /style/);
    await assert.rejects(writeComparisonContent(root, '<section data-host-zone="header">伪造</section>'), /zone markers/);
  } finally { await rm(root, { recursive: true, force: true }); }
  const missingEvidence = await publish('<p><span data-claim="verified">The file exists.</span></p>');
  assert.ok("failureClass" in missingEvidence);
  if ("failureClass" in missingEvidence) assert.equal(missingEvidence.code, "evidence_unresolved");
  const missingMedia = await publish('<p><span data-claim="visual">The slide is red.</span></p>');
  assert.ok("failureClass" in missingMedia);
  if ("failureClass" in missingMedia) assert.equal(missingMedia.code, "media_unavailable");
});

test("unpaired share-card images publish with nearby missing-side limitation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tier-unpaired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "ok.png"), Buffer.from([137, 80, 78, 71]));
  const verified = await publish('<img src="media/ok.png" alt="preview">', {
    attemptRoot: root,
    media: [{ ref: "media:ok", shortRef: "media-01", side: "candidate", inspectPath: "evidence/ok.png",
      reportHref: "media/ok.png", mediaType: "image/png", available: true }],
  });
  assert.ok("html" in verified);
  if ("html" in verified) {
    assert.match(verified.html, /<img\b/);
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
  const comparison = new ComparisonAgent({ host: new AgentHost({ createSession: () => {
    const which = created++ === 0 ? "a" : "b";
    return { append: async () => { if (which === "a") startedA(); else startedB(); await new Promise<string>(() => {}); return ""; },
      cancel() { providerCancel[which] += 1; } };
  } }), timeoutMs: 0, maxRepairAttempts: 0 });
  const context = {
    task: { caseId: "case-1", summary: "Compare." }, baseline: { summary: "Baseline.", evidenceRefs: [] as const },
    candidates: [] as const, telemetry: [] as const, artifactRefs: [] as const, allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: { run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
      models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] as const }, runtime: { productId: "codex" },
      delivery: { changedPaths: [] as const, targetArtifactStatus: "unavailable", verificationStatus: "unavailable" },
      replay: { conditions: [] as const, baselineEvidence: "unavailable", candidateEvidence: "unavailable" } },
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
