import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

/** Native Node decoders stop at the first frame and can accept a truncated last block. */
export async function* decodeZstdFrames(input: Readable): AsyncGenerator<Buffer> {
  const reader = new FrameReader(input);
  let frames = 0;
  for (;;) {
    const magic = await reader.take(4, true);
    if (!magic) break;
    const number = magic.readUInt32LE();
    if ((number & 0xfffffff0) === 0x184d2a50) {
      let remaining = (await reader.take(4)).readUInt32LE();
      if (remaining > 512 * 1024 * 1024) throw readLimit('Zstandard skippable frame exceeds the input limit.');
      while (remaining) { const count = Math.min(remaining, 64 * 1024); await reader.take(count); remaining -= count; }
      continue;
    }
    if (number !== 0xfd2fb528) throw new Error('Invalid Zstandard frame magic.');
    const descriptor = await reader.take(1);
    const flag = descriptor[0]!;
    if (flag & 8) throw new Error('Reserved Zstandard frame bit is set.');
    const single = Boolean(flag & 32);
    const sizeFlag = flag >>> 6;
    const dictionaryBytes = [0, 1, 2, 4][flag & 3]!;
    const sizeBytes = [single ? 1 : 0, 2, 4, 8][sizeFlag]!;
    const rest = await reader.take((single ? 0 : 1) + dictionaryBytes + sizeBytes);
    const expected = frameContentSize(rest, sizeBytes, sizeFlag);
    if (expected !== undefined && expected > 512 * 1024 * 1024) throw readLimit('Zstandard frame content size exceeds the decoded limit.');
    const window = single ? expected! : 2 ** (10 + (rest[0]! >>> 3)) * (1 + (rest[0]! & 7) / 8);
    if (window > 128 * 1024 * 1024) throw readLimit('Zstandard frame exceeds the decoder window limit.');
    const header = Buffer.concat([magic, descriptor, rest]);
    const source = Readable.from(frameChunks(reader, header, Boolean(flag & 4)), { objectMode: false });
    const decoder = zlib.createZstdDecompress({ params: { [zlib.constants.ZSTD_d_windowLogMax]: 27 } });
    const pump = pipeline(source, decoder).then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error('Zstandard frame pipeline failed.', { cause: error }));
    let bytes = 0;
    try {
      for await (const chunk of decoder) {
        const value = chunk as Buffer;
        bytes += value.length;
        yield value;
      }
      const error = await pump;
      if (error) throw error;
      if (expected !== undefined && expected !== bytes) throw new Error('Zstandard frame content size does not match decoded bytes.');
    } finally {
      source.destroy(); decoder.destroy();
      // Early preview termination intentionally closes the current frame pipeline.
      await pump;
    }
    frames += 1;
  }
  if (!frames) throw new Error('Compressed session contains no Zstandard data frame.');
}

function frameContentSize(rest: Buffer, sizeBytes: number, flag: number): number | undefined {
  if (!sizeBytes) return undefined;
  const offset = rest.length - sizeBytes;
  const size = sizeBytes === 8 ? Number(rest.readBigUInt64LE(offset)) : rest.readUIntLE(offset, sizeBytes);
  return flag === 1 ? size + 256 : size;
}

function readLimit(message: string): Error {
  return Object.assign(new Error(message), { code: 'read-limit' });
}

async function* frameChunks(reader: FrameReader, header: Buffer, checksum: boolean): AsyncGenerator<Buffer> {
  yield header;
  let last = false;
  while (!last) {
    const block = await reader.take(3);
    const value = block.readUIntLE(0, 3);
    last = Boolean(value & 1);
    const type = (value >>> 1) & 3;
    const size = value >>> 3;
    if (type === 3 || size > 128 * 1024) throw new Error('Invalid Zstandard block header.');
    yield block;
    yield await reader.take(type === 1 ? 1 : size);
  }
  if (checksum) yield await reader.take(4);
}

class FrameReader {
  readonly #iterator: AsyncIterator<Buffer>;
  #pending = Buffer.alloc(0);

  constructor(input: Readable) { this.#iterator = input[Symbol.asyncIterator]() as AsyncIterator<Buffer>; }

  take(count: number): Promise<Buffer>;
  take(count: number, allowEof: true): Promise<Buffer | undefined>;
  async take(count: number, allowEof = false): Promise<Buffer | undefined> {
    while (this.#pending.length < count) {
      const next = await this.#iterator.next();
      if (next.done) {
        if (allowEof && this.#pending.length === 0) return undefined;
        throw new Error('Truncated Zstandard frame.');
      }
      this.#pending = Buffer.concat([this.#pending, next.value]);
    }
    const result = this.#pending.subarray(0, count);
    this.#pending = this.#pending.subarray(count);
    return result;
  }
}
