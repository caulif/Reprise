import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sha256File } from '../core/identity.js';

/** Verify persisted bytes against the source stream before sealing the tree. */
export async function copySnapshotFile(from: string, to: string, signal?: AbortSignal): Promise<void> {
  const hash = createHash('sha256');
  const digest = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(createReadStream(from), digest, createWriteStream(to, { flags: 'wx' }), { signal });
  if (await sha256File(to, signal) !== hash.digest('hex')) throw new Error('Snapshot copy hash mismatch.');
}
