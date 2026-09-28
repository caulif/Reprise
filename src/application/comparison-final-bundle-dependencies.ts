import { readFile, realpath } from "node:fs/promises";
import { extname, join, posix, resolve } from "node:path";
import { parse as parseModule } from "acorn";
import { parse as parseHtml } from "parse5";
import { sha256 } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import type { ComparisonLinkRecord } from "../core/schema.js";

export type Dependency = { href: string; hash: string; bytes: Buffer };
type Reference = { target: string; replacement?: string };
type HtmlNode = {
  tagName?: string;
  attrs?: { name: string; value: string; prefix?: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  value?: string;
  sourceCodeLocation?: { startOffset: number; endOffset: number; attrs?: Record<string, { startOffset: number; endOffset: number }> };
};
type Edit = { start: number; end: number; text: string };
type HtmlBase = { node: HtmlNode; url: URL; directory: string; rootMapped: boolean; replacement?: string };

export async function historicalFinalDependencies(attemptRoot: string, links: readonly ComparisonLinkRecord[]): Promise<Dependency[]> {
  const finalsRoot = join(attemptRoot, "finals");
  const attemptReal = await realpath(attemptRoot);
  const rootReal = await realpath(finalsRoot);
  if (!pathContainedBy(attemptReal, rootReal)) throw new Error("Comparison preview finals escape attempt root.");
  const seen = new Set<string>();
  const pending: string[] = [];
  for (const link of links) {
    if (!link.inspectPath.startsWith("finals/")) throw new Error(`Invalid historical final path: ${link.inspectPath}`);
    const path = link.inspectPath.slice("finals/".length);
    if (!seen.has(path)) { seen.add(path); pending.push(path); }
  }
  const dependencies: Dependency[] = [];
  while (pending.length) {
    const path = pending.shift()!;
    const href = `finals/${path}`;
    const source = resolve(finalsRoot, ...path.split("/"));
    if (!pathContainedBy(finalsRoot, source)) throw new Error(`Comparison preview final escapes finals root: ${href}`);
    const sourceReal = await realpath(source);
    if (!pathContainedBy(rootReal, sourceReal) || !pathContainedBy(attemptReal, sourceReal)) {
      throw new Error(`Comparison preview final escapes attempt root: ${href}`);
    }
    const sourceBytes = await readFile(sourceReal);
    const extension = extname(path).toLowerCase();
    const transformed = extension === ".html" || extension === ".htm" || extension === ".xhtml" || extension === ".svg"
      ? transformHtml(sourceBytes.toString("utf8"), path)
      : extension === ".css" ? transformCss(sourceBytes.toString("utf8"), path)
      : extension === ".js" || extension === ".mjs" ? transformModule(sourceBytes.toString("utf8"), path)
      : { text: undefined, targets: [] };
    const bytes = transformed.text === undefined ? sourceBytes : Buffer.from(transformed.text);
    dependencies.push({ href, hash: sha256(bytes), bytes });
    for (const target of transformed.targets) {
      if (!seen.has(target)) { seen.add(target); pending.push(target); }
    }
  }
  return dependencies.sort((a, b) => a.href.localeCompare(b.href));
}

function documentUrl(from: string): URL {
  return new URL(`http://preview.invalid/finals/${from.split("/").map(encodeURIComponent).join("/")}`);
}

function relativeHref(directory: string, target: string, isDirectory = false): string {
  const relative = posix.relative(directory, target) || ".";
  const browserRelative = relative.startsWith(".") ? relative : `./${relative}`;
  return `${browserRelative.split("/").map(encodeURIComponent).join("/")}${isDirectory ? "/" : ""}`;
}

function resolveReference(from: string, value: string, base?: HtmlBase): Reference | undefined {
  if (!value || value.startsWith("#") || value.startsWith("//")) return undefined;
  let url: URL;
  try { url = new URL(value, base?.url ?? documentUrl(from)); }
  catch { return undefined; }
  if (url.origin !== "http://preview.invalid") return undefined;
  let pathname: string;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { throw new Error(`Invalid historical final resource URL: ${value}`); }
  const rootRelative = value.startsWith("/");
  if (!rootRelative && !base?.rootMapped && !pathname.startsWith("/finals/")) {
    throw new Error(`Historical final resource escapes finals root: ${value}`);
  }
  const target = rootRelative || base?.rootMapped ? pathname.slice(1) : pathname.slice("/finals/".length);
  if (!target || target.endsWith("/")) return undefined;
  const replacement = rootRelative
    ? `${relativeHref(base?.directory ?? posix.dirname(from), target)}${url.search}${url.hash}` : undefined;
  return { target, ...(replacement ? { replacement } : {}) };
}

function applyEdits(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`;
  }
  return source;
}

function transformHtml(html: string, from: string): { text: string; targets: string[] } {
  const targets: string[] = [];
  const edits: Edit[] = [];
  const root = parseHtml(html, { sourceCodeLocationInfo: true }) as HtmlNode;
  let base: HtmlBase | undefined;
  const findBase = (node: HtmlNode): void => {
    if (base || node.tagName === "template") return;
    const href = node.tagName === "base" ? node.attrs?.find((attr) => attr.name === "href")?.value : undefined;
    if (href !== undefined) {
      const url = new URL(href, documentUrl(from));
      if (url.origin !== "http://preview.invalid") {
        base = { node, url, directory: "", rootMapped: false };
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      const rootMapped = href.startsWith("/") || !pathname.startsWith("/finals/");
      const target = rootMapped ? pathname.slice(1) : pathname.slice("/finals/".length);
      const isDirectory = pathname.endsWith("/");
      base = { node, url, directory: isDirectory ? target : posix.dirname(target), rootMapped,
        replacement: `${relativeHref(posix.dirname(from), target, isDirectory)}${url.search}${url.hash}` };
      return;
    }
    for (const child of node.childNodes ?? []) findBase(child);
  };
  findBase(root);
  const walk = (node: HtmlNode): void => {
    if (node.tagName === "template") return;
    if (node.tagName === "style") {
      for (const child of node.childNodes ?? []) {
        if (child.value === undefined || !child.sourceCodeLocation) continue;
        const transformed = transformCss(child.value, from, base);
        targets.push(...transformed.targets);
        if (transformed.text !== child.value) edits.push({ start: child.sourceCodeLocation.startOffset,
          end: child.sourceCodeLocation.endOffset, text: transformed.text });
      }
    }
    if (node.tagName === "script" && node.attrs?.some((attr) => attr.name === "type" && attr.value.toLowerCase() === "module")
      && !node.attrs.some((attr) => attr.name === "src")) {
      for (const child of node.childNodes ?? []) {
        if (child.value === undefined || !child.sourceCodeLocation) continue;
        const transformed = transformModule(child.value, from, base);
        targets.push(...transformed.targets);
        if (transformed.text !== child.value) edits.push({ start: child.sourceCodeLocation.startOffset,
          end: child.sourceCodeLocation.endOffset, text: transformed.text });
      }
    }
    const rel = node.attrs?.find((attr) => attr.name === "rel")?.value ?? "";
    for (const attr of node.attrs ?? []) {
      const attributeName = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
      const location = node.sourceCodeLocation?.attrs?.[attributeName];
      let value = attr.value;
      if (node === base?.node && attr.name === "href" && base.replacement) {
        value = base.replacement;
      } else if (attr.name === "srcset") {
        const replacements: Edit[] = [];
        for (const candidate of srcsetUrls(value)) {
          const reference = resolveReference(from, candidate.url, base);
          if (!reference) continue;
          targets.push(reference.target);
          if (reference.replacement) replacements.push({ start: candidate.start, end: candidate.end, text: reference.replacement });
        }
        value = applyEdits(value, replacements);
      } else if (attr.name === "style") {
        const transformed = transformCss(value, from, base);
        targets.push(...transformed.targets);
        value = transformed.text;
      } else if (attr.name === "src" || attr.name === "poster" || ((attr.name === "href" || attr.name === "xlink:href") && (
        (node.tagName === "link" && /(?:^|\s)(?:stylesheet|icon|preload|modulepreload|manifest)(?:\s|$)/i.test(rel))
        || node.tagName === "use" || node.tagName === "image"
      ))) {
        const reference = resolveReference(from, value, base);
        if (reference) { targets.push(reference.target); value = reference.replacement ?? value; }
      }
      if (location && value !== attr.value) edits.push({ start: location.startOffset, end: location.endOffset,
        text: `${attributeName}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"` });
    }
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(root);
  return { text: applyEdits(html, edits), targets };
}

