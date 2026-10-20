import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sealRecoveryGitHistory } from '../../src/environment/recovery-history.js';
const exec = promisify(execFile);
async function git(root: string, ...args: string[]) { return (await exec('git', ['-c', 'core.longpaths=true', '-C', root, ...args], { windowsHide: true })).stdout.trim(); }
async function repo(root: string) {
  await mkdir(root); await git(root, 'init', '--template='); await writeFile(join(root, 'input.txt'), 'original');
  await git(root, 'add', '.'); await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'input');
  return git(root, 'rev-parse', 'HEAD');
}

test('history sealing rejects an external .git file before changing any outside refs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const outside = join(root, 'outside'), project = join(root, 'project'); const head = await repo(outside);
  await mkdir(project); await writeFile(join(project, '.git'), 'gitdir: ' + join(outside, '.git') + '\n');
  const before = await git(outside, 'show-ref'), config = await readFile(join(outside, '.git', 'config'));
  await assert.rejects(sealRecoveryGitHistory(project, head), /materialized .git directory/);
  assert.equal(await git(outside, 'show-ref'), before);
  assert.deepEqual(await readFile(join(outside, '.git', 'config')), config);
  assert.equal(await readFile(join(outside, 'input.txt'), 'utf8'), 'original');
});

test('history sealing rejects common-dir and object-alternate redirects', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-redirect-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const project = join(root, 'project'), outside = join(root, 'outside'); const head = await repo(project); await repo(outside);
  const before = await git(outside, 'show-ref');
  for (const name of ['commondir', 'objects/info/alternates']) {
    const path = join(project, '.git', name); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, join(outside, '.git', 'objects') + '\n');
    await assert.rejects(sealRecoveryGitHistory(project, head), /redirection/); await rm(path);
    assert.equal(await git(outside, 'show-ref'), before);
  }
});

test('history sealing keeps selected ancestry and dirt, removes future objects and ignores inherited GIT_DIR', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-safe-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const project = join(root, 'project'), outside = join(root, 'outside'); const head = await repo(project); await repo(outside);
  await writeFile(join(project, 'input.txt'), 'answer'); await git(project, 'add', '.');
  await git(project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'answer');
  const answer = await git(project, 'rev-parse', 'HEAD'); await git(project, 'checkout', '--detach', head);
  await writeFile(join(project, 'input.txt'), 'original dirty input');
  const outsideRefs = await git(outside, 'show-ref'), previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(outside, '.git');
  try { await sealRecoveryGitHistory(project, head); } finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  assert.equal(await git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(project, 'input.txt'), 'utf8'), 'original dirty input');
  await assert.rejects(git(project, 'cat-file', '-e', answer));
  assert.equal(await git(outside, 'show-ref'), outsideRefs);
});

test('history sealing rejects model-owned hook and global-config paths before invoking Git', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-hook-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const project = join(root, 'project'); const head = await repo(project);
  const before = await git(project, 'show-ref');
  const hooks = join(project, '.git', 'reprise-disabled-hooks');
  await mkdir(hooks); await writeFile(join(hooks, 'reference-transaction'), '#!/bin/sh\necho executed > hook-executed\n');
  await assert.rejects(sealRecoveryGitHistory(project, head), /redirection/);
  await assert.rejects(readFile(join(project, 'hook-executed')));
  assert.equal(await git(project, 'show-ref'), before);
  await rm(hooks, { recursive: true });
  await writeFile(join(project, '.git', 'missing-global-config'), '[core]\n hooksPath = hooks\n');
  await assert.rejects(sealRecoveryGitHistory(project, head), /redirection/);
  assert.equal(await git(project, 'show-ref'), before);
});

test('history sealing supports deep Windows staging roots without changing global Git configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-deep-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const parent = join(root, 'environment', 'recovery', 'selected-recovery-candidate', 'staging', 'a'.repeat(60), 'b'.repeat(45));
  await mkdir(parent, { recursive: true });
  const project = join(parent, 'project'); const head = await repo(project);
  await sealRecoveryGitHistory(project, head);
  assert.equal(await git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(project, 'input.txt'), 'utf8'), 'original');
});

test('history sealing reads no global config at the Windows pre-longpaths filename boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-config-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const project = join(root, 'project-'.padEnd(Math.max(8, 240 - root.length - 1), 'x'));
  const head = await repo(project);
  const config = join(root, 'global-config');
  await writeFile(config, 'invalid global config\n');
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try { await sealRecoveryGitHistory(project, head); }
  finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
  assert.equal(await readFile(config, 'utf8'), 'invalid global config\n');
  assert.equal(await git(project, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(join(project, 'input.txt'), 'utf8'), 'original');
  assert.equal(await git(project, 'for-each-ref', '--format=%(refname)'), '');
});

test('history sealing deletes symbolic remote HEAD without leaving a dangling ref', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-symref-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const head = await repo(project);
  await git(project, 'update-ref', 'refs/remotes/origin/main', head);
  await git(project, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  assert.equal(await sealRecoveryGitHistory(project, head), true);
  assert.equal(await git(project, 'for-each-ref', '--format=%(refname)'), '');
  await git(project, 'fsck', '--full', '--no-reflogs');
  await assert.rejects(readFile(join(project, '.git', 'refs', 'remotes', 'origin', 'HEAD')));
});

test('history sealing exposes the failed Git operation and diagnostic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-seal-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); const head = await repo(project);
  await writeFile(join(project, '.git', 'config'), '[invalid config');
  await assert.rejects(sealRecoveryGitHistory(project, head), /history sealing failed \(rev-parse, exit 128\):.*bad config/i);
});
