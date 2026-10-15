import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function mapHistoryItems<T, U>(items: readonly T[], read: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await read(items[index]!);
    }
  }));
  return results;
}

export type HistoryStorageSize = { readonly status: 'collected'; readonly bytes: number; readonly collectedAt: string };

/** Explicit storage walk; symbolic links and junctions are traversal boundaries. */
export async function collectHistoryStorageSize(path: string): Promise<HistoryStorageSize> {
  const walk = async (directory: string): Promise<number> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return 0; throw error; }
    let bytes = 0;
    // One walk owns its I/O queue; recursive Promise.all would multiply concurrency at each depth.
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      try {
        if (entry.isDirectory()) bytes += await walk(child);
        else if (entry.isFile()) bytes += (await lstat(child)).size;
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    return bytes;
  };
  return { status: 'collected', bytes: await walk(path), collectedAt: new Date().toISOString() };
}

export function historyIoErrorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z0-9]+$/.test(error.code) ? error.code : undefined;
}

function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
