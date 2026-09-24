import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { chromium } from "playwright-core";
import { ToolCapabilityManifestSchema, ToolConfigSchema, type ToolCapability, type ToolCapabilityManifest, type ToolConfig } from "../core/tool-schema.js";
import { writeAtomic } from "../core/identity.js";
import { runProcess } from "./process-runner.js";
import { spawnRuntimeProcess } from "./process/spawn.js";

export async function loadToolConfig(dataDir: string): Promise<ToolConfig> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, "tools.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1 };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (!Value.Check(ToolConfigSchema, value)) throw new Error("Tool config does not satisfy ToolConfigSchema.");
  return value;
}

export async function saveToolConfig(dataDir: string, config: ToolConfig): Promise<void> {
  if (!Value.Check(ToolConfigSchema, config)) throw new Error("Tool config does not satisfy ToolConfigSchema.");
  await mkdir(dataDir, { recursive: true });
  await writeAtomic(join(dataDir, "tools.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function browserCandidates(config: ToolConfig): string[] {
  const paths = [config.browserPath, chromium.executablePath()];
  if (process.platform === "win32") {
    for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (!base) continue;
      paths.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      paths.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  }
  return [...new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
}

const browserChecks = new Map<string, { checkedAt: number; result: { path?: string; version?: string; reason?: string } }>();

async function findUsableBrowser(config: ToolConfig, refresh = false): Promise<{ path?: string; version?: string; reason?: string }> {
  const key = JSON.stringify(browserCandidates(config));
  const cached = browserChecks.get(key);
  if (!refresh && cached && Date.now() - cached.checkedAt < 60_000) return cached.result;
  let failure = "No compatible Chromium, Edge, or Chrome executable was found.";
  for (const path of browserCandidates(config)) {
    if (!existsSync(path)) continue;
    try {
      const browser = await chromium.launch({ executablePath: path, headless: true, timeout: 10_000 });
      try {
        const page = await browser.newPage({ viewport: { width: 320, height: 240 } });
        await page.setContent("<main>Reprise browser check</main>");
        await page.screenshot();
        const result = { path, version: browser.version() };
        browserChecks.set(key, { checkedAt: Date.now(), result });
        return result;
      } finally {
        await browser.close();
      }
    } catch (error) {
      failure = `Browser launch/screenshot failed: ${error instanceof Error ? error.name : "unknown error"}.`;
    }
  }
  const result = { reason: failure };
  browserChecks.set(key, { checkedAt: Date.now(), result });
  return result;
}

async function executableCapability(id: string, path: string | undefined, operations: string[]): Promise<ToolCapability> {
  if (!path) return { id, available: false, operations: [], verification: "unavailable", reason: "Not configured." };
  try {
    const result = await runProcess({ operation: `doctor-${id}`, executableKind: id, command: path,
      args: [id === "ffmpeg" || id === "ffprobe" ? "-version" : "--version"],
      timeoutMs: 5_000, maxOutputBytes: 4096, truncateOutput: true, allowNonzeroExit: true,
      spawnProcess: spawnRuntimeProcess });
    if (result.exitCode !== 0) return { id, available: false, operations: [], verification: "unavailable", reason: "Version probe exited unsuccessfully." };
    return { id, available: true, operations, verification: "detected", version: (result.stdout || result.stderr).split(/\r?\n/)[0]?.slice(0, 128) ?? "unknown",
      reason: id === "libreoffice"
        ? "Detected only; document conversion is unsupported without macro, external-link, profile, and output isolation."
        : "Version probe succeeded; operations require an explicit enhance command." };
  } catch {
    return { id, available: false, operations: [], verification: "unavailable", reason: "Configured executable could not be started." };
  }
}

export async function detectToolCapabilities(config: ToolConfig, now = new Date(), refreshBrowser = false): Promise<{ manifest: ToolCapabilityManifest; browserPath?: string }> {
  const browser = await findUsableBrowser(config, refreshBrowser);
  const optional = await Promise.all([
    executableCapability("libreoffice", config.enhancements?.libreOfficePath, []),
    executableCapability("ffmpeg", config.enhancements?.ffmpegPath, ["extract_frame"]),
    executableCapability("ffprobe", config.enhancements?.ffprobePath, ["inspect_media"]),
    executableCapability("tesseract", config.enhancements?.tesseractPath, ["ocr_text"]),
  ]);
  const searchReady = Boolean(config.search && isBraveSearchEndpoint(config.search.endpoint) && process.env[config.search.keyEnv]);
  const core: ToolCapability[] = [
    { id: "node", available: true, operations: ["compute", "run_scripts"], verification: "executed", version: process.version },
    { id: "files", available: true, operations: ["read", "write_work", "search"], verification: "executed" },
    { id: "managed_process", available: true, operations: ["start", "poll", "stop"], verification: "detected" },
    { id: "browser", available: Boolean(browser.path), operations: browser.path ? ["navigate", "interact", "screenshot"] : [],
      verification: browser.path ? "executed" : "unavailable", ...(browser.version ? { version: browser.version } : {}),
      ...(browser.reason ? { reason: browser.reason } : {}) },
    { id: "fetch", available: true, operations: ["fetch_https"], verification: "detected" },
    { id: "search", available: searchReady, operations: searchReady ? ["search_web"] : [],
      verification: searchReady ? "detected" : "unavailable", ...(!searchReady ? { reason: "Search provider or credential reference is not configured." } : {}) },
    { id: "content_extract", available: true, operations: ["csv", "json", "pdf_text", "office_text"], verification: "detected" },
  ];
  const manifest: ToolCapabilityManifest = { schemaVersion: 1, generatedAt: now.toISOString(), platform: process.platform, core, optional };
  if (!Value.Check(ToolCapabilityManifestSchema, manifest)) {
    throw new Error(`Tool capability manifest failed schema validation: ${[...Value.Errors(ToolCapabilityManifestSchema, manifest)].map((item) => item.path).join(", ")}`);
  }
  return { manifest, ...(browser.path ? { browserPath: browser.path } : {}) };
}

export function isBraveSearchEndpoint(raw: string): boolean {
  try {
    const endpoint = new URL(raw);
    return endpoint.origin === "https://api.search.brave.com"
      && endpoint.pathname === "/res/v1/web/search" && !endpoint.username && !endpoint.password && !endpoint.hash;
  } catch { return false; }
}
