import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical checksum for one committed event envelope body (the object without `checksum`). */
export function eventEnvelopeChecksum(body: object): string {
  return sha256(JSON.stringify(body));
}

/** Streams a file through SHA-256 so an oversized input never lands in memory at once. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** Copies a file through a temporary sibling without buffering the whole contents. */
export async function copyAtomic(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  const temporary = `${to}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await pipeline(createReadStream(from), createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, to);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Replaces a file through a temporary sibling, so a reader never observes a partial write. */
export async function writeAtomic(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, value, { flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Writes a new fact; immutability is the caller's contract, atomicity is this function's. */
export const writeImmutable = writeAtomic;
