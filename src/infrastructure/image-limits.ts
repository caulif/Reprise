export const IMAGE_LIMITS = { count: 4, bytes: 3 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, pixels: 9_216_000 };

export function boundedPng(bytes: Buffer): boolean {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') return false;
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width * height <= IMAGE_LIMITS.pixels;
}
