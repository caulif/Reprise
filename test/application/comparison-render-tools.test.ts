import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/identity.js";
import { createEphemeralRenderCatalog } from "./comparison-render-catalog-ephemeral.js";
import {
  createPreviewReportTool,
  createRenderArtifactTool,
} from "../../src/application/comparison-render-tools.js";
import { materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import { createFakeArtifactRenderer } from "../../src/infrastructure/artifact-renderer.js";
import { DEFAULT_RENDER_VIEWPORT } from "../../src/infrastructure/artifact-render-types.js";

const PNG_A = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("render_artifact registers frames through catalog and dedupes identical derivation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-tool-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "bundle"), { recursive: true });
  await writeFile(join(root, "bundle", "card.html"), "<!doctype html><title>card</title>", "utf8");
  const catalog = createEphemeralRenderCatalog({
    sources: [{
      sourceRef: "ev-01",
      side: "baseline",
      bundleRoot: join(root, "bundle"),
      entryRelativePath: "card.html",
      contentHash: "abc",
      origin: "historical_artifact",
    }],
    mediaRoot: join(root, "media"),
    reviewRoot: join(root, "review"),
  });
  let renderCalls = 0;
  const render = createFakeArtifactRenderer(async (request) => {
    renderCalls += 1;
    await mkdir(request.outputRoot, { recursive: true });
    const frames = [];
    for (const [index, sampleTimeMs] of request.sampleTimesMs.entries()) {
      const bytes = index === 0 ? PNG_A : PNG_B;
      const pngPath = join(request.outputRoot, `f-${index}.png`);
      await writeFile(pngPath, bytes);
      frames.push({
        sampleTimeMs,
        actualTimeMs: sampleTimeMs,
        pngPath,
        byteLength: bytes.byteLength,
        contentHash: sha256(bytes),
      });
    }
    return {
      ok: true,
      frames,
      diagnostics: [{ code: "network_blocked", message: "blocked", detail: "http://example.test" }],
      measured: { loadMs: 3, viewport: request.viewport, origin: "fake://x" },
    };
  });
  const tool = createRenderArtifactTool({
    catalog,
    attemptRoot: root,
    render,
  });
  const first = await tool.execute({ sourceRef: "ev-01", sampleTimesMs: [0, 500] }, new AbortController().signal);
  const payload = JSON.parse(first.content) as {
    status: string;
    media: { shortRef: string }[];
    revision: number;
    limitations: string[];
  };
  assert.equal(payload.status, "ok");
  assert.equal(payload.media.length, 2);
  assert.equal(payload.media[0]?.shortRef, "media-01");
  assert.equal(payload.media[1]?.shortRef, "media-02");
  assert.ok(payload.limitations.some((item) => /network/i.test(item)));
  const second = await tool.execute({ sourceRef: "ev-01", sampleTimesMs: [0, 500] }, new AbortController().signal);
  const payload2 = JSON.parse(second.content) as { media: { shortRef: string }[]; revision: number };
  assert.equal(payload2.media[0]?.shortRef, "media-01");
  assert.equal(payload2.media[1]?.shortRef, "media-02");
  assert.equal(renderCalls, 2);
  assert.equal(catalog.media.length, 2);
});

test("render_artifact rejects unknown source and cancelled render", async () => {
  const catalog = createEphemeralRenderCatalog({
    sources: [],
    mediaRoot: "/tmp/unused-media",
    reviewRoot: "/tmp/unused-review",
  });
  const tool = createRenderArtifactTool({
    catalog,
    attemptRoot: "/tmp/attempt",
    render: async () => ({ ok: false, failure: { kind: "cancelled" }, diagnostics: [] }),
  });
  const missing = JSON.parse((await tool.execute({ sourceRef: "ev-99" }, new AbortController().signal)).content) as {
    status: string;
  };
  assert.equal(missing.status, "unknown_source");
});

