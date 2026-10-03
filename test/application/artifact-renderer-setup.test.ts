import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDocumentSession } from "../../src/infrastructure/artifact-renderer.js";
import { startBundleStaticServer } from "../../src/infrastructure/artifact-bundle-server.js";
import type { CdpSession } from "../../src/infrastructure/artifact-cdp.js";
import { DEFAULT_RENDER_VIEWPORT } from "../../src/infrastructure/artifact-render-types.js";

for (const failedMethod of ["Target.createTarget", "Fetch.enable"]) {
  test(`setup failure at ${failedMethod} closes the browser and bundle server before retry`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "reprise-render-setup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "preview.html"), "<!doctype html><title>Preview</title>");
    const origins: string[] = [];
    let closes = 0;
    const browser: CdpSession = {
      diagnostics: [],
      async send<T>(method: string): Promise<T> {
        if (method === failedMethod) throw new Error("CDP session timed out");
        return { targetId: "primary", sessionId: "page" } as T;
      },
      on: () => () => {},
      async close() { closes++; },
    };
    const request = {
      bundleRoot: root, entryRelativePath: "preview.html", viewport: DEFAULT_RENDER_VIEWPORT,
      sampleTimesMs: [0], outputRoot: join(root, "out"), signal: new AbortController().signal,
    };
    const startServer: typeof startBundleStaticServer = async (bundleRoot) => {
      const server = await startBundleStaticServer(bundleRoot);
      origins.push(server.origin);
      let closing: Promise<void> | undefined;
      const close = () => closing ??= server.close();
      t.after(close);
      return { ...server, close };
    };
    await assert.rejects(openDocumentSession(request, request.signal, [], { openBrowser: async () => browser, startServer }), /CDP session timed out/);
    assert.equal(closes, 1);
    assert.equal(origins.length, 1);
    await assert.rejects(fetch(`${origins[0]}/preview.html`));
    const retryBrowser: CdpSession = {
      ...browser,
      async send<T>(): Promise<T> { return { targetId: "primary", sessionId: "page" } as T; },
    };
    const retried = await openDocumentSession(request, request.signal, [], { openBrowser: async () => retryBrowser, startServer });
    assert.equal(retried.ok, true);
    if (retried.ok) {
      assert.equal(await (await fetch(`${retried.server.origin}/preview.html`)).text(), "<!doctype html><title>Preview</title>");
      await retried.cdp.close();
      await retried.server.close();
    }
  });
}
