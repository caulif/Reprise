import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskCase } from "../../src/core/schema.js";
import {
  buildSealedBaselineImageLinks,
  collectHistoricalDeliverableNames,
  enrichHistoricalImageNamesFromRoots,
  findFileInHistoricalRoots,
  indexHistoricalRoots,
  lookupBasename,
  lookupBasenameFromIndex,
  historicalFinalSearchRoots,
  resolveHistoricalFinalPath,
  sealBaselineOpenablePath,
} from "../../src/application/historical-final-discovery.js";
import { isImageDeliverableName } from "../../src/application/openable-final-path.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const taskCase = (): TaskCase => ({
  schemaVersion: 1,
  caseId: "case-1",
  source: { productId: "codex", sessionId: "session-1" },
  initialInput: { id: "m1", role: "user", text: "做 deck.html" },
  transcript: [{ id: "m2", role: "assistant", text: "导出 slide.png" }],
  historicalEvents: [],
  baseline: {
    status: "available",
    artifactRefs: [{ artifactId: "artifact-final.html", caseId: "case-1" }, { artifactId: "deck.html", caseId: "case-1" }],
    finalMessage: "见 preview.svg",
    evidenceRefs: [],
  },
  sourceRuntimeEvidence: { productId: "codex", artifactRefs: [{ artifactId: "runtime-shot.png", caseId: "case-1" }] },
  provenance: { packVersion: "test", importedAt: "2026-09-18T00:00:00.000Z", sourceHash: "a".repeat(64) },
  privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  contentHash: "b".repeat(64),
});

test("collectHistoricalDeliverableNames shares baseline artifact refs across kinds", () => {
  const value = taskCase();
  const finalNames = collectHistoricalDeliverableNames(value, "final");
  const openableNames = collectHistoricalDeliverableNames(value, "openable-baseline");
  const imageNames = collectHistoricalDeliverableNames(value, "image");
  assert.ok(finalNames.has("artifact-final.html"));
  assert.ok(finalNames.has("deck.html"));
  assert.ok(openableNames.has("artifact-final.html"));
  assert.ok(openableNames.has("deck.html"));
  assert.ok(!imageNames.has("artifact-final.html"));
  assert.ok(!imageNames.has("deck.html"));
  assert.ok(openableNames.has("runtime-shot.png"));
  assert.ok(imageNames.has("runtime-shot.png"));
  assert.ok(!finalNames.has("runtime-shot.png"));
  assert.ok(finalNames.has("preview.svg"));
  assert.ok(imageNames.has("slide.png"));
});

test("lookupBasename uses direct-basename mode for attempt finals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-lookup-mode-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(join(attemptRoot, "finals"), { recursive: true });
  const sealed = join(attemptRoot, "finals", "deck.html");
  await writeFile(sealed, "<!doctype html><title>sealed</title>", "utf8");
  const roots = historicalFinalSearchRoots({
    experimentRoot,
    runId: "run-1",
    caseId: "case-1",
    attemptRoot,
  });
  assert.equal(roots.some((entry) => entry.root === join(attemptRoot, "finals") && entry.mode === "direct-basename"), true);
  assert.equal(await lookupBasename(roots, "deck.html"), sealed);
});

test("resolveHistoricalFinalPath and findFileInHistoricalRoots agree on discovered paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-lookup-agree-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const dataDir = join(root, "data");
  const artifactDir = join(dataDir, "cases", "case-1", "baseline-artifacts");
  await mkdir(artifactDir, { recursive: true });
  const artifactHtml = join(artifactDir, "deck.html");
  await writeFile(artifactHtml, "<!doctype html><title>deck</title>", "utf8");
  const value = taskCase();
  const search = {
    experimentRoot,
    runId: "run-1",
    caseId: value.caseId,
    dataDir,
  };
  const resolved = await resolveHistoricalFinalPath({ ...search, taskCase: value });
  const found = await findFileInHistoricalRoots({ ...search, basename: "deck.html" });
  assert.equal(resolved, artifactHtml);
  assert.equal(found, artifactHtml);
});

test("sealBaselineOpenablePath rejects conflicting basenames", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-seal-conflict-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const sealedRoot = join(root, "history", "finals");
  await mkdir(sealedRoot, { recursive: true });
  const first = join(root, "first", "deck.html");
  const second = join(root, "second", "deck.html");
  await mkdir(join(root, "first"), { recursive: true });
  await mkdir(join(root, "second"), { recursive: true });
  await writeFile(first, "<!doctype html><title>first</title>", "utf8");
  await writeFile(second, "<!doctype html><title>second</title>", "utf8");
  await sealBaselineOpenablePath(sealedRoot, first);
  await assert.rejects(
    () => sealBaselineOpenablePath(sealedRoot, second),
    /Duplicate baseline final basename "deck.html"/,
  );
});

test("sealBaselineOpenablePath accepts identical reseal content regardless of mtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-seal-reseal-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const sealedRoot = join(root, "history", "finals");
  const source = join(root, "source", "deck.html");
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(source, "<!doctype html><title>deck</title>", "utf8");
  await sealBaselineOpenablePath(sealedRoot, source);
  await utimes(join(sealedRoot, "deck.html"), new Date(0), new Date(0));
  await assert.doesNotReject(() => sealBaselineOpenablePath(sealedRoot, source));
});

