import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPairedVisualMediaOrThrow,
  augmentComparisonOpenableMedia,
  ComparisonVisualMediaError,
} from "../../src/application/comparison-openable-media.js";
import { isOpenableFinalPath } from "../../src/application/openable-final-path.js";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../../src/core/schema.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("isOpenableFinalPath recognizes html and svg deliverables", () => {
  assert.equal(isOpenableFinalPath("deck/page-1.html"), true);
  assert.equal(isOpenableFinalPath("preview.svg"), true);
  assert.equal(isOpenableFinalPath("notes.txt"), false);
});

test("assertPairedVisualMediaOrThrow fails when both sides have visuals but media is empty", () => {
  assert.throws(
    () => assertPairedVisualMediaOrThrow({
      baselineSources: [{ inspectPath: "history/finals/a.html", absolutePath: "/tmp/a.html" }],
      candidateSources: [{ inspectPath: "candidate/out.html", absolutePath: "/tmp/out.html" }],
      links: [],
      media: [],
    }),
    ComparisonVisualMediaError,
  );
});

test("assertPairedVisualMediaOrThrow accepts paired available media", () => {
  const media: ComparisonMediaRecord[] = [
    { ref: "media:a", side: "baseline", inspectPath: "history/media/a.png", reportHref: "media/a.png", mediaType: "image/png", available: true },
    { ref: "media:b", side: "candidate", inspectPath: "candidate/out.png", reportHref: "media/b.png", mediaType: "image/png", available: true },
  ];
  assert.doesNotThrow(() => assertPairedVisualMediaOrThrow({
    baselineSources: [],
    candidateSources: [],
    links: [
      { side: "baseline", inspectPath: "history/media/a.png", mediaType: "image/png" },
      { side: "candidate", inspectPath: "candidate/out.png", mediaType: "image/png" },
    ] satisfies ComparisonLinkRecord[],
    media,
  }));
});

test("sealed baseline html is copied into attempt history finals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-openable-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const attemptRoot = join(root, "attempt");
  const baselineHtml = join(root, "baseline.html");
  await mkdir(join(attemptRoot, "history", "finals"), { recursive: true });
  await writeFile(baselineHtml, "<!doctype html><title>baseline</title>", "utf8");
  await augmentComparisonOpenableMedia({
    attemptRoot,
    workspaceRoot: root,
    links: [],
    baselineSources: [{ inspectPath: "history/finals/baseline.html", absolutePath: baselineHtml }],
    candidateSources: [],
  }).catch((error: unknown) => {
    if (!(error instanceof ComparisonVisualMediaError)) throw error;
  });
  const sealed = join(attemptRoot, "history", "finals", "baseline.html");
  const body = await readFile(sealed, "utf8");
  assert.match(body, /baseline/);
});

test("augmentComparisonOpenableMedia screenshots dual html when links only reference html", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-openable-dual-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const captureCalls: { source: string; dest: string }[] = [];
  const attemptRoot = join(root, "attempt");
  const baselineHtml = join(root, "baseline", "deck.html");
  const candidateHtml = join(root, "workspace", "deck.html");
  await mkdir(join(root, "baseline"), { recursive: true });
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(baselineHtml, "<!doctype html><title>baseline deck</title>", "utf8");
  await writeFile(candidateHtml, "<!doctype html><title>candidate deck</title>", "utf8");
  const result = await augmentComparisonOpenableMedia({
    attemptRoot,
    workspaceRoot: join(root, "workspace"),
    links: [
      { side: "candidate", inspectPath: "candidate/deck.html", reportHref: "candidate/deck.html" },
    ],
    baselineSources: [{ inspectPath: "history/finals/deck.html", absolutePath: baselineHtml }],
    candidateSources: [{ inspectPath: "candidate/deck.html", absolutePath: candidateHtml }],
    captureScreenshot: async (sourcePath, destPng) => {
      captureCalls.push({ source: sourcePath, dest: destPng });
      await writeFile(destPng, MINIMAL_PNG);
      return { ok: true };
    },
  });
  assert.equal(captureCalls.length, 2);
  for (const item of result.media.filter((entry: ComparisonMediaRecord) => entry.available)) {
    assert.match(item.reportHref, /\.png$/);
    assert.match(item.inspectPath, /^media\/.+\.png$/);
    const materialized = join(attemptRoot, item.reportHref);
    const bytes = await readBytes(materialized);
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
  }
  assert.ok(result.media.some((item: ComparisonMediaRecord) => item.side === "baseline" && item.available));
  assert.ok(result.media.some((item: ComparisonMediaRecord) => item.side === "candidate" && item.available));
});

test("augmentComparisonOpenableMedia reports no_browser separately from capture_failed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-openable-fail-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const baselineHtml = join(root, "baseline.html");
  const candidateHtml = join(root, "candidate.html");
  await writeFile(baselineHtml, "<!doctype html><title>b</title>", "utf8");
  await writeFile(candidateHtml, "<!doctype html><title>c</title>", "utf8");
  const sources = {
    baselineSources: [{ inspectPath: "history/finals/baseline.html", absolutePath: baselineHtml }],
    candidateSources: [{ inspectPath: "candidate/candidate.html", absolutePath: candidateHtml }],
  };
  await assert.rejects(
    () => augmentComparisonOpenableMedia({
      attemptRoot: join(root, "attempt-no-browser"),
      workspaceRoot: root,
      links: [],
      ...sources,
      captureScreenshot: async () => ({ ok: false, failure: { kind: "no_browser" } }),
    }),
    (error: unknown) => {
      if (!(error instanceof ComparisonVisualMediaError)) return false;
      return /no headless browser/.test(error.message);
    },
  );
  await assert.rejects(
    () => augmentComparisonOpenableMedia({
      attemptRoot: join(root, "attempt-capture-failed"),
      workspaceRoot: root,
      links: [],
      ...sources,
      captureScreenshot: async () => ({
        ok: false,
        failure: { kind: "capture_failed", message: "timeout" },
      }),
    }),
    (error: unknown) => {
      if (!(error instanceof ComparisonVisualMediaError)) return false;
      return /timeout/.test(error.message) && !/no headless browser/.test(error.message);
    },
  );
});

async function readFile(path: string, encoding: BufferEncoding): Promise<string> {
  const { readFile: read } = await import("node:fs/promises");
  return read(path, encoding);
}

async function readBytes(path: string): Promise<Buffer> {
  const { readFile: read } = await import("node:fs/promises");
  return read(path);
}
