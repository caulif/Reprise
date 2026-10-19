import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { decodeZstdFrames } from './zstd-frames.js';

let activeDecoders = 0;
const decoderWaiters = new Set<() => void>();

export type SessionEncoding = 'identity' | 'zstd';
export type SessionReceipt = { readonly hash: string; readonly bytes: number };
export type SessionReadOptions = {
  readonly encoding?: SessionEncoding;
  readonly maxBytes?: number;
  readonly maxLineBytes?: number;
  readonly prefix?: boolean;
  readonly signal?: AbortSignal;
  readonly onBytes?: (bytes: Buffer) => void;
};

export class SessionSourceError extends Error {
  constructor(readonly code: 'unsupported-encoding' | 'decompression-failed' | 'read-limit' | 'source-changed', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionSourceError';
  }
}

/** Budgets count decoded bytes. Prefix consumers deliberately do not validate EOF. */
export function sessionReadStream(path: string, options: SessionReadOptions = {}): Readable {
  return Readable.from(readBytes(path, options), { objectMode: false });
}

async function* readBytes(path: string, options: SessionReadOptions): AsyncGenerator<Buffer> {
  options.signal?.throwIfAborted();
  const compressed = options.encoding === 'zstd';
  if (compressed && typeof zlib.createZstdDecompress !== 'function') {
    throw new SessionSourceError('unsupported-encoding', 'This Node.js runtime does not support Zstandard session files.');
  }
  const release = compressed ? await acquireDecoder(options.signal) : undefined;
  const input = createReadStream(path, { signal: options.signal });
  const source = compressed ? Readable.from(decodeZstdFrames(input), { objectMode: false }) : input;
  let bytes = 0;
  let lineBytes = 0;
  try {
    for await (const value of source) {
      options.signal?.throwIfAborted();
      let chunk = value as Buffer;
      const remaining = (options.maxBytes ?? 512 * 1024 * 1024) - bytes;
      if (chunk.length > remaining) {
        if (!options.prefix) throw new SessionSourceError('read-limit', 'Session exceeds the decoded byte limit.');
        chunk = chunk.subarray(0, remaining);
      }
      for (const byte of chunk) {
        lineBytes = byte === 10 ? 0 : lineBytes + 1;
        if (lineBytes > (options.maxLineBytes ?? 16 * 1024 * 1024)) {
          throw new SessionSourceError('read-limit', 'Session exceeds the decoded line limit.');
        }
      }
      bytes += chunk.length;
      options.onBytes?.(chunk);
      yield chunk;
      if (options.prefix && bytes >= (options.maxBytes ?? Infinity)) return;
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'read-limit') {
      throw new SessionSourceError('read-limit', error.message, { cause: error });
    }
    if (options.signal?.aborted || error instanceof SessionSourceError || !compressed || isFileError(error)) throw error;
    throw new SessionSourceError('decompression-failed', 'Compressed session could not be decoded completely.', { cause: error });
  } finally {
    source.destroy();
    input.destroy();
    release?.();
  }
}

async function acquireDecoder(signal?: AbortSignal): Promise<() => void> {
  while (activeDecoders >= 2) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { decoderWaiters.delete(ready); signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => {
        decoderWaiters.delete(ready); signal?.removeEventListener('abort', abort);
        const reason: unknown = signal?.reason;
        reject(reason instanceof Error ? reason : new DOMException('Session read cancelled.', 'AbortError'));
      };
      decoderWaiters.add(ready);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  signal?.throwIfAborted();
  activeDecoders += 1;
  return () => { activeDecoders -= 1; decoderWaiters.values().next().value?.(); };
}

function isFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(String(error.code));
}

export async function snapshotSessionSource(path: string, destination: string, encoding: SessionEncoding | undefined, receipt: SessionReceipt | undefined): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  const source = sessionReadStream(path, { ...(encoding ? { encoding } : {}), onBytes: (chunk) => { hash.update(chunk); bytes += chunk.length; } });
  await pipeline(source, createWriteStream(destination, { flags: 'wx' }));
  if (receipt && (receipt.bytes !== bytes || receipt.hash !== hash.digest('hex'))) {
    throw new SessionSourceError('source-changed', 'Session changed after import; refresh and inspect it again before freezing.');
  }
}
