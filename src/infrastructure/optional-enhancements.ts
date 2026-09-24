import { randomUUID } from "node:crypto";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import type { ToolConfig } from "../core/tool-schema.js";
import { runProcess } from "./process-runner.js";
import { spawnRuntimeProcess } from "./process/spawn.js";

const ProbeSchema = Type.Object({
  streams: Type.Array(Type.Object({
    codec_type: Type.Optional(Type.String()), codec_name: Type.Optional(Type.String()),
    width: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()),
    sample_rate: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
  format: Type.Optional(Type.Object({ duration: Type.Optional(Type.String()) }, { additionalProperties: true })),
}, { additionalProperties: true });

async function outputPath(source: string, output: string): Promise<{ source: string; output: string }> {
  const sourceReal = await realpath(resolve(source));
  const info = await stat(sourceReal);
  if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error("Enhancement input must be a regular file under 256 MiB.");
  const parentReal = await realpath(dirname(resolve(output)));
  const outputReal = join(parentReal, basename(output));
  const comparable = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (comparable(sourceReal) === comparable(outputReal)) throw new Error("Enhancement output cannot overwrite its source.");
  return { source: sourceReal, output: outputReal };
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error("Enhancement output exceeds size limit.");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65_536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Enhancement output exceeds size limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

async function filePrefix(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function mediaDemuxer(path: string): Promise<string> {
  const extension = extname(path).toLowerCase();
  const prefix = await filePrefix(path);
  if ([".mp4", ".m4v", ".mov"].includes(extension) && prefix.subarray(4, 8).toString("ascii") === "ftyp") return "mov";
  if ([".webm", ".mkv"].includes(extension) && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "matroska";
  if (extension === ".wav" && prefix.subarray(0, 4).toString("ascii") === "RIFF"
    && prefix.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  throw new Error("Enhancement input is not a supported local media container.");
}

async function assertOcrImage(path: string): Promise<void> {
  const extension = extname(path).toLowerCase();
  const prefix = await filePrefix(path);
  const png = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const tiff = ["II*\0", "MM\0*"].includes(prefix.subarray(0, 4).toString("binary"));
  if ((extension === ".png" && png) || ([".jpg", ".jpeg"].includes(extension) && jpeg)
    || ([".tif", ".tiff"].includes(extension) && tiff)) return;
  throw new Error("OCR input must be a PNG, JPEG, or TIFF image.");
}

export async function inspectMedia(config: ToolConfig, source: string, output: string): Promise<void> {
  const command = config.enhancements?.ffprobePath;
  if (!command) throw new Error("ffprobe is not configured.");
  const paths = await outputPath(source, output);
  const demuxer = await mediaDemuxer(paths.source);
  const result = await runProcess({ operation: "inspect-media", executableKind: "ffprobe", command,
    args: ["-v", "error", "-protocol_whitelist", "file", "-f", demuxer,
      ...(demuxer === "mov" ? ["-enable_drefs", "0"] : []),
      "-show_format", "-show_streams", "-of", "json", paths.source],
    timeoutMs: 15_000, maxOutputBytes: 262_144, killTree: true, spawnProcess: spawnRuntimeProcess });
  let parsed: unknown;
  try { parsed = JSON.parse(result.stdout); }
  catch { throw new Error("ffprobe returned invalid JSON."); }
  if (!Value.Check(ProbeSchema, parsed)) throw new Error("ffprobe result does not satisfy the media probe schema.");
  const data = { schemaVersion: 1, sourceName: basename(paths.source), streams: parsed.streams.map((item) => ({
    ...(item.codec_type ? { type: item.codec_type } : {}),
    ...(item.codec_name ? { codec: item.codec_name } : {}),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    ...(item.sample_rate ? { sampleRate: item.sample_rate } : {}),
  })), ...(parsed.format?.duration ? { durationSeconds: parsed.format.duration } : {}) };
  await writeAtomic(paths.output, `${JSON.stringify(data)}\n`);
}

export async function extractMediaFrame(config: ToolConfig, source: string, output: string, timeMs: number): Promise<void> {
  const command = config.enhancements?.ffmpegPath;
  if (!command) throw new Error("ffmpeg is not configured.");
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > 3_600_000) throw new Error("Frame time must be an integer from 0 to 3600000 ms.");
  const paths = await outputPath(source, output);
  if (!paths.output.toLowerCase().endsWith(".png")) throw new Error("Frame output must be a PNG path.");
  const demuxer = await mediaDemuxer(paths.source);
  const staged = join(dirname(paths.output), `.reprise-frame-${randomUUID()}.png`);
  try {
    await runProcess({ operation: "extract-frame", executableKind: "ffmpeg", command,
      args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file",
        "-f", demuxer, ...(demuxer === "mov" ? ["-enable_drefs", "0"] : []),
        "-ss", (timeMs / 1000).toFixed(3), "-i", paths.source,
        "-frames:v", "1", "-an", "-sn", "-f", "image2", "-y", staged],
      timeoutMs: 30_000, maxOutputBytes: 16_384, killTree: true, spawnProcess: spawnRuntimeProcess });
    const bytes = await readBounded(staged, 16 * 1024 * 1024);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error("ffmpeg did not produce PNG bytes.");
    }
    await writeAtomic(paths.output, bytes);
  } finally { await rm(staged, { force: true }); }
}

export async function ocrImage(config: ToolConfig, source: string, output: string): Promise<void> {
  const command = config.enhancements?.tesseractPath;
  if (!command) throw new Error("Tesseract is not configured.");
  const paths = await outputPath(source, output);
  await assertOcrImage(paths.source);
  const result = await runProcess({ operation: "ocr-text", executableKind: "tesseract", command,
    args: [paths.source, "stdout"], timeoutMs: 30_000, maxOutputBytes: 262_144,
    killTree: true, spawnProcess: spawnRuntimeProcess });
  await writeAtomic(paths.output, result.stdout);
}
