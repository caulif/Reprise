import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ComparisonMediaRecordSchema, type ComparisonLinkRecord, type ComparisonMediaRecord } from "../core/schema.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

function isComparisonImage(input: { mediaType?: string; path?: string }): boolean {
  if (input.mediaType?.startsWith("image/")) return true;
  const ext = extname((input.path ?? "").replaceAll("\\", "/")).toLowerCase();
  return IMAGE_EXT.has(ext);
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
      join(input.attemptRoot, ...link.inspectPath.split("/")),
      link.inspectPath.startsWith("candidate/")
        ? join(input.workspaceRoot, ...link.inspectPath.slice("candidate/".length).split("/"))
        : undefined,
    ]);
    const mediaType = link.mediaType ?? (source ? await sniffImageMediaType(source) : undefined);
    if (!isComparisonImage({
      ...(mediaType ? { mediaType } : {}),
      path: link.inspectPath,
    }) && !(source && await looksLikeImageFile(source))) continue;
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

async function looksLikeImageFile(path: string): Promise<boolean> {
  return (await sniffImageMediaType(path)) !== undefined;
}

async function sniffImageMediaType(path: string): Promise<string | undefined> {
  const head = await readFile(path).then((bytes) => bytes.subarray(0, 16)).catch(() => undefined);
  if (!head || head.length < 4) return undefined;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) {
    return "image/webp";
  }
  const text = head.toString("utf8").trimStart();
  if (text.startsWith("<svg") || text.startsWith("<?xml")) return "image/svg+xml";
  return undefined;
}
