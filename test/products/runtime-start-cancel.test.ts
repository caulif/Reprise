import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '../../src/products/packs/codex/runner.js';
import { ClaudeStreamClient } from '../../src/products/packs/claude-code/runner.js';

for (const [product, Client] of [['codex', CodexAppServerClient], ['claude', ClaudeStreamClient]] as const) {
  for (const failure of ['none', 'mkdir', 'cleanup'] as const) test(`${product}: close during directory preparation prevents launch (${failure})`, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'reprise-cancel-start-'));
    const temporaryDirectory = join(root, 'candidate-temp');
    const originalMkdir = fs.mkdir;
    const originalRm = fs.rm;
    if (failure === 'mkdir') {
      await originalMkdir(temporaryDirectory);
      await fs.writeFile(join(temporaryDirectory, 'unowned.txt'), 'preserve');
    }
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let preparations = 0;
    t.mock.method(fs, 'mkdir', async (path: Parameters<typeof fs.mkdir>[0], options: Parameters<typeof fs.mkdir>[1]) => {
      if (path === temporaryDirectory) { preparations++; entered(); await gate; }
      return originalMkdir(path, options);
    });
    let spawns = 0;
    t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('Unexpected process launch.'); });
    if (failure === 'cleanup') t.mock.method(fs, 'rm', async (path: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
      if (path === temporaryDirectory) throw new Error('Temporary directory cleanup failed.');
      return originalRm(path, options);
    });
    syncBuiltinESMExports();
    const client = new Client({ executable: process.execPath, cwd: root, args: [], completeEnv: {}, temporaryDirectory });
    const starting = Promise.all([client.start(), client.start()]);
    const rejectedStart = assert.rejects(starting, failure === 'mkdir' ? /EEXIST/ : /closed/);
    let closing: Promise<void> | undefined;
    try {
      await reached;
      let closed = false;
      closing = client.close().then(() => { closed = true; });
      const closedResult = failure === 'none' ? closing : assert.rejects(closing, failure === 'mkdir' ? /EEXIST/ : /cleanup failed/);
      await Promise.resolve();
      assert.equal(closed, false, 'close must wait for resource ownership to settle');
      release();
      await Promise.all([rejectedStart, closedResult]);
      assert.equal(preparations, 1);
      assert.equal(spawns, 0);
      if (failure === 'none') {
        await assert.rejects(fs.access(temporaryDirectory));
        await client.close();
        await assert.rejects(client.start(), /closed/);
      } else if (failure === 'mkdir') {
        assert.equal(await fs.readFile(join(temporaryDirectory, 'unowned.txt'), 'utf8'), 'preserve');
      }
    } finally {
      release();
      await Promise.allSettled([starting, closing]);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await originalRm(root, { recursive: true, force: true });
    }
  });
}
