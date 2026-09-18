import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sealBaselineOpenablePath } from "../../src/application/historical-final-discovery.js";

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
