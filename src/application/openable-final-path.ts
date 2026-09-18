import { extname } from "node:path";

const OPENABLE_HTML_EXT = new Set([".html", ".htm", ".xhtml"]);
const OPENABLE_EXT = new Set([...OPENABLE_HTML_EXT, ".svg"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const IMAGE_EXT_PATTERN = "png|jpe?g|gif|webp|svg|avif";
const DELIVERABLE_EXT_PATTERN = "html|htm|xhtml|png|jpe?g|gif|webp|svg|avif";

export const historicalDeliverableBasenameRe = new RegExp(
  `([^\\\\/:"<>|\\s*]+\\.(?:${DELIVERABLE_EXT_PATTERN}))`,
  "gi",
);

export const historicalImageBasenameRe = new RegExp(
  `([^\\\\/:"<>|\\s*]+\\.(?:${IMAGE_EXT_PATTERN}))`,
  "gi",
);

function normalizedExt(path: string): string {
  return extname(path.replaceAll("\\", "/")).toLowerCase();
}

export function isOpenableFinalPath(path: string): boolean {
  return OPENABLE_EXT.has(normalizedExt(path));
}

export function isScreenshotOpenablePath(path: string): boolean {
  return OPENABLE_HTML_EXT.has(normalizedExt(path));
}

export function isHistoricalImagePath(path: string): boolean {
  return IMAGE_EXT.has(normalizedExt(path));
}

export function isHistoricalVisualPath(path: string): boolean {
  return isOpenableFinalPath(path) || isHistoricalImagePath(path);
}

export function finalDeliverableRank(path: string): number {
  const lower = path.toLowerCase();
  if (/\.(html|htm|xhtml)$/.test(lower)) return 0;
  if (/\.(png|jpe?g|gif|webp|svg|avif)$/.test(lower)) return 1;
  return 2;
}

export function isImageDeliverableName(name: string): boolean {
  return isHistoricalImagePath(name);
}

export function addHistoricalDeliverableBasenames(text: string, names: Set<string>): void {
  for (const match of text.matchAll(historicalDeliverableBasenameRe)) {
    const base = match[1]?.split(/[/\\]/).pop();
    if (base && !base.startsWith(".")) names.add(base);
  }
}

export function addHistoricalImageBasenames(text: string, names: Set<string>): void {
  for (const match of text.matchAll(historicalImageBasenameRe)) {
    const base = (match[1] ?? "").split(/[/\\]/).pop();
    if (base && !base.startsWith(".")) names.add(base);
  }
}
