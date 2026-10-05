import test from "node:test";
import assert from "node:assert/strict";
import { createRenderArtifactTool, type ComparisonRenderedCheck, type ComparisonRenderCatalogPort } from "../../src/application/comparison-render-tools.js";
import type { ArtifactRenderer, RenderResult } from "../../src/infrastructure/artifact-render-types.js";

const viewport = { width: 640, height: 480, scale: 1 };
const frame = (sampleTimeMs: number, hash: string) => ({ sampleTimeMs, actualTimeMs: sampleTimeMs + 7, contentHash: hash, byteLength: 20, pngPath: `C:/private/render/${sampleTimeMs}.png` });
function fixture(result: RenderResult, registrationFails = false) {
  const checks: ComparisonRenderedCheck[] = [];
  let registered = 0;
  let rendered = 0;
  const catalog: ComparisonRenderCatalogPort = {
    revision: () => 1,
    resolveSource: async () => ({ sourceRef: "media-01", side: "candidate", bundleRoot: "C:/private/source", entryRelativePath: "wheel.svg", contentHash: "source-hash", origin: "candidate" }),
    registerDerivedMedia: async () => ({ ok: false, code: "unused", message: "unused" }),
    registerDerivedMediaBatch: async inputs => {
      registered++;
      return registrationFails ? { ok: false, code: "io_failed", message: "Cannot register media" }
        : { ok: true, items: inputs.map((_input, i) => ({ ok: true as const, shortRef: `media-0${i + 2}`, mediaRef: `media:frame-${i}`, revision: 1 })) };
    },
  };
  const render: ArtifactRenderer = async () => { rendered++; return result; };
  const tool = createRenderArtifactTool({ catalog, attemptRoot: "C:/private/attempt", render, onRenderedCheck: check => { checks.push(check); } });
  const run = async (signal = new AbortController().signal) => JSON.parse((await tool.execute({ sourceRef: "media-01", sampleTimesMs: [0, 500], viewport }, signal)).content) as { status: string; renderedCheck: ComparisonRenderedCheck };
  return { checks, run, registered: () => registered, rendered: () => rendered };
}
const success = (same = false): RenderResult => ({ ok: true, frames: [frame(0, "hash-a"), frame(500, same ? "hash-a" : "hash-b")], diagnostics: [], measured: { loadMs: 1, viewport, origin: "private origin" } });

test("actual successful render check is returned and recorded without granting image sight or exposing paths", async () => {
  const f = fixture(success());
  const result = await f.run();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.renderedCheck, f.checks[0]);
  assert.deepEqual(result.renderedCheck, { sourceRef: "media-01", side: "candidate", sourceHash: "source-hash", status: "ok", requestedSampleTimesMs: [0, 500], frames: [{ sampleTimeMs: 0, actualTimeMs: 7, contentHash: "hash-a" }, { sampleTimeMs: 500, actualTimeMs: 507, contentHash: "hash-b" }], viewport });
  assert.doesNotMatch(JSON.stringify(result.renderedCheck), /private|pngPath|seen|delivered/);
  assert.equal(f.registered(), 1);
});

test("identical PNG samples preserve actual timing while motion stays unproven and media is not registered", async () => {
  const f = fixture(success(true));
  const result = await f.run();
  assert.equal(result.status, "motion_not_proven");
  assert.equal(f.checks[0]?.status, "motion_not_proven");
  assert.deepEqual(result.renderedCheck.frames.map(f => f.actualTimeMs), [7, 507]);
  assert.equal(result.renderedCheck.frames.length, 2);
  assert.equal(f.registered(), 0);
});

test("registration failure does not erase the successful renderer frames", async () => {
  const f = fixture(success(), true);
  const result = await f.run();
  assert.equal(result.status, "capture_failed");
  assert.equal(f.checks[0]?.status, "capture_failed");
  assert.equal(result.renderedCheck.frames.length, 2);
  assert.deepEqual(result.renderedCheck, f.checks[0]);
});

test("failure, empty and cancellation never fabricate a successful completed check", async () => {
  for (const kind of ["timeout", "cancelled"] as const) {
    const f = fixture({ ok: false, failure: kind === "timeout" ? { kind, message: "timed out" } : { kind }, diagnostics: [] });
    const result = await f.run();
    assert.equal(result.status, kind);
    assert.equal(f.checks[0]?.status, kind);
    assert.deepEqual(result.renderedCheck.frames, []);
    assert.equal(f.registered(), 0);
  }
  const empty = fixture({ ok: true, frames: [], diagnostics: [], measured: { loadMs: 1, viewport, origin: "fake" } });
  assert.equal((await empty.run()).status, "capture_failed");
  assert.deepEqual(empty.checks[0]?.frames, []);
  assert.equal(empty.registered(), 0);
  const cancelled = fixture(success());
  const controller = new AbortController();
  controller.abort();
  assert.equal((await cancelled.run(controller.signal)).status, "cancelled");
  assert.equal(cancelled.rendered(), 0);
  assert.deepEqual(cancelled.checks, []);
});
