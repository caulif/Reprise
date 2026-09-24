import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@sinclair/typebox";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
import {
  publishComparisonArtifacts,
  verifyAndRenderComparisonReport,
} from "../../src/application/comparison-publication.js";
import { writeComparisonContent } from "../comparison-content-support.js";
import { AgentHost, type AgentAuditEvent } from "../../src/infrastructure/agent/host.js";
import { imageContentHash } from "../../src/infrastructure/agent/model-input.js";
import { sha256 } from "../../src/core/identity.js";

const stamp = "2026-09-01T00:00:00.000Z";
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

function facts(): ComparisonReportFacts {
  return {
    run: {
      runId: "run-c1",
      outcome: "completed",
      terminationCode: "completed",
      initiatedBy: "operator",
      elapsedMs: 1_000,
      candidateElapsedMs: 900,
    },
    models: { candidate: "model-a", baseline: "model-b", comparison: "harness-text" },
    activity: { candidateTurns: 1, controllerCalls: 0, toolCalls: { total: 0, succeeded: 0, failed: 0, rejectedApprovals: 0 } },
    limits: { triggered: [] },
    runtime: { productId: "codex" },
    delivery: { changedPaths: ["out.html"], targetArtifactStatus: "present", verificationStatus: "passed" },
    replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
    metrics: {
      baseline: { elapsedMs: 800, tokens: { total: 10 }, costUsd: 0.01, usageStatus: "collected", pricingStatus: "collected", pricingVersion: "v1", collectedAt: stamp },
      candidate: { elapsedMs: 900, tokens: { total: 12 }, costUsd: 0.02, usageStatus: "collected", pricingStatus: "collected", pricingVersion: "v1", collectedAt: stamp },
    },
  };
}

test("C1: text-only Host strips image blocks while report can publish real imgs without visual claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-c1-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-c1-exp-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));

  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "history.png"), PNG_BYTES);
  await writeFile(join(root, "media", "candidate.png"), PNG_BYTES);
  const contentHash = sha256(PNG_BYTES);
  assert.equal(imageContentHash(PNG_BYTES.toString("base64")), contentHash);

  const image = {
    type: "image" as const,
    data: PNG_BYTES.toString("base64"),
    mimeType: "image/png",
  };
  let promptImages: unknown;
  let toolHadImage = true;
  const audit: AgentAuditEvent[] = [];
  const host = new AgentHost({
    inputCapabilities: ["text"],
    createSession: (input) => ({
      inputCapabilities: ["text"],
      append: async ({ images }) => {
        promptImages = images;
        const result = await input.tools[0]?.execute({}, new AbortController().signal);
        toolHadImage = Boolean(result?.contentBlocks?.some((block) => block.type === "image"));
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: "comparison",
    systemPrompt: "compare",
    tools: [{
      name: "preview",
      description: "return an image",
      parameters: Type.Object({}),
      execute: async () => ({
        content: "preview ready",
        contentBlocks: [{ type: "text" as const, text: "preview ready" }, image],
      }),
    }],
    audit: { append: async (event) => { audit.push(event); } },
  });
  const request = await session.request({
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
    promptContent: "inspect",
    promptImages: [image],
  });
  assert.equal(request.status, "completed");
  assert.equal(promptImages, undefined);
  assert.equal(toolHadImage, false);
  const appended = audit.find((event) => event.type === "agent.message_appended");
  assert.deepEqual(appended?.payload.images, []);
  await session.close();

  const content = await writeComparisonContent(root,
    '<p>两侧预览如下，供人阅读；本会话未做视觉核验。</p>'
    + '<img data-media-ref="media-01" alt="historical preview">'
    + '<img data-media-ref="media-02" alt="candidate preview">',
  );
  const media = [
    {
      ref: "media:history",
      shortRef: "media-01",
      side: "baseline" as const,
      inspectPath: "media/history.png",
      reportHref: "media/history.png",
      mediaType: "image/png",
      available: true,
      contentHash,
      byteLength: PNG_BYTES.byteLength,
    },
    {
      ref: "media:candidate",
      shortRef: "media-02",
      side: "candidate" as const,
      inspectPath: "media/candidate.png",
      reportHref: "media/candidate.png",
      mediaType: "image/png",
      available: true,
      contentHash,
      byteLength: PNG_BYTES.byteLength,
    },
  ];
  const verified = await verifyAndRenderComparisonReport({
    content, hostTask: "生成可分享预览。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media,
    deliveredImageContentHashes: new Set(),
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  assert.match(verified.html, /src="media\/history\.png"/);
  assert.match(verified.html, /src="media\/candidate\.png"/);
  const comparison = verified.html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
  assert.doesNotMatch(comparison, /data-claim="visual"/);

  await writeFile(join(root, "report.html"), verified.html);
  const published = await publishComparisonArtifacts({
    attemptRoot: root,
    experimentRoot,
    html: verified.html,
    media,
    model: verified.model,
  });
  assert.match(published.html, /src="media\/[a-f0-9]{24}\.png"/);
  const publishedComparison = published.html.match(/data-id="agent-comparison"[^>]*>([\s\S]*?)<\/section>/i)?.[1] ?? "";
  assert.doesNotMatch(publishedComparison, /data-claim="visual"/);
  const digest = createHash("sha256").update(PNG_BYTES).digest("hex").slice(0, 24);
  const publishedBytes = await readFile(join(experimentRoot, "media", `${digest}.png`));
  assert.deepEqual(publishedBytes, PNG_BYTES);
});

test("C1 reverse: available media without session delivery rejects data-claim=visual", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-c1-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "history.png"), PNG_BYTES);
  const contentHash = sha256(PNG_BYTES);
  const content = await writeComparisonContent(root,
    '<p><span data-claim="visual" data-media-ref="media-01">画面为红色。</span></p>'
    + '<img data-media-ref="media-01" alt="historical preview">',
  );
  const rejected = await verifyAndRenderComparisonReport({
    content, hostTask: "生成可分享预览。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [{
      ref: "media:history",
      shortRef: "media-01",
      side: "baseline",
      inspectPath: "media/history.png",
      reportHref: "media/history.png",
      mediaType: "image/png",
      available: true,
      contentHash,
    }],
    deliveredImageContentHashes: new Set(),
  });
  assert.equal("html" in rejected, false);
  if ("html" in rejected) return;
  assert.equal(rejected.code, "media_unavailable");
  assert.match(rejected.message, /session-delivered media/);
});

