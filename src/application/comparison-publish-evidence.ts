import { evidenceQuoteMarkupOnly, transformOutsideEvidenceQuotes } from '../core/comparison-html.js';
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "parse5";
import type { ComparisonLinkRecord } from "../core/schema.js";
import { pathContainedBy } from "../core/paths.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { unsafeDerivedMarkup } from "./comparison-derived-content.js";
import { historicalFinalDependencies } from "./comparison-final-bundle-dependencies.js";

export async function loadDerivedEvidence(attemptRoot: string, link: ComparisonLinkRecord): Promise<{
  href: string; hash: string; bytes: Buffer;
}> {
  if (!link.contentHash || !link.reportHref) throw new Error("Derived evidence is missing its identity.");
  const href = link.reportHref.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!/^evidence\/derived\/[a-f0-9]{16}(?:\.[a-z0-9]+)?$/.test(href)) {
    throw new Error(`Invalid derived evidence path: ${href}`);
  }
  const source = resolve(attemptRoot, ...href.split("/"));
  if (!pathContainedBy(resolve(attemptRoot), source)) throw new Error(`Derived evidence path escapes attempt root: ${href}`);
  const sourceReal = await realpath(source);
  if (!pathContainedBy(await realpath(attemptRoot), sourceReal)) throw new Error(`Derived evidence symlink escapes attempt root: ${href}`);
  const bytes = await readFile(sourceReal);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== link.contentHash) throw new Error(`Derived evidence hash mismatch: ${href}`);
  const mediaType = /\.html?$/i.test(href) ? "text/html" : /\.svg$/i.test(href) ? "image/svg+xml" : "";
  const unsafeMarkup = unsafeDerivedMarkup(mediaType, bytes);
  if (unsafeMarkup) throw new Error(`Unsafe derived evidence: ${unsafeMarkup}`);
  return { href, hash, bytes };
}

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
    if (link.origin !== "derived_analysis" || !link.contentHash || !link.reportHref || !evidenceQuoteMarkupOnly(html).includes(link.reportHref)) continue;
    const { href, hash, bytes } = await loadDerivedEvidence(input.attemptRoot, link);
    const publishedHref = `evidence/${hash}${extname(href)}`;
    await mkdir(join(input.experimentRoot, "evidence"), { recursive: true });
    await writeAtomic(join(input.experimentRoot, publishedHref), bytes);
    hrefMap.set(href, publishedHref);
    html = rewriteHref(html, href, publishedHref);
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
  const linkedHrefs = comparisonAnchorHrefs(html);
  const linked = input.evidence.filter((link) =>
    link.origin === "historical_artifact" && link.reportHref?.startsWith("finals/") && linkedHrefs.has(link.reportHref));
  if (linked.length === 0) return { html, hrefMap };
  const dependencies = await historicalFinalDependencies(input.attemptRoot, linked);
  const digest = sha256(JSON.stringify(dependencies.map(({ href, hash }) => ({ href, hash }))));
  const outputRoot = join(input.attemptRoot, "published-finals", digest);
  await mkdir(outputRoot, { recursive: true });
  const outputReal = await realpath(outputRoot);
  if (!pathContainedBy(attemptRootReal, outputReal)) throw new Error("Published historical finals escape attempt root.");
  for (const { href, bytes } of dependencies) {
    const target = resolve(outputRoot, ...href.split("/"));
    if (!pathContainedBy(outputRoot, target)) throw new Error(`Published historical final escapes output root: ${href}`);
    await mkdir(dirname(target), { recursive: true });
    if (!pathContainedBy(outputReal, await realpath(dirname(target)))) {
      throw new Error(`Published historical final symlink escapes output root: ${href}`);
    }
    await writeAtomic(target, bytes);
  }
  for (const link of linked) {
    const href = link.reportHref;
    if (!href) continue;
    const source = resolve(input.attemptRoot, ...link.inspectPath.split("/"));
    if (!pathContainedBy(input.attemptRoot, source) || !pathContainedBy(attemptRootReal, await realpath(source))) {
      throw new Error(`Historical final escapes attempt root: ${href}`);
    }
    const publishedHref = `comparison-attempts/${basename(input.attemptRoot)}/published-finals/${digest}/${href}`;
    hrefMap.set(href, publishedHref);
    html = rewriteHref(html, href, publishedHref);
  }
  return { html, hrefMap };
}

type HtmlNode = {
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: { attrs?: Record<string, { startOffset: number; endOffset: number }> };
};

export function comparisonAnchorHrefs(html: string): ReadonlySet<string> {
  const hrefs = new Set<string>();
  visitHtml(html, (node) => {
    for (const attr of node.attrs ?? []) if (attr.name === "href") hrefs.add(attr.value);
  }, "a");
  return hrefs;
}

export function rewriteMediaHref(html: string, from: string, to: string): string {
  return transformOutsideEvidenceQuotes(html, text => rewriteMarkupMediaHref(text, from, to));
}

function rewriteMarkupMediaHref(html: string, from: string, to: string): string {
  const edits: { start: number; end: number; replacement: string }[] = [];
  visitHtml(html, (node) => {
    for (const attr of node.attrs ?? []) {
      if ((attr.name !== "src" && attr.name !== "href") || attr.value !== from) continue;
      const location = node.sourceCodeLocation?.attrs?.[attr.name];
      if (location) edits.push({ start: location.startOffset, end: location.endOffset,
        replacement: `${attr.name}="${escapeAttribute(to)}"` });
    }
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    html = `${html.slice(0, edit.start)}${edit.replacement}${html.slice(edit.end)}`;
  }
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html.replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "gi"), `url($1${to}$1)`);
}

function visitHtml(html: string, visit: (node: HtmlNode) => void, tagName?: string): void {
  const walk = (node: HtmlNode): void => {
    if (!tagName || (node as HtmlNode & { tagName?: string }).tagName === tagName) visit(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(parse(html, { sourceCodeLocationInfo: true }) as HtmlNode);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function extensionForMediaType(mediaType: string): string {
  if (/svg/i.test(mediaType)) return ".svg";
  if (/webp/i.test(mediaType)) return ".webp";
  if (/gif/i.test(mediaType)) return ".gif";
  if (/jpe?g/i.test(mediaType)) return ".jpg";
  return ".png";
}
