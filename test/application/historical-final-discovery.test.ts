import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findFileInHistoricalRoots,
  sealBaselineOpenablePath,
} from "../../src/application/historical-final-discovery.js";

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

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
