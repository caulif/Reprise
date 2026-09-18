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

async function pathExists(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(() => true, () => false);
}

async function whichOnPath(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [name], { timeout: 2000 });
    const candidate = stdout.trim();
    if (candidate && await pathExists(candidate)) return candidate;
  } catch {
    // which exits non-zero when the binary is absent from PATH.
  }
  return undefined;
}

function platformBrowserCandidates(): string[] {
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      join(process.env.LOCALAPPDATA ?? "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export function headlessBrowserCandidatePaths(): readonly string[] {
  return platformBrowserCandidates();
}

function pathLookupNames(): string[] {
  if (process.platform === "darwin") {
    return ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"];
  }
  if (process.platform === "win32") return [];
  return ["google-chrome", "chromium", "chromium-browser"];
}

export async function resolveHeadlessBrowser(): Promise<string | undefined> {
  for (const candidate of platformBrowserCandidates()) {
    if (await pathExists(candidate)) return candidate;
  }
  for (const name of pathLookupNames()) {
    const found = await whichOnPath(name);
    if (found) return found;
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
