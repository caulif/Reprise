import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runOperationId(runId: string, localId: string): string {
  return `r-${sha256(JSON.stringify([runId, localId]))}`;
}

/** Canonical checksum for one committed event envelope body (the object without `checksum`). */
export function eventEnvelopeChecksum(body: object): string {
  return sha256(JSON.stringify(body));
}

/** Streams a file through SHA-256 so an oversized input never lands in memory at once. */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash, { signal });
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
export async function writeAtomic(path: string, value: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    signal?.throwIfAborted();
    await writeFile(temporary, value, { flag: 'wx', ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Publishes complete bytes once; an existing target is never replaced. */
export async function writeImmutable(path: string, value: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await fs.open(temporary, 'wx');
  const failures: unknown[] = [];
  let published = false;
  try {
    const writeFailures: unknown[] = [];
    try {
      await handle.writeFile(value, signal ? { signal } : {});
    } catch (error) {
      writeFailures.push(error);
    }
    try {
      await handle.close();
    } catch (closeError) {
      writeFailures.push(closeError);
    }
    if (writeFailures.length === 1) throw writeFailures[0];
    if (writeFailures.length > 1) throw new AggregateError(writeFailures, `Immutable temporary write and close failed: ${temporary}.`, { cause: writeFailures[0] });
    signal?.throwIfAborted();
    await fs.link(temporary, path);
    published = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    await fs.unlink(temporary);
  } catch (cleanupError) {
    throw new AggregateError([...failures, cleanupError],
      `Immutable file ${published ? 'published but temporary cleanup failed' : 'publication and temporary cleanup failed'}: ${path}; temporary: ${temporary}.`, { cause: cleanupError });
  }
  if (failures.length) throw failures[0];
}
