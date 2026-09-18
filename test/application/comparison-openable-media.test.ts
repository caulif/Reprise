import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPairedVisualMediaOrThrow,
  ComparisonVisualMediaError,
  isOpenableFinalPath,
} from "../../src/application/comparison-openable-media.js";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../../src/core/schema.js";

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
  const { augmentComparisonOpenableMedia } = await import("../../src/application/comparison-openable-media.js");
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

async function readFile(path: string, encoding: BufferEncoding): Promise<string> {
  const { readFile: read } = await import("node:fs/promises");
  return read(path, encoding);
}
