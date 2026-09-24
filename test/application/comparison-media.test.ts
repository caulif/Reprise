import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeComparisonMedia } from "../../src/application/comparison-media.js";
import { withMediaShortRefs } from "../../src/application/comparison-short-refs.js";
import {
  verifyAndRenderComparisonReport,
} from "../../src/application/comparison-publication.js";
import { writeComparisonContent } from "../comparison-content-support.js";
import type { ComparisonReportFacts } from "../../src/agents/comparison-agent.js";
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
      runId: "run-media-hash",
      outcome: "completed",
      terminationCode: "completed",
      initiatedBy: "operator",
      elapsedMs: 1_000,
      candidateElapsedMs: 900,
    },
    models: { candidate: "model-a", baseline: "model-b", comparison: "harness-vision" },
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

test("materializeComparisonMedia sets contentHash from available seed file bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "attempt");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(attemptRoot, "history", "media"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(attemptRoot, "history", "media", "seed.png"), PNG_BYTES);
  const expected = sha256(PNG_BYTES);
  assert.equal(imageContentHash(PNG_BYTES.toString("base64")), expected);

  const media = await materializeComparisonMedia({
    attemptRoot,
    workspaceRoot,
    links: [{
      side: "baseline",
      inspectPath: "history/media/seed.png",
      mediaType: "image/png",
    }],
  });
  assert.equal(media.length, 1);
  assert.equal(media[0]?.available, true);
  assert.equal(media[0]?.contentHash, expected);
  assert.equal(media[0]?.byteLength, PNG_BYTES.byteLength);
});

test("reverse: unavailable seed media omits contentHash so delivery gate cannot match", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "attempt");
  const workspaceRoot = join(root, "workspace");
  await mkdir(attemptRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });

  const media = await materializeComparisonMedia({
    attemptRoot,
    workspaceRoot,
    links: [{
      side: "baseline",
      inspectPath: "history/media/missing.png",
      mediaType: "image/png",
    }],
  });
  assert.equal(media.length, 1);
  assert.equal(media[0]?.available, false);
  assert.equal(media[0]?.contentHash, undefined);

  const withRefs = withMediaShortRefs(media);
  const shortRef = withRefs[0]?.shortRef;
  assert.ok(shortRef);
  const rejected = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(attemptRoot,
      `<p><span data-claim="visual" data-media-ref="${shortRef}">画面为红色。</span></p>`
      + `<img data-media-ref="${shortRef}" alt="missing">`,
    ),
    hostTask: "核对媒体 hash。", facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media: withRefs,
    deliveredImageContentHashes: new Set([sha256(PNG_BYTES)]),
  });
  assert.equal("html" in rejected, false);
  if ("html" in rejected) return;
  assert.equal(rejected.code, "media_unavailable");
});

test("materialized seed contentHash binds visual claim when Session delivered those bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-media-delivered-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const attemptRoot = join(root, "attempt");
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(attemptRoot, "history", "media"), { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(attemptRoot, "history", "media", "seed.png"), PNG_BYTES);

  const media = withMediaShortRefs(await materializeComparisonMedia({
    attemptRoot,
    workspaceRoot,
    links: [{
      side: "baseline",
      inspectPath: "history/media/seed.png",
      mediaType: "image/png",
    }],
  }));
  const shortRef = media[0]?.shortRef;
  const contentHash = media[0]?.contentHash;
  assert.ok(shortRef);
  assert.ok(contentHash);
  assert.equal(contentHash, imageContentHash(PNG_BYTES.toString("base64")));

  const verified = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(attemptRoot,
      `<p><span data-claim="visual" data-media-ref="${shortRef}">画面为红色。</span></p>`
      + `<img data-media-ref="${shortRef}" alt="seed">`,
    ),
    hostTask: "核对媒体 hash。", facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media,
    deliveredImageContentHashes: new Set([contentHash]),
  });
  assert.equal("html" in verified, true);

  const bareOk = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(attemptRoot,
      '<p>供人阅读，本会话未做视觉核验。</p>'
      + `<img data-media-ref="${shortRef}" alt="seed">`,
    ),
    hostTask: "核对媒体 hash。", facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media,
    deliveredImageContentHashes: new Set(),
  });
  assert.equal("html" in bareOk, true);

  const claimRejected = await verifyAndRenderComparisonReport({
    content: await writeComparisonContent(attemptRoot,
      `<p><span data-claim="visual" data-media-ref="${shortRef}">画面为红色。</span></p>`
      + `<img data-media-ref="${shortRef}" alt="seed">`,
    ),
    hostTask: "核对媒体 hash。", facts: facts(),
    result: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
    attemptRoot,
    media,
    deliveredImageContentHashes: new Set(),
  });
  assert.equal("html" in claimRejected, false);
  if ("html" in claimRejected) return;
  assert.equal(claimRejected.code, "media_unavailable");
  assert.match(claimRejected.message, /session-delivered media/);
});
