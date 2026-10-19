import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fingerprintTree } from '../../src/environment/local-workspace-fs.js';
import { sha256 } from '../../src/core/identity.js';
import { MAX_INLINE_HASH_BYTES } from '../../src/environment/snapshots.js';

async function fixture(t: TestContext) {
  const root = await fsp.mkdtemp(join(tmpdir(), 'reprise-fingerprint-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 70; i++) await fsp.writeFile(join(root, `${String(i).padStart(3, '0')}.txt`), `content-${i}`);
  return root;
}

function observeReads(t: TestContext, failure?: Error) {
  const readFile = fsp.readFile;
  const createReadStream = fs.createReadStream;
  const stats = { active: 0, peak: 0, started: 0, streams: 0 };
  const enter = () => {
    stats.started++;
    stats.peak = Math.max(stats.peak, ++stats.active);
  };
  t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    enter();
    try {
      if (stats.active > 32) throw Object.assign(new Error('Open file budget exhausted'), { code: 'EMFILE' });
      if (failure && typeof args[0] === 'string' && args[0].endsWith('000.txt')) throw failure;
      await delay(5);
      return await readFile(...args);
    } finally { stats.active--; }
  });
  t.mock.method(fs, 'createReadStream', (...args: Parameters<typeof fs.createReadStream>) => {
    enter();
    stats.streams++;
    const stream = createReadStream(...args);
    stream.once('close', () => { stats.active--; });
    return stream;
  });
  syncBuiltinESMExports();
  return {
    stats,
    restore: () => { t.mock.restoreAll(); syncBuiltinESMExports(); },
  };
}

test('fingerprinting bounds buffered and streamed reads while preserving complete content hashes', async t => {
  const root = await fixture(t);
  await fsp.mkdir(join(root, 'nested'));
  const large = Buffer.alloc(MAX_INLINE_HASH_BYTES + 1, 97);
  await fsp.writeFile(join(root, 'nested', 'large.bin'), large);
  const observed = observeReads(t);
  try {
    const before = await fingerprintTree(root);
    assert.equal(observed.stats.active, 0);
    assert.ok(observed.stats.peak > 1 && observed.stats.peak <= 32);
    assert.equal(observed.stats.started, 71);
    assert.equal(observed.stats.streams, 1);
    assert.equal(before.budget.fileCount, 71);
    assert.deepEqual(before.budget.blockedReasons, []);
    for (let i = 0; i < 70; i++) {
      const entry = before.fingerprint.resources.find(item => item.path === `${String(i).padStart(3, '0')}.txt`);
      assert.equal(entry?.contentHash, sha256(`content-${i}`));
    }
    assert.equal(before.fingerprint.resources.find(item => item.path === 'nested/large.bin')?.contentHash, sha256(large));
    assert.equal(before.fingerprint.digest, sha256(JSON.stringify(before.fingerprint.resources)));
    const again = await fingerprintTree(root);
    assert.equal(again.fingerprint.digest, before.fingerprint.digest);
    await fsp.writeFile(join(root, '069.txt'), 'changed');
    assert.notEqual((await fingerprintTree(root)).fingerprint.digest, before.fingerprint.digest);
  } finally { observed.restore(); }
});

test('fingerprint failure drains in-flight reads and does not start later batches', async t => {
  const root = await fixture(t);
  const failure = Object.assign(new Error('Source became unreadable'), { code: 'EACCES' });
  const observed = observeReads(t, failure);
  try {
    await assert.rejects(fingerprintTree(root), error => error === failure);
    assert.equal(observed.stats.active, 0, 'failure must not leave reads in progress');
    assert.ok(observed.stats.started > 1 && observed.stats.started <= 32);
    const started = observed.stats.started;
    await delay(10);
    assert.equal(observed.stats.started, started);
  } finally { observed.restore(); }
  assert.equal((await fingerprintTree(root)).budget.fileCount, 70);
});
