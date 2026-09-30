import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../core/identity.js';
import { pathContainedBy } from '../core/paths.js';
import type { AgentToolResult } from '../infrastructure/agent/host.js';

type PreviewImage = { path: string; contentHash: string; shortRef: string };
const IMAGE_LIMITS = { count: 4, bytes: 3 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, pixels: 9_216_000 };

export async function attachComparisonImages(input: {
  result: AgentToolResult; requested: boolean; authorized: boolean; attemptRoot: string;
  images: readonly PreviewImage[]; signal: AbortSignal;
}): Promise<AgentToolResult> {
  if (!input.requested) return input.result;
  const payload = JSON.parse(input.result.content) as Record<string, unknown>;
  if (!input.authorized) return deliveryResult(payload, 'not_authorized');
  if (!input.images.length) return deliveryResult(payload, 'unavailable');
  if (input.images.length > IMAGE_LIMITS.count) return deliveryResult(payload, 'budget_exceeded');
  const root = await realpath(input.attemptRoot);
  const blocks: NonNullable<AgentToolResult['contentBlocks']>[number][] = [];
  let total = 0;
  for (const image of input.images) {
    input.signal.throwIfAborted();
    const path = await realpath(resolve(root, image.path));
    if (!pathContainedBy(root, path)) throw new Error('Comparison image escapes attempt root.');
    const info = await stat(path);
    if (!info.isFile() || info.size > IMAGE_LIMITS.bytes) return deliveryResult(payload, 'budget_exceeded');
    const bytes = await readFile(path);
    total += bytes.length;
    if (bytes.length > IMAGE_LIMITS.bytes || total > IMAGE_LIMITS.totalBytes) return deliveryResult(payload, 'budget_exceeded');
    if (sha256(bytes) !== image.contentHash || !boundedPng(bytes)) throw new Error('Comparison image failed hash or PNG validation.');
    blocks.push({ type: 'text', text: `Registered image ${image.shortRef}; contentHash=${image.contentHash}.` },
      { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') });
  }
  input.signal.throwIfAborted();
  const result = deliveryResult(payload, 'attached');
  return { ...result, contentBlocks: [{ type: 'text', text: result.content }, ...blocks] };
}

function boundedPng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width * height <= IMAGE_LIMITS.pixels;
}

function deliveryResult(payload: Record<string, unknown>, imageDelivery: string): AgentToolResult {
  const details = { ...payload, imageDelivery };
  return { content: JSON.stringify(details), details };
}
