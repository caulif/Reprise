import { open } from "node:fs/promises";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonMediaRecordSchema, type ComparisonLinkRecord, type ComparisonMediaRecord } from "../core/schema.js";
import { historicalImageBasenameRe, isHistoricalImagePath } from "./openable-final-path.js";

export const COMPARISON_IMAGE_BASENAME_RE = historicalImageBasenameRe;

const SNIFF_BYTES = 256;

export function isComparisonImagePath(path: string): boolean {
  return isHistoricalImagePath(path);
}

export function mediaTypeForComparisonPath(path: string): string | undefined {
  if (!isComparisonImagePath(path)) return undefined;
  const ext = extname(path.replaceAll("\\", "/")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".avif") return "image/avif";
  return "image/*";
}

function isComparisonImage(input: { mediaType?: string; path?: string }): boolean {
  if (input.mediaType?.startsWith("image/")) return true;
  return isHistoricalImagePath(input.path ?? "");
}

export async function materializeComparisonMedia(input: {
  attemptRoot: string;
  workspaceRoot: string;
  links: readonly ComparisonLinkRecord[];
}): Promise<ComparisonMediaRecord[]> {
  const mediaRoot = join(input.attemptRoot, "media");
  await mkdir(mediaRoot, { recursive: true });
  const media: ComparisonMediaRecord[] = [];
  const seen = new Set<string>();
  for (const link of input.links) {
    const source = await firstExistingFile([
      link.reportHref?.startsWith("media/")
        ? join(input.attemptRoot, ...link.reportHref.split("/"))
        : undefined,
      join(input.attemptRoot, ...link.inspectPath.split("/")),
      link.inspectPath.startsWith("candidate/")
        ? join(input.workspaceRoot, ...link.inspectPath.slice("candidate/".length).split("/"))
        : undefined,
    ]);
    const sniffed = source ? await sniffComparisonImageMediaType(source) : undefined;
    const mediaType = sniffed
      ?? link.mediaType
      ?? mediaTypeForComparisonPath(link.inspectPath);
    if (!isComparisonImage({
      ...(mediaType ? { mediaType } : {}),
      path: link.inspectPath,
    }) && !sniffed) continue;
    const id = mediaId(link);
    if (seen.has(id)) continue;
    seen.add(id);
    const ext = extname(link.inspectPath) || extensionFor(mediaType);
    const fileName = comparisonMediaFileName(id, ext);
    const reportHref = `media/${fileName}`;
    const available = source !== undefined;
    if (source) await copyFile(source, join(mediaRoot, fileName));
    const info = source ? await stat(source).catch(() => undefined) : undefined;
    const record: ComparisonMediaRecord = {
      ref: `media:${id}`,
      side: link.side,
      inspectPath: link.inspectPath,
      reportHref,
      mediaType: mediaType ?? "image/*",
      available,
      ...(info?.isFile() ? { byteLength: info.size } : {}),
    };
    if (!Value.Check(ComparisonMediaRecordSchema, record)) throw new Error("Comparison media record does not satisfy ComparisonMediaRecordSchema.");
    media.push(record);
  }
  return media;
}

async function firstExistingFile(paths: readonly (string | undefined)[]): Promise<string | undefined> {
  for (const path of paths) {
    if (!path) continue;
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) return path;
  }
  return undefined;
}

function mediaId(link: ComparisonLinkRecord): string {
  const raw = (link.artifactId ?? link.inspectPath).replaceAll("\\", "/");
  return raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").slice(0, 80) || "image";
}

export function comparisonMediaFileName(id: string, ext: string): string {
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  if (id.toLowerCase().endsWith(suffix.toLowerCase())) return id;
  return `${id}${suffix}`;
}

function extensionFor(mediaType: string | undefined): string {
  if (mediaType === "image/jpeg") return ".jpg";
  if (mediaType === "image/svg+xml") return ".svg";
  if (mediaType?.startsWith("image/")) return `.${mediaType.slice("image/".length)}`;
  return ".png";
}

export async function sniffComparisonImageMediaType(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead < 4) return undefined;
    const head = buffer.subarray(0, bytesRead);
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
    if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
      return "image/webp";
    }
    if (/<svg\b/i.test(head.toString("utf8"))) return "image/svg+xml";
    return undefined;
  } finally {
    await handle.close();
  }
}
