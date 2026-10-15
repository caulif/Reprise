import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { ToolPreconditionRejected } from '../../src/core/tool-precondition-rejected.js';

test('workspace listing reports pnpm, external, dangling and cyclic junctions without following them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-link-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, 'work'), outside = join(root, 'outside');
  await mkdir(join(work, 'node_modules', '.pnpm', 'pkg'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside-only');
  await writeFile(join(work, 'node_modules', '.pnpm', 'pkg', 'index.js'), 'package');
  await writeFile(join(work, 'z-valid.txt'), 'valid');
  const links = [
    ['node_modules/pkg', join(work, 'node_modules', '.pnpm', 'pkg')],
    ['a-external', outside], ['b-dangling', join(root, 'missing')], ['c-cycle', work],
  ] as const;
  for (const [name, target] of links) await symlink(target, join(work, name), process.platform === 'win32' ? 'junction' : 'dir');
  let writes = 0;
  const tools = workspaceTools(work, { onControlledWrite: async () => { writes++; } });
  const get = (name: string) => tools.find(tool => tool.name === name)!;
  const signal = new AbortController().signal;
  const listed = JSON.parse((await get('ls').execute({ depth: 4 }, signal)).content) as string[];
  for (const [name] of links) assert.ok(listed.includes(`symlink ${name}`), name);
  assert.ok(listed.includes('file z-valid.txt'));
  assert.ok(listed.includes('file node_modules/.pnpm/pkg/index.js'));
  assert.equal(listed.some(line => /secret|a-external\/|b-dangling\/|c-cycle\/|node_modules\/pkg\//.test(line)), false);
  assert.deepEqual(JSON.parse((await get('find').execute({ name: 'external' }, signal)).content), ['a-external']);
  assert.deepEqual(JSON.parse((await get('grep').execute({ query: 'outside-only' }, signal)).content), []);
  for (const [name] of links) for (const [tool, params] of [
    ['ls', { path: name }], ['read', { path: `${name}/secret.txt` }],
    ['write', { path: `${name}/secret.txt`, content: 'changed' }],
    ['edit', { path: `${name}/secret.txt`, oldText: 'outside-only', newText: 'changed' }],
  ] as const) await assert.rejects(get(tool).execute(params, signal),
    error => error instanceof ToolPreconditionRejected && String(error.reason) === 'symlink_path');
  assert.equal(writes, 0);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'outside-only');
});

test('directory metadata marked as both a link and a directory is never traversed', async () => {
  let reads = 0;
  const tools = workspaceTools('.', { filesystem: { readDirectory: async () => {
    reads++;
    if (reads !== 1) throw new Error('Link followed');
    return [{ name: 'link', isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false },
      { name: 'valid.txt', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true }];
  } } });
  const result = await tools.find(tool => tool.name === 'ls')!.execute({ depth: 4 }, new AbortController().signal);
  assert.deepEqual(JSON.parse(result.content), ['symlink link', 'file valid.txt']);
  assert.equal(reads, 1);
});

test('edit and write reject excessive UTF-8 bytes before journal or mutation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-file-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'input.txt'), 'old');
  let writes = 0;
  const tools = workspaceTools(root, { onControlledWrite: async () => { writes++; } });
  const content = '中'.repeat(90_000);
  for (const [name, params] of [
    ['write', { path: 'input.txt', content }],
    ['edit', { path: 'input.txt', oldText: 'old', newText: content }],
  ] as const) await assert.rejects(tools.find(tool => tool.name === name)!.execute(params, new AbortController().signal),
    error => error instanceof ToolPreconditionRejected && error.reason === 'invalid_arguments');
  assert.equal(writes, 0);
  assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'old');
});
