import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import { verifyAndRenderComparisonReport } from "../../src/application/comparison-publication.js";
import { renderComparisonReportShell } from "../../src/application/comparison-report-shell.js";
import { writeComparisonContent } from "../comparison-content-support.js";

const facts: ComparisonReportFacts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { baseline: "historical-model", candidate: "candidate-model" }, activity: {}, limits: { triggered: [] },
  runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "unavailable" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
  metrics: { baseline: { elapsedMs: 5000 }, candidate: { elapsedMs: 7000 } },
};

async function verify(body: string) {
  const root = await mkdtemp(join(tmpdir(), "reprise-content-publication-"));
  try {
    const content = await writeComparisonContent(root, body, "候选交付了文件。");
    return await verifyAndRenderComparisonReport({ content, hostTask: "Host 原任务文案。", facts,
      attemptRoot: root, media: [], evidence: [], deliveredImageContentHashes: new Set() });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("Host constructs task, title, metrics, and evidence from trusted facts", async () => {
  const result = await verify("<p>候选交付了文件。</p>");
  assert.ok("html" in result);
  if ("html" in result) {
    assert.match(result.html, /Host 原任务文案。/);
    assert.match(result.html, /候选交付了文件。/);
    assert.match(result.html, /data-host-zone="evidence"/);
    assert.equal(result.model.metrics?.candidate?.elapsedMs, 7000);
  }
});

test("content fragments cannot include Host or Agent zone markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-content-markers-"));
  try {
    for (const body of [
      '<section data-host-zone="metrics">forged</section>',
      '<section data-agent-zone="comparison">nested</section>',
      '<p data-agent-slot="headline">forged</p>',
    ]) await assert.rejects(writeComparisonContent(root, body), /zone markers/, body);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("active HTML, overlays, and resource attributes cannot enter a content fragment", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-content-unsafe-"));
  try {
    const payloads = [
      '<ScRiPt>alert(1)</ScRiPt><p>差异。</p>',
      '<img src=media/ok.png OnErRoR=alert(1) alt=preview>',
      '<a href=&#x6a;avascript:alert(1)>打开</a>',
      '<a href="java&#10;script:alert(1)">打开</a>',
      '<a href=DaTa:text/html,attack>打开</a>',
      '<img src=https://external.example/frame.png alt="external">',
      '<svg OnLoAd=alert(1)><circle r=2></circle></svg>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<p style="background:url(//evil.example/x.png)">差异。</p>',
      '<template><script>alert(1)</script></template><p>差异。</p>',
      '<noscript>Invisible claim.</noscript>',
      '<dialog open>FAKE HOST FACTS</dialog>',
      '<div popover id="fake">FAKE HOST FACTS</div>',
      '<table background="media/unregistered.svg"><tr><td>FAKE HOST FACTS</td></tr></table>',
      '<video poster="media/unregistered.svg" controls></video>',
      '<video src="media/unregistered.mp4" controls></video>',
    ];
    for (const body of payloads) await assert.rejects(writeComparisonContent(root, body), /Invalid comparison fragment/, body);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unregistered evidence, media, and visual claims fail publication", async () => {
  for (const [body, code] of [
    ['<p><a data-evidence-ref="ev-99">没有登记</a></p>', "evidence_unresolved"],
    ['<p><img data-media-ref="media-99" alt="没有登记"></p>', "media_unavailable"],
    ['<p><span data-claim="visual">我看到了红色</span></p>', "media_unavailable"],
  ] as const) {
    const result = await verify(body);
    assert.ok("failureClass" in result, body);
    if ("failureClass" in result) assert.equal(result.code, code);
  }
});

test("unregistered unquoted and entity-encoded image sources cannot survive publication", async () => {
  for (const image of [
    '<img src=media/unregistered.png alt="preview">',
    '<img src="media&#47;unregistered.png" alt="preview">',
  ]) {
    const result = await verify(`<p>差异。</p>${image}`);
    if ("html" in result) assert.doesNotMatch(result.html, /<img[^>]*src="media\/unregistered\.png"/i);
    else assert.equal(result.code, "media_unavailable");
  }
});

test("report title and side labels show requested and resolved models without changing raw ID", () => {
  const divergent: ComparisonReportFacts = { ...facts, models: { ...facts.models, candidate: "deepseek/deepseek-v4.1-flash",
    candidateRequested: "sonnet", candidateResolved: "deepseek/deepseek-v4.1-flash" } };
  const html = renderComparisonReportShell({ task: "Host 原任务文案。", facts: divergent, metrics: {}, locale: "zh" });
  assert.match(html, /请求 sonnet → 解析 deepseek\/deepseek-v4\.1-flash/);
  assert.equal(divergent.models.candidate, "deepseek/deepseek-v4.1-flash");
  const same = renderComparisonReportShell({ task: "Task.", facts: { ...facts,
    models: { ...facts.models, candidateRequested: "sonnet", candidateResolved: "sonnet" } }, metrics: {}, locale: "en" });
  assert.doesNotMatch(same, /requested sonnet → resolved sonnet/);
});
