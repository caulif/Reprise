import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function withFrozenCaseLease<T>(caseDir: string, action: () => Promise<T>): Promise<T> {
  const path = `${caseDir}.publish-lock`;
  let handle;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await open(path, 'wx');
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      if (attempt === 100) throw new Error(`Frozen case publication is busy; preserve the lease and retry: ${caseDir}`, { cause: error });
      await delay(100);
    }
  }
  const owned = await handle.stat();
  const nonce = randomUUID();
  const failures: unknown[] = [];
  let result: T | undefined;
  try { await handle.writeFile(nonce, 'utf8'); result = await action(); } catch (error) { failures.push(error); }
  try { await handle.close(); } catch (error) { failures.push(error); }
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.ino !== owned.ino || current.dev !== owned.dev || await readFile(path, 'utf8') !== nonce) {
      throw new Error(`Frozen case lease ownership changed; preserve the current lease: ${path}`);
    }
    await unlink(path);
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, `Frozen case publication or lease cleanup failed: ${caseDir}`, { cause: failures[0] });
  return result!;
}
