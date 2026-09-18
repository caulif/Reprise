import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HeadlessScreenshotFailure =
  | { kind: "no_browser" }
  | { kind: "capture_failed"; message: string };

export type HeadlessScreenshotResult =
  | { ok: true }
  | { ok: false; failure: HeadlessScreenshotFailure };

export async function resolveHeadlessBrowser(): Promise<string | undefined> {
  const candidates = process.platform === "win32"
    ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
    : [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
  for (const candidate of candidates) {
    if (await access(candidate, constants.F_OK).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

export async function captureHeadlessScreenshot(sourcePath: string, destPng: string): Promise<HeadlessScreenshotResult> {
  const browser = await resolveHeadlessBrowser();
  if (!browser) return { ok: false, failure: { kind: "no_browser" } };
  try {
    const width = 1280;
    const height = 900;
    await execFileAsync(browser, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      `--screenshot=${destPng}`,
      pathToFileURL(sourcePath).href,
    ], { timeout: 20_000 });
    await access(destPng, constants.F_OK);
    const info = await stat(destPng);
    if (!info.isFile() || info.size <= 0) {
      return { ok: false, failure: { kind: "capture_failed", message: "screenshot file missing or empty" } };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: { kind: "capture_failed", message } };
  }
}
