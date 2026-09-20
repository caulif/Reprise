import test from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureHeadlessScreenshot, headlessBrowserCandidatePaths, resolveHeadlessBrowser } from "../../src/infrastructure/headless-screenshot.js";

test("headless browser candidates include macOS application bundles", () => {
  const saved = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const candidates = headlessBrowserCandidatePaths();
    assert.ok(candidates.some((path) => path.includes("Google Chrome.app")));
    assert.ok(candidates.some((path) => path.includes("Microsoft Edge.app")));
  } finally {
    Object.defineProperty(process, "platform", { value: saved });
  }
});

test("resolveHeadlessBrowser resolves an installed browser on this runner", async () => {
  if (platform === "darwin") {
    const browser = await resolveHeadlessBrowser();
    assert.ok(browser);
    await access(browser, constants.F_OK);
    assert.match(browser, /Google Chrome|Microsoft Edge|Chromium/);
    return;
  }
  assert.ok(await resolveHeadlessBrowser());
});

test("captureHeadlessScreenshot retries a failed capture once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-headless-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "preview.png");
  let calls = 0;
  const result = await captureHeadlessScreenshot("source.html", output, {
    captureOnce: async (_source, dest) => {
      calls += 1;
      if (calls === 1) return { ok: false, failure: { kind: "capture_failed", message: "browser exited" } };
      await writeFile(dest, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("captureHeadlessScreenshot forwards options.signal and does not retry after abort", async () => {
  const controller = new AbortController();
  let calls = 0;
  let seenSignal: AbortSignal | undefined;
  await assert.rejects(
    () => captureHeadlessScreenshot("source.html", join(tmpdir(), "reprise-headless-abort.png"), {
      signal: controller.signal,
      captureOnce: async (_source, _dest, signal) => {
        calls += 1;
        seenSignal = signal;
        controller.abort();
        signal?.throwIfAborted();
        return { ok: false, failure: { kind: "capture_failed", message: "should not retry" } };
      },
    }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(calls, 1);
  assert.equal(seenSignal, controller.signal);
});
