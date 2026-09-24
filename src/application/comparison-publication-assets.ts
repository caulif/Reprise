import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonReportModelSchema, type ComparisonLinkRecord, type ComparisonMediaRecord, type ComparisonReportModel } from "../core/schema.js";
import { writeAtomic } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";

export async function persistComparisonReportModel(root: string, model: ComparisonReportModel): Promise<void> {
  if (!Value.Check(ComparisonReportModelSchema, model)) throw new Error("Comparison report model does not satisfy ComparisonReportModelSchema.");
  await writeAtomic(join(root, "report-model.json"), `${JSON.stringify(model)}\n`);
}

export async function publishComparisonArtifacts(input: {
  attemptRoot: string;
  experimentRoot: string;
  html: string;
  media?: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
  model?: ComparisonReportModel;
}): Promise<{ html: string }> {
  const staged = await stagePublishedMedia({
    attemptRoot: input.attemptRoot, experimentRoot: input.experimentRoot,
    html: input.html, media: input.media ?? [],
  });
  for (const link of input.evidence ?? []) {
    if (!link.reportHref) continue;
    const bytes = link.origin === "derived_analysis"
      ? await readRegisteredEvidenceBytes(input.attemptRoot, link)
      : await readRegisteredOriginalLinkBytes(input.attemptRoot, link);
    const destination = resolve(input.experimentRoot, ...link.reportHref.split("/"));
    if (!pathContainedBy(resolve(input.experimentRoot), destination)) throw new Error("Evidence publication path escapes experiment root.");
    await mkdir(dirname(destination), { recursive: true });
    if (!pathContainedBy(await realpath(input.experimentRoot), await realpath(dirname(destination)))) {
      throw new Error("Evidence publication path escapes experiment root.");
    }
    await writeAtomic(destination, bytes);
  }
  if (input.model) await persistComparisonReportModel(input.experimentRoot, rewriteReportModelMediaHrefs(input.model, staged.hrefMap));
  await writeAtomic(join(input.experimentRoot, "report.html"), staged.html);
  return { html: staged.html };
}

