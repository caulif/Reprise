import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createComparisonBrowserTools } from "../../src/application/comparison-browser-tools.js";
import type { ComparisonRenderCatalogPort, RegisterDerivedMediaInput } from "../../src/application/comparison-render-tools.js";
import { ComparisonMediaDerivationSchema } from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";
import type { ManagedBrowser } from "../../src/infrastructure/managed-browser.js";

test("browser screenshot records long elapsed time as provenance, not render sample time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-browser-provenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from("screenshot bytes");
  let registered: RegisterDerivedMediaInput | undefined;
  const catalog = {
    async registerDerivedMedia(input: RegisterDerivedMediaInput) {
      registered = input;
      return { ok: true as const, shortRef: "media-01", mediaRef: "media:browser", revision: 1 };
    },
  } as ComparisonRenderCatalogPort;
  const browser = {
    async screenshot() {
      return { bytes, side: "candidate", sourceRef: "ev-01", sourceHash: "a".repeat(64),
        finalUrl: "http://127.0.0.1/source.html", urlStateOmitted: true as const,
        errors: ["blocked_resource"], errorsOmitted: 3,
        viewport: { width: 800, height: 600 }, capturedAt: "2026-09-24T00:00:00.000Z",
        elapsedMs: 65_000, actions: [{ action: "click" as const, selector: "#submit", elapsedMs: 64_000 }] };
    },
  } as unknown as ManagedBrowser;
  const tool = createComparisonBrowserTools({ browser, catalog, attemptRoot: root, allowBinary: false })
    .find((item) => item.name === "browser_screenshot");
  assert.ok(tool);
  const result = await tool.execute({ pageId: "page-01" }, new AbortController().signal);
  assert.equal((result.details as { status: string }).status, "ok");
  assert.equal(registered?.derivation.sampleTimeMs, 0);
  assert.equal(registered?.derivation.actualTimeMs, 65_000);
  assert.equal(registered?.derivation.urlStateOmitted, true);
  assert.equal(registered?.derivation.errorsOmitted, 3);
  assert.equal(registered?.contentHash, sha256(bytes));
  assert.equal(Value.Check(ComparisonMediaDerivationSchema, {
    kind: "render_preview", rendererVersion: registered?.derivation.rendererVersion,
    viewport: registered?.derivation.viewport, sampleTimesMs: [registered?.derivation.sampleTimeMs],
    capturedAt: registered?.derivation.capturedAt, elapsedMs: registered?.derivation.actualTimeMs,
    sourceHash: registered?.derivation.sourceHash, finalUrl: registered?.derivation.finalUrl,
    urlStateOmitted: registered?.derivation.urlStateOmitted, errorsOmitted: registered?.derivation.errorsOmitted,
    actions: registered?.derivation.actions,
  }), true);
});
