import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import { comparisonMediaFileName, isComparisonImagePath, materializeComparisonMedia } from "./comparison-media.js";
import { withMediaShortRefs } from "./comparison-short-refs.js";

const execFileAsync = promisify(execFile);

const OPENABLE_EXT = new Set([".html", ".htm", ".xhtml", ".svg"]);

export class ComparisonVisualMediaError extends Error {
  readonly code = "media_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "ComparisonVisualMediaError";
  }
}

export function isOpenableFinalPath(path: string): boolean {
  const ext = extname(path.replaceAll("\\", "/")).toLowerCase();
  return OPENABLE_EXT.has(ext);
}

function isVisualDeliverablePath(path: string): boolean {
  return isOpenableFinalPath(path) || isComparisonImagePath(path);
}

export async function augmentComparisonOpenableMedia(input: {
  attemptRoot: string;
  workspaceRoot: string;
  links: readonly ComparisonLinkRecord[];
  baselineSources: readonly { inspectPath: string; absolutePath: string }[];
  candidateSources: readonly { inspectPath: string; absolutePath: string }[];
}): Promise<{ links: ComparisonLinkRecord[]; media: ComparisonMediaRecord[] }> {
  const sealedRoot = join(input.attemptRoot, "history", "finals");
  await mkdir(sealedRoot, { recursive: true });
  for (const source of input.baselineSources) {
    if (!isOpenableFinalPath(source.absolutePath)) continue;
    const dest = join(sealedRoot, basename(source.absolutePath));
    await copyFile(source.absolutePath, dest);
  }
  const augmentedLinks = [...input.links];
  const screenshotLinks: ComparisonLinkRecord[] = [];
  const linkedBasenames = new Set(
    input.links
      .filter((link) => isVisualLink(link))
      .map((link) => basename(link.inspectPath.replaceAll("\\", "/"))),
  );
  for (const side of ["baseline", "candidate"] as const) {
    const sources = side === "baseline" ? input.baselineSources : input.candidateSources;
    for (const source of sources) {
      if (!shouldScreenshotOpenable(source.absolutePath)) continue;
      const name = basename(source.absolutePath);
      if (linkedBasenames.has(name)) continue;
      const info = await stat(source.absolutePath).catch(() => undefined);
      if (!info?.isFile()) continue;
      const id = `${side}-${basename(source.inspectPath).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      const pngName = comparisonMediaFileName(id, ".png");
      const pngPath = join(input.attemptRoot, "media", pngName);
      await mkdir(join(input.attemptRoot, "media"), { recursive: true });
      const captured = await captureOpenableScreenshot(source.absolutePath, pngPath);
      if (!captured) continue;
      screenshotLinks.push({
        side,
        inspectPath: side === "baseline" ? `history/finals/${basename(source.absolutePath)}` : source.inspectPath,
        reportHref: `media/${pngName}`,
        mediaType: "image/png",
        byteLength: (await stat(pngPath)).size,
        artifactId: id,
      });
    }
  }
  augmentedLinks.push(...screenshotLinks);
  const media = withMediaShortRefs(await materializeComparisonMedia({
    attemptRoot: input.attemptRoot,
    workspaceRoot: input.workspaceRoot,
    links: augmentedLinks,
  }));
  assertPairedVisualMediaOrThrow({
    baselineSources: input.baselineSources,
    candidateSources: input.candidateSources,
    links: augmentedLinks,
    media,
  });
  return { links: augmentedLinks, media };
}

export function assertPairedVisualMediaOrThrow(input: {
  baselineSources: readonly { inspectPath: string; absolutePath: string }[];
  candidateSources: readonly { inspectPath: string; absolutePath: string }[];
  links: readonly ComparisonLinkRecord[];
  media: readonly ComparisonMediaRecord[];
}): void {
  const baselineVisual = input.baselineSources.some((item) => isVisualDeliverablePath(item.absolutePath))
    || input.links.some((link) => link.side === "baseline" && isVisualLink(link));
  const candidateVisual = input.candidateSources.some((item) => isVisualDeliverablePath(item.absolutePath))
    || input.links.some((link) => link.side === "candidate" && isVisualLink(link));
  if (!baselineVisual || !candidateVisual) return;
  const baselineAvailable = input.media.some((item) => item.side === "baseline" && item.available);
  const candidateAvailable = input.media.some((item) => item.side === "candidate" && item.available);
  if (baselineAvailable && candidateAvailable) return;
  throw new ComparisonVisualMediaError(
    "Visual deliverables exist on both sides but paired previews were not registered in media.json.",
  );
}

function isVisualLink(link: ComparisonLinkRecord): boolean {
  if (link.mediaType?.startsWith("image/")) return true;
  return isVisualDeliverablePath(link.inspectPath);
}

function shouldScreenshotOpenable(path: string): boolean {
  const ext = extname(path.replaceAll("\\", "/")).toLowerCase();
  return ext === ".html" || ext === ".htm" || ext === ".xhtml";
}

export async function discoverOpenableSources(input: {
  attemptRoot: string;
  experimentRoot: string;
  workspaceRoot: string;
  runId: string;
  changedPaths: readonly string[];
  dataDir?: string;
  caseId: string;
  baselineArtifactNames: readonly string[];
}): Promise<{
  baselineSources: { inspectPath: string; absolutePath: string }[];
  candidateSources: { inspectPath: string; absolutePath: string }[];
}> {
  const baselineSources: { inspectPath: string; absolutePath: string }[] = [];
  const candidateSources: { inspectPath: string; absolutePath: string }[] = [];
  const controllerRoot = join(input.experimentRoot, "runs", input.runId, "controller-briefing");
  const roots: string[] = [];
  if (input.dataDir) roots.push(join(input.dataDir, "cases", input.caseId, "baseline-artifacts"));
  roots.push(
    join(input.experimentRoot, "environment", "baselines"),
    join(controllerRoot, "history"),
  );
  for (const name of input.baselineArtifactNames) {
    for (const root of roots) {
      const absolutePath = await findFileByBasename(root, name);
      if (!absolutePath || !isOpenableFinalPath(absolutePath)) continue;
      baselineSources.push({ inspectPath: `history/finals/${basename(absolutePath)}`, absolutePath });
      break;
    }
  }
  for (const path of input.changedPaths) {
    const absolutePath = join(input.workspaceRoot, ...path.split("/"));
    const info = await stat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || !isOpenableFinalPath(absolutePath)) continue;
    candidateSources.push({ inspectPath: `candidate/${path}`, absolutePath });
  }
  return { baselineSources, candidateSources };
}

async function findFileByBasename(root: string, basenameTarget: string): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== basenameTarget) continue;
    const parent = "parentPath" in entry && typeof entry.parentPath === "string" ? entry.parentPath : root;
    return join(parent, entry.name);
  }
  return undefined;
}

async function captureOpenableScreenshot(sourcePath: string, destPng: string): Promise<boolean> {
  const browser = await resolveHeadlessBrowser();
  if (!browser) return false;
  const ext = extname(sourcePath).toLowerCase();
  const target = ext === ".svg"
    ? await svgPreviewHtml(sourcePath)
    : sourcePath;
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
      pathToFileURL(target).href,
    ], { timeout: 20_000 });
    await access(destPng);
    return true;
  } catch {
    return false;
  } finally {
    if (target !== sourcePath) {
      await import("node:fs/promises").then(({ rm }) => rm(target, { force: true }).catch(() => undefined));
    }
  }
}

async function svgPreviewHtml(svgPath: string): Promise<string> {
  const body = await readFile(svgPath, "utf8");
  const preview = join(svgPath, "..", `.reprise-openable-${basename(svgPath)}.html`);
  await writeFile(preview, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff}svg{max-width:100%}</style>${body}`, "utf8");
  return preview;
}

async function resolveHeadlessBrowser(): Promise<string | undefined> {
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
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return undefined;
}
