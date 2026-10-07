import { lstat, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const RETRY_DELAYS_MS = [30, 80, 160, 320, 640] as const;

export type FrozenDirectoryPublishDependencies = {
  rename?: typeof rename;
  delay?: (ms: number) => Promise<void>;
};

/** Only the private frozen-case staging directory uses these bounded Windows busy retries. */
export async function publishFrozenDirectory(staging: string, target: string, deps: FrozenDirectoryPublishDependencies = {}): Promise<void> {
  const move = deps.rename ?? rename;
  const wait = deps.delay ?? delay;
  for (let attempt = 0; ; attempt++) {
    await assertTargetMissing(target);
    try {
      await move(staging, target);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string'
        || !BUSY_CODES.has(error.code) || attempt === RETRY_DELAYS_MS.length) throw error;
      await wait(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function assertTargetMissing(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Case already exists: ${target}`);
}
