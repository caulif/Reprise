import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../src/core/identity.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { createComparisonRenderCatalogPort } from "../../src/application/comparison-render-catalog.js";
import { ARTIFACT_RENDERER_VERSION } from "../../src/infrastructure/artifact-renderer.js";
import { DEFAULT_RENDER_VIEWPORT } from "../../src/infrastructure/artifact-render-types.js";
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test("registerDerivedMedia always calls catalog.registerMedia so emit-retry still fires", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-emit-retry-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "scratch"), { recursive: true });
  const pngPath = join(root, "scratch", "frame.png");
  await writeFile(pngPath, PNG_A);
  const events: unknown[] = [];
  let failNextEmit = true;
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-emit-retry",
    attemptRoot: root,
    links: [{ side: "baseline", inspectPath: "finals/x.html", shortRef: "ev-01" }],
    media: [],
    emitRegistered: async (payload) => {
      if (failNextEmit) {
        failNextEmit = false;
        throw new Error("simulated store.append failure");
      }
      events.push(payload);
    },
  });
  const renderCatalog = createComparisonRenderCatalogPort({
    catalog,
    attemptRoot: root,
    mounts: {
      finals: join(root, "finals"),
      candidate: join(root, "candidate-snap"),
      history: join(root, "history"),
      evidence: join(root, "evidence"),
    },
  });
  const entry = {
    side: "baseline" as const,
    pngPath,
    label: "frame",
    sourceRef: "ev-01",
    contentHash: sha256(PNG_A),
    kind: "artifact_preview" as const,
    derivation: {
      rendererVersion: ARTIFACT_RENDERER_VERSION,
      viewport: DEFAULT_RENDER_VIEWPORT,
      sampleTimeMs: 0,
      actualTimeMs: 0,
      capturedAt: "2026-09-20T00:00:00.000Z",
      captureScope: "viewport" as const,
      scrollOffset: { x: 0, y: 800 },
      documentHeight: 2400,
    },
  };
  const first = await renderCatalog.registerDerivedMedia(entry);
  assert.equal(first.ok, false);
  assert.equal(events.length, 0);
  assert.ok(catalog.snapshot().media.some((item) => item.contentHash === entry.contentHash));
  const persisted = catalog.snapshot().media.find((item) => item.contentHash === entry.contentHash)!;
  assert.equal(persisted.derivation?.captureScope, "viewport");
  assert.deepEqual(persisted.derivation?.scrollOffset, { x: 0, y: 800 });
  assert.equal(persisted.derivation?.documentHeight, 2400);

  const second = await renderCatalog.registerDerivedMedia({
    ...entry,
    derivation: {
      ...entry.derivation,
      capturedAt: "2026-09-20T00:00:01.000Z",
    },
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(events.length, 1);
  assert.equal((events[0] as { shortRef: string }).shortRef, second.shortRef);
});
