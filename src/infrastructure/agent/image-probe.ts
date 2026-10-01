import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ImageContent } from '@earendil-works/pi-ai';

export function imageProbeChallenge(): { image: ImageContent; expected: string } {
  const colors = [
    { name: 'red', rgb: [255, 0, 0] }, { name: 'green', rgb: [0, 200, 0] },
    { name: 'blue', rgb: [0, 0, 255] }, { name: 'yellow', rgb: [255, 255, 0] },
  ];
  for (let i = colors.length - 1; i > 0; i--) { const j = randomInt(i + 1); [colors[i], colors[j]] = [colors[j]!, colors[i]!]; }
  const width = 80, height = 20;
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 3) + 1 + x * 3;
    const rgb = colors[Math.floor(x / 20)]!.rgb;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = rgb[channel]!;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  return { image: { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }, expected: colors.map((color) => color.name).join(',') };
}

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); output.write(type, 4, 'ascii'); data.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, data.length + 8)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return output;
}