test("C1: visual claim accepted when cited media contentHash was delivered to the Session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-c1-delivered-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "history.png"), PNG_BYTES);
  const contentHash = sha256(PNG_BYTES);
  const content = await writeComparisonContent(root,
    '<p><span data-claim="visual" data-media-ref="media-01">画面为红色。</span></p>'
    + '<img data-media-ref="media-01" alt="historical preview">',
  );
  const verified = await verifyAndRenderComparisonReport({
    content, hostTask: "生成可分享预览。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot: root,
    media: [{
      ref: "media:history",
      shortRef: "media-01",
      side: "baseline",
      inspectPath: "media/history.png",
      reportHref: "media/history.png",
      mediaType: "image/png",
      available: true,
      contentHash,
    }],
    deliveredImageContentHashes: new Set([contentHash]),
  });
  assert.equal("html" in verified, true);
  if (!("html" in verified)) return;
  assert.match(verified.html, /src="media\/history\.png"/);
});

test("C1: materializeComparisonMedia seeds contentHash so visual claims can bind to delivery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-c1-seed-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "attempt");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, "out"), { recursive: true });
  await writeFile(join(workspaceRoot, "out", "shot.png"), PNG_BYTES);
  const { materializeComparisonMedia } = await import("../../src/application/comparison-media.js");
  const media = await materializeComparisonMedia({
    attemptRoot,
    workspaceRoot,
    links: [{
      side: "candidate",
      inspectPath: "candidate/out/shot.png",
      mediaType: "image/png",
    }],
  });
  assert.equal(media.length, 1);
  assert.equal(media[0]?.available, true);
  assert.equal(media[0]?.contentHash, sha256(PNG_BYTES));
  assert.equal(media[0]?.byteLength, PNG_BYTES.byteLength);

  const content = await writeComparisonContent(attemptRoot,
    '<p><span data-claim="visual" data-media-ref="media-01">画面为红色。</span></p>'
    + '<img data-media-ref="media-01" alt="candidate preview">',
  );
  const withShort = media.map((item, index) => ({ ...item, shortRef: `media-0${index + 1}` }));
  const rejected = await verifyAndRenderComparisonReport({
    content, hostTask: "生成可分享预览。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media: withShort,
    deliveredImageContentHashes: new Set(),
  });
  assert.equal("html" in rejected, false);
  if ("html" in rejected) return;
  assert.equal(rejected.code, "media_unavailable");

  const accepted = await verifyAndRenderComparisonReport({
    content, hostTask: "生成可分享预览。",
    facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media: withShort,
    deliveredImageContentHashes: new Set([sha256(PNG_BYTES)]),
  });
  assert.equal("html" in accepted, true);
});
