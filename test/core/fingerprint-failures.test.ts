import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintTree } from '../../src/environment/local-workspace-fs.js';

for (const externalCancellation of [false, true]) {
  test(`fingerprint drains cancelled peers and preserves ${externalCancellation ? 'external cancellation' : 'the original read error'}`, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'reprise-fingerprint-error-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const pendingPath = join(root, '0-pending.txt');
    const failedPath = join(root, '1-failed.txt');
    await fs.writeFile(pendingPath, 'pending');
    await fs.writeFile(failedPath, 'failed');
    const diskError = Object.assign(new Error('disk read failed'), { code: 'EIO' });
    const cancelled = new Error('external capture cancellation');
    const abort = new AbortController();
    let entered!: () => void;
    const pendingEntered = new Promise<void>(resolve => { entered = resolve; });
    let peerStopped = false;
    const originalRead = fs.readFile;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === pendingPath) {
        const options = args[1];
        const signal = typeof options === 'object' && options !== null ? options.signal : undefined;
        assert.ok(signal);
        entered();
        return new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            peerStopped = true;
            reject(Object.assign(new Error('worker aborted'), { name: 'AbortError', cause: signal.reason as unknown }));
          }, { once: true });
        });
      }
      if (args[0] === failedPath) {
        await pendingEntered;
        if (externalCancellation) abort.abort(cancelled);
        throw diskError;
      }
      return originalRead(...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    try {
      await assert.rejects(fingerprintTree(root, undefined, abort.signal), error => error === (externalCancellation ? cancelled : diskError));
      assert.equal(peerStopped, true);
    } finally {
      fs.readFile = originalRead;
      syncBuiltinESMExports();
    }
  });
}
