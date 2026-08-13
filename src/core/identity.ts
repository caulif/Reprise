import { createHash } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Writes a new fact atomically; callers decide whether an existing fact may be reused. */
export async function writeImmutable(path: string, value: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, value, { flag: 'wx' });
  await rename(temporary, path);
}
