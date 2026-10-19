import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { stripWindowsExtendedPrefix } from '../../../core/paths.js';
import type { SessionEncoding } from '../../shared/session-source.js';

export function codexSourceEncoding(path: string): SessionEncoding {
  return path.endsWith('.jsonl.zst') ? 'zstd' : 'identity';
}

export function codexHistoryRoots(sessionsRoot: string): readonly string[] {
  if (basename(sessionsRoot).toLowerCase() !== 'sessions') return [sessionsRoot];
  const archived = join(dirname(sessionsRoot), 'archived_sessions');
  try {
    const info = lstatSync(archived);
    return info.isDirectory() && !info.isSymbolicLink() ? [sessionsRoot, archived] : [sessionsRoot];
  } catch (error) {
    if (isMissingSource(error)) return [sessionsRoot];
    throw error;
  }
}

/** Resolve representation changes only within the requested file's directory. */
export function resolveCodexSource(path: string): string {
  const plain = path.endsWith('.jsonl.zst') ? path.slice(0, -4) : path;
  for (const candidate of [plain, `${plain}.zst`]) {
    let info;
    try { info = lstatSync(candidate); } catch (error) {
      if (isMissingSource(error)) continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Codex session source must be a regular file.');
    const real = stripWindowsExtendedPrefix(realpathSync(candidate));
    const parent = stripWindowsExtendedPrefix(realpathSync(dirname(candidate)));
    if (dirname(real).toLowerCase() !== parent.toLowerCase()) throw new Error('Codex session source escaped its directory.');
    return real;
  }
  throw Object.assign(new Error('Codex session cannot be read: source is missing.'), { code: 'ENOENT' });
}

export async function withCodexSource<T>(path: string, read: (resolved: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    try { return await read(resolveCodexSource(path)); } catch (error) {
      if (!isMissingSource(error) || attempt >= 3) throw error;
      await setTimeout(50, undefined, { signal });
    }
  }
}

function isMissingSource(error: unknown): boolean {
  return error instanceof Error && (('code' in error && error.code === 'ENOENT') || ('cause' in error && isMissingSource(error.cause)));
}
