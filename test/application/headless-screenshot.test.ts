import test from "node:test";
import assert from "node:assert/strict";
import { platform } from "node:process";
import { access, constants } from "node:fs/promises";
import { headlessBrowserCandidatePaths, resolveHeadlessBrowser } from "../../src/infrastructure/headless-screenshot.js";

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
