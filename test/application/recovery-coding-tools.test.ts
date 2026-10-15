import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { ToolPreconditionRejected } from '../../src/core/tool-precondition-rejected.js';
import { hostShellSleep } from '../host-shell.js';

const signal = new AbortController().signal;
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-coding-tools-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return root;
}

test('Recovery patch preflights every path and context before its first write', async t => {
  const root = await setup(t);
  await writeFile(join(root, 'a.txt'), 'original\r\n');
  const entries: unknown[] = [];
  const tools = workspaceTools(root, { recoveryCodingTools: true, onControlledWrite: async entry => { entries.push(entry); } });
  const patch = tools.find(tool => tool.name === 'apply_patch')!;
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-original\n+changed\n*** Add File: ../escape.txt\n+bad\n*** End Patch' }, signal));
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'original\r\n');
  assert.equal(entries.length, 0);
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-missing\n+changed\n*** End Patch' }, signal), /context/);
  assert.equal(entries.length, 0);
  await patch.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-original\n+changed\n*** Add File: b.txt\n+new\n*** End Patch' }, signal);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'changed\r\n');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'new\n');
  assert.equal(entries.length, 4);
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Add File: b.txt\n+overwrite\n*** End Patch' }, signal), /already exists/);
  await patch.execute({ patch: '*** Begin Patch\n*** Delete File: b.txt\n*** End Patch' }, signal);
  await assert.rejects(readFile(join(root, 'b.txt')), /ENOENT/);
});

test('a link appearing after patch preflight is fatal even after the first file was written', async t => {
  const root = await setup(t), work = join(root, 'work'), outside = join(root, 'outside');
  await mkdir(join(work, 'nested'), { recursive: true });
  await mkdir(outside);
  const tools = workspaceTools(work, { recoveryCodingTools: true, onControlledWrite: async entry => {
    if (entry.path === 'first.txt' && entry.phase === 'after') {
      await rename(join(work, 'nested'), join(work, 'old-nested'));
      await symlink(outside, join(work, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    }
  } });
  await assert.rejects(tools.find(tool => tool.name === 'apply_patch')!.execute({
    patch: '*** Begin Patch\n*** Add File: first.txt\n+first\n*** Add File: nested/second.txt\n+second\n*** End Patch',
  }, signal), error => error instanceof Error && !(error instanceof ToolPreconditionRejected) && /after preflight/.test(error.message));
  assert.equal(await readFile(join(work, 'first.txt'), 'utf8'), 'first\n');
  await assert.rejects(readFile(join(outside, 'second.txt')), { code: 'ENOENT' });
});

test('patch cancellation, missing files, moves and symlinks never become writes', async t => {
  const root = await setup(t);
  const patch = workspaceTools(root, { recoveryCodingTools: true }).find(tool => tool.name === 'apply_patch')!;
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch' }, cancelled.signal));
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Delete File: absent.txt\n*** End Patch' }, signal));
  await writeFile(join(root, 'a.txt'), 'x');
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch' }, signal), /unsupported/);
  try { await symlink('a.txt', join(root, 'link.txt')); } catch (error) { if (['EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return; throw error; }
  await assert.rejects(patch.execute({ patch: '*** Begin Patch\n*** Delete File: link.txt\n*** End Patch' }, signal));
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'x');
});

test('view_image uses native blocks and preserves allowBinary', async t => {
  const root = await setup(t);
  // Bounded PNG header already covered by the shared image reader; use a tiny valid fixture.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(root, 'tiny.png'), bytes);
  const denied = workspaceTools(root, { recoveryCodingTools: true }).find(tool => tool.name === 'view_image')!;
  assert.match((await denied.execute({ path: 'tiny.png' }, signal)).content, /binary_read_denied/);
  const allowed = workspaceTools(root, { recoveryCodingTools: true, allowBinary: true }).find(tool => tool.name === 'view_image')!;
  const result = await allowed.execute({ path: 'tiny.png' }, signal);
  assert.ok(result.contentBlocks?.some(block => block.type === 'image' && block.data === bytes.toString('base64')));
  assert.equal(workspaceTools(root).some(tool => tool.name === 'view_image' || tool.name === 'apply_patch'), false);
});

test('independent observations read overlaps a managed writer while project reads stay blocked', async t => {
  const root = await setup(t), observations = join(root, '..', 'observations-' + Date.now());
  await mkdir(observations); t.after(() => rm(observations, { recursive: true, force: true }));
  await writeFile(join(observations, 'index.txt'), 'history'); await writeFile(join(root, 'input.txt'), 'input');
  const tools = workspaceTools(root, { recoveryCodingTools: true, allowShell: true, managedExecution: true, mounts: { observations } });
  const exec = tools.find(tool => tool.name === 'exec_command')!, read = tools.find(tool => tool.name === 'read')!, cancel = tools.find(tool => tool.name === 'cancel_process')!;
  const owner = { sessionId: 'session', invocationId: 'invocation', role: 'recovery' as const };
  const process = await exec.execute({ cmd: hostShellSleep(20), yield_time_ms: 0 }, signal, owner);
  const receipt = process.details as { state: string; session_id: string }; assert.equal(receipt.state, 'running');
  try {
    assert.match((await read.execute({ path: 'observations/index.txt' }, signal)).content, /history/);
    await assert.rejects(read.execute({ path: 'input.txt' }, signal), /workspace/);
  } finally { await cancel.execute({ session_id: receipt.session_id }, signal, owner); }
});