function srcsetUrls(value: string): { url: string; start: number; end: number }[] {
  const urls: { url: string; start: number; end: number }[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /[\s,]/.test(value[index]!)) index++;
    const start = index;
    while (index < value.length && !/\s/.test(value[index]!)) index++;
    const end = index;
    const url = value.slice(start, end).replace(/,+$/, "");
    if (url) urls.push({ url, start, end: start + url.length });
    if (end > start && value[end - 1] === ",") continue;
    let parentheses = 0;
    while (index < value.length) {
      const char = value[index++];
      if (char === "(") parentheses++;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "," && parentheses === 0) break;
    }
  }
  return urls;
}

function transformCss(css: string, from: string, base?: HtmlBase): { text: string; targets: string[] } {
  const targets: string[] = [];
  const edits: Edit[] = [];
  for (const match of css.matchAll(/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+(['"])(.*?)\3/gi)) {
    if (match[2] === undefined && match[4] === undefined) continue;
    const value = match[2] ?? match[4] ?? "";
    const reference = resolveReference(from, value, base);
    if (!reference) continue;
    targets.push(reference.target);
    if (reference.replacement) {
      const start = match.index + match[0].indexOf(value);
      edits.push({ start, end: start + value.length, text: reference.replacement });
    }
  }
  return { text: applyEdits(css, edits), targets };
}

function transformModule(source: string, from: string, base?: HtmlBase): { text: string; targets: string[] } {
  const targets: string[] = [];
  const edits: Edit[] = [];
  let tree: unknown;
  try { tree = parseModule(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
  catch {
    try { tree = parseModule(source, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true }); }
    catch { throw new Error(`Comparison preview cannot parse local script: ${from}`); }
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    const node = value as Record<string, unknown>;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(String(node.type))) {
      const specifier = node.source;
      if (specifier && typeof specifier === "object") {
        const literal = specifier as { value?: unknown; start?: number; end?: number };
        if (typeof literal.value === "string" && (literal.value.startsWith(".") || literal.value.startsWith("/"))) {
          const reference = resolveReference(from, literal.value, base);
          if (reference) {
            targets.push(reference.target);
            if (reference.replacement && literal.start !== undefined && literal.end !== undefined) {
              edits.push({ start: literal.start, end: literal.end, text: JSON.stringify(reference.replacement) });
            }
          }
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(tree);
  return { text: applyEdits(source, edits), targets };
}
