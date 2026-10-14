import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonMediaRecordSchema } from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { createComparisonRenderCatalogPort } from "../../src/application/comparison-render-catalog.js";
import { ARTIFACT_RENDERER_VERSION } from "../../src/infrastructure/artifact-renderer.js";
import { DEFAULT_RENDER_VIEWPORT } from "../../src/infrastructure/artifact-render-types.js";
const PNG_A = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
test("render batch registration persists signed browser scroll offsets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-render-signed-scroll-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pngPath = join(root, "frame.png");
  await writeFile(pngPath, PNG_A);
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptId: "attempt-signed-scroll", attemptRoot: root,
    links: [{ side: "baseline", inspectPath: "finals/rtl.html", shortRef: "ev-01" }],
    media: [], emitRegistered: async () => {},
  });
  const port = createComparisonRenderCatalogPort({
    catalog, attemptRoot: root,
    mounts: { finals: join(root, "finals"), candidate: join(root, "candidate"),
      history: join(root, "history"), evidence: join(root, "evidence") },
  });
  const scrollOffset = { x: -500.5, y: -120.25 };
  const result = await port.registerDerivedMediaBatch([{
    side: "baseline", pngPath, label: "RTL frame", sourceRef: "ev-01",
    contentHash: sha256(PNG_A), kind: "artifact_preview",
    derivation: { rendererVersion: ARTIFACT_RENDERER_VERSION, viewport: DEFAULT_RENDER_VIEWPORT,
      sampleTimeMs: 0, actualTimeMs: 0, capturedAt: "2026-10-14T00:00:00.000Z",
      captureScope: "viewport", scrollOffset, documentHeight: 2400 },
  }]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(catalog.snapshot().media[0]?.derivation?.scrollOffset, scrollOffset);
  const persisted: unknown = JSON.parse(await readFile(join(root, "facts", "media.json"), "utf8"));
  assert.ok(Array.isArray(persisted));
  const record: unknown = persisted[0];
  assert.ok(Value.Check(ComparisonMediaRecordSchema, record));
  assert.deepEqual(record.derivation?.scrollOffset, scrollOffset);
});

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