test("preview_report uses prepared digests and marks review media", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-tool-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "a.png"), PNG_A);
  const draft = `<!doctype html><html><body>
<article class="share">
<section data-host-zone="metrics">metrics</section>
<span>历史会话</span><span>当前会话</span>
<section data-agent-zone="visual-evidence"><img data-media-ref="media-01" alt=""></section>
</article>
</body></html>`;
  await writeFile(join(root, "report.html"), draft, "utf8");
  const media = [{
    ref: "media:a",
    shortRef: "media-01",
    side: "baseline" as const,
    inspectPath: "media/a.png",
    reportHref: "media/a.png",
    mediaType: "image/png",
    available: true,
  }];
  const catalog = createEphemeralRenderCatalog({
    sources: [],
    mediaRoot: join(root, "media"),
    reviewRoot: join(root, "review", "media"),
  });
  const render = createFakeArtifactRenderer(async (request) => {
    assert.equal(request.entryRelativePath, "preview.html");
    await mkdir(request.outputRoot, { recursive: true });
    const pngPath = join(request.outputRoot, "preview.png");
    await writeFile(pngPath, PNG_B);
    return {
      ok: true,
      frames: [{
        sampleTimeMs: 0,
        actualTimeMs: 0,
        pngPath,
        byteLength: PNG_B.byteLength,
        contentHash: sha256(PNG_B),
      }],
      diagnostics: [],
      measured: { loadMs: 2, viewport: DEFAULT_RENDER_VIEWPORT, origin: "fake://preview" },
    };
  });
  const tool = createPreviewReportTool({
    catalog,
    attemptRoot: root,
    render,
    prepareReportHtml: async () => materializeComparisonReportPreview({
      attemptRoot: root,
      media,
      catalogRevision: catalog.revision(),
    }),
  });
  const first = JSON.parse((await tool.execute({}, new AbortController().signal)).content) as {
    status: string;
    draftDigest: string;
    preparedDigest: string;
    previewDigest: string;
    previewMedia: { kind: string; shortRef: string };
    mechanics: { imagesMissingSrc: number; hostMetricsVisible: boolean };
    note: string;
  };
  assert.equal(first.status, "ok");
  assert.equal(first.draftDigest, sha256(draft));
  assert.notEqual(first.preparedDigest, first.draftDigest);
  assert.equal(first.previewMedia.kind, "report_review");
  assert.match(first.previewMedia.shortRef, /^review-\d{2}$/);
  assert.match(first.note, /review-\*|not baseline\/candidate/i);
  assert.equal(first.mechanics.hostMetricsVisible, true);
  assert.equal(first.mechanics.imagesMissingSrc, 0);

  await writeFile(join(root, "report.html"), `${draft}\n<!-- edited -->`, "utf8");
  const second = JSON.parse((await tool.execute({}, new AbortController().signal)).content) as {
    draftDigest: string;
  };
  assert.notEqual(second.draftDigest, first.draftDigest);
});

test("materializeComparisonReportPreview writes preview.html without touching draft path bytes contract", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-materialize-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "media"), { recursive: true });
  await writeFile(join(root, "media", "a.png"), PNG_A);
  const draft = `<section data-agent-zone="visual-evidence"><img data-media-ref="media-01"></section>`;
  await writeFile(join(root, "report.html"), draft, "utf8");
  const prepared = await materializeComparisonReportPreview({
    attemptRoot: root,
    media: [{
      ref: "media:a",
      shortRef: "media-01",
      side: "candidate",
      inspectPath: "media/a.png",
      reportHref: "media/a.png",
      mediaType: "image/png",
      available: true,
    }],
    catalogRevision: 3,
  });
  assert.equal(prepared.catalogRevision, 3);
  assert.match(prepared.html, /src="media\/a\.png"/);
  assert.equal(await readFile(join(root, "report.html"), "utf8"), draft);
  assert.match(await readFile(prepared.htmlPath, "utf8"), /src="media\/a\.png"/);
});
