import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, writeImmutable } from '../../src/core/identity.js';
import { writeImmutableJson } from '../../src/infrastructure/store/experiment-store.js';

async function directory(t: test.TestContext): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'reprise-immutable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('immutable publication permits exactly one concurrent creator and leaves only complete winning bytes', async (t) => {
  const root = await directory(t);
  const path = join(root, 'fact.json');
  const facts = Array.from({ length: 8 }, (_, index) => ({ index, text: String(index).repeat(100_000) }));
  const results = await Promise.allSettled(facts.map((fact) => writeImmutableJson(path, fact)));
  const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
  assert.equal(winners.length, 1);
  assert.equal(await fs.readFile(path, 'utf8'), `${JSON.stringify(facts[winners[0]!]!)}\n`);
  for (const result of results) if (result.status === 'rejected') {
    const reason: unknown = result.reason;
    assert.ok(reason instanceof Error && 'code' in reason);
    assert.equal(reason.code, 'EEXIST');
  }
  assert.deepEqual(await fs.readdir(root), ['fact.json']);
  await assert.rejects(writeImmutableJson(path, facts[winners[0]!]!), { code: 'EEXIST' });
});

test('two independent processes compete through the filesystem, without a shared in-memory lock', { timeout: 30_000 }, async (t) => {
  const root = await directory(t);
  const path = join(root, 'fact.txt');
  const moduleUrl = new URL('../../src/core/identity.js', import.meta.url).href;
  const script = `
    import { writeImmutable } from ${JSON.stringify(moduleUrl)};
    process.once('message', async () => {
      try { await writeImmutable(process.argv[1], process.argv[2].repeat(200_000)); process.stdout.write('created'); }
      catch (error) { process.stdout.write(error.code ?? error.message); }
      process.disconnect();
    });
    process.send('ready');
  `;
  const bodies = ['first'.repeat(200_000), 'second'.repeat(200_000)];
  const workers = ['first', 'second'].map((body) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, path, body], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let output = '';
    let errors = '';
    assert.ok(child.stdout);
    assert.ok(child.stderr);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    const ready = once(child, 'message');
    const done = once(child, 'exit').then(([code]) => { assert.equal(code, 0, errors); return output; });
    return { child, ready, done };
  });
  await Promise.all(workers.map((worker) => worker.ready));
  for (const worker of workers) worker.child.send('start');
  const results = await Promise.all(workers.map((worker) => worker.done));
  assert.deepEqual([...results].sort(), ['EEXIST', 'created']);
  assert.equal(await fs.readFile(path, 'utf8'), bodies[results.indexOf('created')]);
  assert.deepEqual(await fs.readdir(root), ['fact.txt']);
});

test('existing file, directory and symbolic link targets are not replaced; mutable projection still replaces', async (t) => {
  const root = await directory(t);
  const file = join(root, 'file');
  await fs.writeFile(file, 'original');
  await assert.rejects(writeImmutable(file, 'replacement'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'original');
  const folder = join(root, 'folder');
  await fs.mkdir(folder);
  await assert.rejects(writeImmutable(folder, 'replacement'));
  assert.deepEqual(await fs.readdir(folder), []);
  const junction = join(root, 'junction');
  await fs.symlink(folder, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeImmutable(junction, 'replacement'));
  assert.equal((await fs.lstat(junction)).isSymbolicLink(), true);
  await writeAtomic(file, 'mutable');
  assert.equal(await fs.readFile(file, 'utf8'), 'mutable');
  assert.deepEqual((await fs.readdir(root)).sort(), ['file', 'folder', 'junction']);
});

test('publication exposes only closed complete bytes and unsupported hard links fail without fallback', async (t) => {
  const root = await directory(t);
  const path = join(root, 'fact');
  const originalLink = fs.link;
  const body = 'complete'.repeat(100_000);
  t.mock.method(fs, 'link', async (temporary: string, target: string) => {
    assert.equal(await fs.readFile(temporary, 'utf8'), body);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    return originalLink(temporary, target);
  });
  await writeImmutable(path, body);
  assert.equal(await fs.readFile(path, 'utf8'), body);
  t.mock.restoreAll();
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported filesystem'), { code: 'ENOTSUP' }); });
  await assert.rejects(writeImmutable(join(root, 'unsupported'), body), { code: 'ENOTSUP' });
  assert.deepEqual(await fs.readdir(root), ['fact']);
});

test('write failure and cancellation remove only the private temporary and do not publish', async (t) => {
  const root = await directory(t);
  const path = join(root, 'fact');
  const open = fs.open;
  t.mock.method(fs, 'open', async (temporary: string, flags: string) => {
    const handle = await open(temporary, flags);
    t.mock.method(handle, 'writeFile', async () => { throw new Error('injected write failure'); });
    return handle;
  });
  await assert.rejects(writeImmutable(path, 'bytes'), /injected write failure/);
  assert.deepEqual(await fs.readdir(root), []);
  t.mock.restoreAll();
  const controller = new AbortController();
  t.mock.method(fs, 'open', async (temporary: string, flags: string) => {
    const handle = await open(temporary, flags);
    const write = handle.writeFile.bind(handle);
    t.mock.method(handle, 'writeFile', async () => { await write('complete'); controller.abort(); });
    return handle;
  });
  await assert.rejects(writeImmutable(path, 'bytes', controller.signal), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('cleanup failure reports whether publication succeeded and retains the original failure', async (t) => {
  const root = await directory(t);
  t.mock.method(fs, 'unlink', async () => { throw new Error('injected cleanup failure'); });
  const path = join(root, 'fact');
  await assert.rejects(writeImmutable(path, 'complete'), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /published but temporary cleanup failed/);
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.equal(await fs.readFile(path, 'utf8'), 'complete');
  await assert.rejects(writeImmutable(path, 'conflict'), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    const original: unknown = error.errors[0];
    const cleanup: unknown = error.errors[1];
    assert.ok(original instanceof Error && 'code' in original);
    assert.equal(original.code, 'EEXIST');
    assert.ok(cleanup instanceof Error);
    assert.match(cleanup.message, /cleanup failure/);
    return true;
  });
  assert.equal(await fs.readFile(path, 'utf8'), 'complete');
  assert.equal((await fs.readdir(root)).filter((name) => name.includes('.tmp-')).length, 2);
  t.mock.restoreAll();
});

test('close failure is fatal and simultaneous write, close and cleanup failures retain every cause', async (t) => {
  const root = await directory(t);
  const open = fs.open;
  for (const writeFails of [false, true]) {
    t.mock.method(fs, 'open', async (temporary: string, flags: string) => {
      const handle = await open(temporary, flags);
      const close = handle.close.bind(handle);
      if (writeFails) t.mock.method(handle, 'writeFile', async () => { throw new Error('write cause'); });
      t.mock.method(handle, 'close', async () => { await close(); throw new Error('close cause'); });
      return handle;
    });
    if (writeFails) t.mock.method(fs, 'unlink', async () => { throw new Error('cleanup cause'); });
    await assert.rejects(writeImmutable(join(root, 'fact'), 'complete'), (error: unknown) => {
      const causes = (value: unknown): string[] => value instanceof AggregateError
        ? (value.errors as unknown[]).flatMap(causes) : [value instanceof Error ? value.message : String(value)];
      assert.deepEqual(causes(error), writeFails ? ['write cause', 'close cause', 'cleanup cause'] : ['close cause']);
      return true;
    });
    await assert.rejects(fs.stat(join(root, 'fact')), { code: 'ENOENT' });
    assert.equal((await fs.readdir(root)).length, writeFails ? 1 : 0);
    t.mock.restoreAll();
  }
});
