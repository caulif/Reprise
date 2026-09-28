import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ComparisonLinkRecord } from "../core/schema.js";
import { pathContainedBy } from "../core/paths.js";

export async function stagePublishedEvidence(input: {
  attemptRoot: string;
  experimentRoot: string;
  html: string;
  evidence: readonly ComparisonLinkRecord[];
}, rewriteHref: (html: string, from: string, to: string) => string): Promise<{
  html: string;
  hrefMap: ReadonlyMap<string, string>;
}> {
  let html = input.html;
  const hrefMap = new Map<string, string>();
  for (const link of input.evidence) {
    if (link.origin !== "derived_analysis" || !link.contentHash || !link.reportHref || !html.includes(link.reportHref)) continue;
    const normalized = link.reportHref.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!/^evidence\/derived\/[a-f0-9]{16}(?:\.[a-z0-9]+)?$/.test(normalized)) {
      throw new Error(`Invalid derived evidence path: ${normalized}`);
    }
    const source = resolve(input.attemptRoot, ...normalized.split("/"));
    if (!pathContainedBy(resolve(input.attemptRoot), source)) throw new Error(`Derived evidence path escapes attempt root: ${normalized}`);
    const sourceReal = await realpath(source);
    if (!pathContainedBy(await realpath(input.attemptRoot), sourceReal)) throw new Error(`Derived evidence symlink escapes attempt root: ${normalized}`);
    const bytes = await readFile(sourceReal);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== link.contentHash) throw new Error(`Derived evidence hash mismatch: ${normalized}`);
    const publishedHref = `evidence/${digest}${extname(normalized)}`;
    await mkdir(join(input.experimentRoot, "evidence"), { recursive: true });
    await copyFile(sourceReal, join(input.experimentRoot, publishedHref));
    hrefMap.set(normalized, publishedHref);
    html = rewriteHref(html, normalized, publishedHref);
  }
  return { html, hrefMap };
}

export async function stagePublishedHistoricalFinals(input: {
  attemptRoot: string;
  html: string;
  evidence: readonly ComparisonLinkRecord[];
}, rewriteHref: (html: string, from: string, to: string) => string): Promise<{
  html: string;
  hrefMap: ReadonlyMap<string, string>;
}> {
  let html = input.html;
  const hrefMap = new Map<string, string>();
  const attemptRootReal = await realpath(input.attemptRoot);
  for (const link of input.evidence) {
    const href = link.reportHref;
    if (link.origin !== "historical_artifact" || !href?.startsWith("finals/") || !html.includes(`href="${href}"`)) continue;
    const source = resolve(input.attemptRoot, ...href.split("/"));
    if (!pathContainedBy(input.attemptRoot, source) || !pathContainedBy(attemptRootReal, await realpath(source))) {
      throw new Error(`Historical final escapes attempt root: ${href}`);
    }
    const publishedHref = `comparison-attempts/${basename(input.attemptRoot)}/${href}`;
    hrefMap.set(href, publishedHref);
    html = rewriteHref(html, href, publishedHref);
  }
  return { html, hrefMap };
}

export function rewriteMediaHref(html: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html
    .replace(new RegExp(`(\\b(?:src|href)\\s*=\\s*["'])${escaped}(["'])`, "gi"), `$1${to}$2`)
    .replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "gi"), `url($1${to}$1)`);
}

export function extensionForMediaType(mediaType: string): string {
  if (/svg/i.test(mediaType)) return ".svg";
  if (/webp/i.test(mediaType)) return ".webp";
  if (/gif/i.test(mediaType)) return ".gif";
  if (/jpe?g/i.test(mediaType)) return ".jpg";
  return ".png";
}