test("findFileInHistoricalRoots prefers attempt history finals over baselines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-find-historical-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const baselineDir = join(experimentRoot, "environment", "baselines");
  await mkdir(join(attemptRoot, "history", "finals"), { recursive: true });
  await mkdir(baselineDir, { recursive: true });
  const sealedImage = join(attemptRoot, "history", "finals", "slide.png");
  const baselineImage = join(baselineDir, "slide.png");
  await writeFile(sealedImage, MINIMAL_PNG);
  await writeFile(baselineImage, Buffer.from("not-the-sealed-image"));
  const found = await findFileInHistoricalRoots({
    experimentRoot,
    runId: "run-1",
    caseId: "case-1",
    attemptRoot,
    basename: "slide.png",
  });
  assert.equal(found, sealedImage);
});

test("buildSealedBaselineImageLinks skips missing HTML artifact stubs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-sealed-image-stub-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(attemptRoot, { recursive: true });
  const htmlOnlyCase: TaskCase = {
    ...taskCase(),
    baseline: {
      status: "available",
      artifactRefs: [{ artifactId: "deck.html", caseId: "case-1" }],
      evidenceRefs: [],
    },
    initialInput: { id: "m1", role: "user", text: "task only" },
    transcript: [],
  };
  const links = await buildSealedBaselineImageLinks({
    attemptRoot,
    experimentRoot,
    taskCase: htmlOnlyCase,
    runId: "run-1",
  });
  assert.equal(links.length, 0);
});

test("enrichHistoricalImageNamesFromRoots scans baseline-artifacts before baselines", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-enrich-artifacts-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const dataDir = join(root, "data");
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const artifactDir = join(dataDir, "cases", "case-1", "baseline-artifacts");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(attemptRoot, { recursive: true });
  await writeFile(join(artifactDir, "screenshot-1"), MINIMAL_PNG);
  const names = new Set<string>();
  await enrichHistoricalImageNamesFromRoots({
    experimentRoot,
    runId: "run-1",
    caseId: "case-1",
    dataDir,
    attemptRoot,
    names,
  });
  assert.ok(names.has("screenshot-1"));
  const links = await buildSealedBaselineImageLinks({
    attemptRoot,
    experimentRoot,
    dataDir,
    taskCase: {
      ...taskCase(),
      baseline: {
        status: "available",
        artifactRefs: [{ artifactId: "screenshot-1", caseId: "case-1" }],
        evidenceRefs: [],
      },
    },
    runId: "run-1",
  });
  assert.equal(links.length, 1);
  assert.equal(links[0]?.inspectPath, "history/media/screenshot-1");
  assert.equal(links[0]?.mediaType, "image/png");
});

test("isImageDeliverableName rejects non-image artifact ids", () => {
  assert.equal(isImageDeliverableName("report.pdf"), false);
  assert.equal(isImageDeliverableName("notes.txt"), false);
  assert.equal(isImageDeliverableName("artifact-final.html"), false);
  assert.equal(isImageDeliverableName("runtime-shot.png"), true);
});

test("collectHistoricalDeliverableNames image kind skips opaque artifact ids", () => {
  const value: TaskCase = {
    ...taskCase(),
    baseline: {
      status: "available",
      artifactRefs: [
        { artifactId: "opaque-id-123", caseId: "case-1" },
        { artifactId: "report.pdf", caseId: "case-1" },
        { artifactId: "runtime-shot.png", caseId: "case-1" },
      ],
      evidenceRefs: [],
    },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    initialInput: { id: "m1", role: "user", text: "task only" },
    transcript: [],
  };
  const imageNames = collectHistoricalDeliverableNames(value, "image");
  assert.ok(!imageNames.has("opaque-id-123"));
  assert.ok(!imageNames.has("report.pdf"));
  assert.ok(imageNames.has("runtime-shot.png"));
});

test("indexHistoricalRoots shares one scan for enrich and lookup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-index-shared-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const experimentRoot = join(root, "experiment");
  const dataDir = join(root, "data");
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  const artifactDir = join(dataDir, "cases", "case-1", "baseline-artifacts");
  await mkdir(artifactDir, { recursive: true });
  await mkdir(attemptRoot, { recursive: true });
  await writeFile(join(artifactDir, "screenshot-1"), MINIMAL_PNG);
  await writeFile(join(artifactDir, "runtime-shot.png"), MINIMAL_PNG);
  const roots = historicalFinalSearchRoots({
    experimentRoot,
    runId: "run-1",
    caseId: "case-1",
    dataDir,
    attemptRoot,
  });
  const names = new Set<string>();
  const index = await indexHistoricalRoots(roots, { enrichImageNames: names });
  assert.ok(names.has("screenshot-1"));
  assert.ok(names.has("runtime-shot.png"));
  assert.equal(lookupBasenameFromIndex(index, "screenshot-1"), join(artifactDir, "screenshot-1"));
  assert.equal(lookupBasenameFromIndex(index, "runtime-shot.png"), join(artifactDir, "runtime-shot.png"));
});
