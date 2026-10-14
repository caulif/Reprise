import { stat } from 'node:fs/promises';
import { sha256, sha256File } from '../../core/identity.js';
import { assertFrozenFilePath, sealTaskCase, type FrozenFileDigest } from '../../core/task-case-identity.js';
import type { TaskCase } from '../../core/schema.js';
import type { FrozenFile } from './freeze.js';

export async function sealFrozenCase(task: TaskCase, files: readonly FrozenFile[]): Promise<TaskCase> {
  const digests: FrozenFileDigest[] = [];
  for (const file of files) {
    assertFrozenFilePath(file.relativePath);
    if (file.copyFrom) {
      digests.push({ relativePath: file.relativePath, byteLength: (await stat(file.copyFrom)).size, contentHash: await sha256File(file.copyFrom) });
    } else {
      const bytes = typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content ?? Buffer.alloc(0);
      digests.push({ relativePath: file.relativePath, byteLength: bytes.byteLength, contentHash: sha256(bytes) });
    }
  }
  return sealTaskCase(task, digests);
}