async function stagePublishedMedia(input: {
  attemptRoot: string; experimentRoot: string; html: string; media: readonly ComparisonMediaRecord[];
}): Promise<{ html: string; hrefMap: ReadonlyMap<string, string> }> {
  await mkdir(join(input.experimentRoot, "media"), { recursive: true });
  if (!pathContainedBy(await realpath(input.experimentRoot), await realpath(join(input.experimentRoot, "media")))) {
    throw new Error("Published media path escapes experiment root.");
  }
  const byHref = new Map(input.media.map((item) => [item.reportHref.replaceAll("\\", "/").replace(/^\.\//, ""), item]));
  let html = input.html;
  const published = new Map<string, string>();
  for (const href of mediaHrefs(html)) {
    if (href.startsWith("#")) continue;
    if (href.startsWith("data:")) throw new Error("Comparison report contains unregistered data URL media.");
    if (/^(https?:|\/\/)/i.test(href)) throw new Error("Comparison report contains external network resources.");
    const normalized = href.replaceAll("\\", "/").replace(/^\.\//, "");
    if (published.has(normalized)) {
      html = rewriteMediaHref(html, href, published.get(normalized)!);
      continue;
    }
    const record = byHref.get(normalized);
    if (!record?.available) throw new Error(`Comparison media reference is not publishable: ${normalized}`);
    const bytes = await readRegisteredMediaBytes(input.attemptRoot, normalized, record);
    const fullDigest = createHash("sha256").update(bytes).digest("hex");
    const extension = extname(basename(normalized)) || extensionForMediaType(record.mediaType);
    const publishedHref = `media/${fullDigest.slice(0, 24)}${extension}`;
    await writeAtomic(join(input.experimentRoot, publishedHref), bytes);
    published.set(normalized, publishedHref);
    html = rewriteMediaHref(html, href, publishedHref);
  }
  return { html, hrefMap: published };
}

export async function readRegisteredMediaBytes(attemptRoot: string, href: string, record: ComparisonMediaRecord): Promise<Buffer> {
  const normalized = href.replaceAll("\\", "/").replace(/^\.\//, "");
  const source = resolve(attemptRoot, ...normalized.split("/"));
  if (!pathContainedBy(resolve(attemptRoot), source)) throw new Error(`Comparison media path escapes attempt root: ${normalized}`);
  const [rootReal, sourceReal] = await Promise.all([realpath(attemptRoot), realpath(source)]);
  if (!pathContainedBy(rootReal, sourceReal)) throw new Error(`Comparison media path escapes attempt root: ${normalized}`);
  const bytes = await readFile(sourceReal);
  if (record.contentHash && createHash("sha256").update(bytes).digest("hex") !== record.contentHash) {
    throw new Error(`Comparison media content changed after registration: ${normalized}`);
  }
  return bytes;
}

export async function readRegisteredEvidenceBytes(attemptRoot: string, link: ComparisonLinkRecord): Promise<Buffer> {
  if (link.origin !== "derived_analysis" || !link.contentHash
    || !/^evidence\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(link.inspectPath)
    || link.inspectPath.split("/").some((part) => part === "." || part === "..")
    || link.reportHref !== link.inspectPath) throw new Error("Derived evidence registration is not publishable.");
  const source = resolve(attemptRoot, ...link.inspectPath.split("/"));
  const [rootReal, sourceReal] = await Promise.all([realpath(attemptRoot), realpath(source)]);
  if (!pathContainedBy(rootReal, sourceReal)) throw new Error("Derived evidence path escapes attempt root.");
  const bytes = await readFile(sourceReal);
  if (createHash("sha256").update(bytes).digest("hex") !== link.contentHash) {
    throw new Error("Derived evidence content changed after registration.");
  }
  return bytes;
}

export async function sealOriginalLink(attemptRoot: string, sourcePath: string, link: ComparisonLinkRecord): Promise<ComparisonLinkRecord> {
  const bytes = await readLimitedOriginal(sourcePath);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const extension = extname(sourcePath).match(/^\.[A-Za-z0-9]{1,12}$/)?.[0] ?? "";
  const reportHref = `evidence/original/${contentHash}${extension}`;
  await writeAtomic(join(attemptRoot, ...reportHref.split("/")), bytes);
  return { ...link, reportHref, contentHash, byteLength: bytes.length };
}

export async function readRegisteredOriginalLinkBytes(attemptRoot: string, link: ComparisonLinkRecord): Promise<Buffer> {
  const href = link.reportHref;
  if (!href || !link.contentHash || !/^evidence\/original\/[a-f0-9]{64}(?:\.[A-Za-z0-9]{1,12})?$/.test(href)
    || !href.startsWith(`evidence/original/${link.contentHash}`)) {
    throw new Error("Original evidence link has an unsafe publication path.");
  }
  const source = resolve(attemptRoot, ...href.split("/"));
  const [rootReal, sourceReal] = await Promise.all([realpath(attemptRoot), realpath(source)]);
  if (!pathContainedBy(rootReal, sourceReal)) throw new Error("Original evidence path escapes attempt root.");
  const bytes = await readLimitedOriginal(sourceReal);
  if (createHash("sha256").update(bytes).digest("hex") !== link.contentHash) {
    throw new Error("Original evidence content changed after registration.");
  }
  return bytes;
}

async function readLimitedOriginal(source: string): Promise<Buffer> {
  const maxBytes = 32 * 1024 * 1024;
  const handle = await open(source, "r");
  let bytes: Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error("Original evidence exceeds preview copy limit.");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Original evidence exceeds preview copy limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
  return bytes;
}

function rewriteReportModelMediaHrefs(model: ComparisonReportModel, hrefMap: ReadonlyMap<string, string>): ComparisonReportModel {
  if (hrefMap.size === 0) return model;
  const slots: ComparisonReportModel["slots"] = { ...model.slots };
  for (const key of Object.keys(slots) as (keyof ComparisonReportModel["slots"])[]) {
    const value = slots[key];
    if (typeof value !== "string") continue;
    let next = value;
    for (const [from, to] of hrefMap) next = rewriteMediaHref(next, from, to);
    slots[key] = next;
  }
  return { ...model, slots };
}

function rewriteMediaHref(html: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return html
    .replace(new RegExp(`(\\b(?:src|href)\\s*=\\s*["'])${escaped}(["'])`, "gi"), `$1${to}$2`)
    .replace(new RegExp(`url\\((['"]?)${escaped}\\1\\)`, "gi"), `url($1${to}$1)`);
}

function extensionForMediaType(mediaType: string): string {
  if (/svg/i.test(mediaType)) return ".svg";
  if (/webp/i.test(mediaType)) return ".webp";
  if (/gif/i.test(mediaType)) return ".gif";
  if (/jpe?g/i.test(mediaType)) return ".jpg";
  return ".png";
}

function mediaHrefs(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/<(?:img|source|video|image)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) found.add(match[1] ?? "");
  for (const match of html.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) {
    const value = match[2] ?? "";
    if (/\.(png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/i.test(value)) found.add(value);
  }
  return [...found];
}
