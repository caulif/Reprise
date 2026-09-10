import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessBoundaryError, runProcess, windowsTaskkillExecutable, type ProcessSpawner } from '../../src/infrastructure/process-runner.js';

function fakeSpawner(child: EventEmitter & { stdin: Duplex; stdout: PassThrough; stderr: PassThrough; kill(): boolean }): ProcessSpawner {
  return (() => child) as unknown as ProcessSpawner;
}

test('runProcess turns a child stdout ENOTCONN into a classified boundary error', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const result = runProcess({
    operation: 'session_git_probe',
    executableKind: 'git',
    command: 'git',
    args: ['status'],
    timeoutMs: 1_000,
    spawnProcess: fakeSpawner(child),
  });
  const error = Object.assign(new Error('disconnected'), { code: 'ENOTCONN' });
  child.stdout.emit('error', error);
  await assert.rejects(result, (cause: unknown) => {
    assert.ok(cause instanceof ProcessBoundaryError);
    assert.equal(cause.exitCategory, 'stdio_disconnected');
    assert.equal(cause.errnoCode, 'ENOTCONN');
    assert.equal(cause.operation, 'session_git_probe');
    return true;
  });
});

test('runProcess classifies a nonzero exit without retaining child stderr', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  const result = runProcess({
    operation: 'session_git_probe',
    executableKind: 'git',
    command: 'git',
    args: ['status'],
    timeoutMs: 1_000,
    spawnProcess: fakeSpawner(child),
  });
  child.stderr.write('sensitive command output');
  child.emit('close', 128);
  await assert.rejects(result, (cause: unknown) => {
    assert.ok(cause instanceof ProcessBoundaryError);
    assert.equal(cause.exitCategory, 'nonzero_exit');
    assert.equal(cause.errnoCode, undefined);
    assert.doesNotMatch(cause.message, /sensitive/i);
    return true;
  });
});

test('runProcess classifies a timeout and retains no process output', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => child.emit('close', null)); return true; },
  });
  const result = runProcess({
    operation: 'session_git_probe', executableKind: 'git', command: 'git', args: ['status'], timeoutMs: 1, spawnProcess: fakeSpawner(child),
  });
  await assert.rejects(result, (cause: unknown) => {
    assert.ok(cause instanceof ProcessBoundaryError);
    assert.equal(cause.exitCategory, 'timed_out');
    assert.doesNotMatch(cause.message, /stdout|stderr/i);
    return true;
  });
});

test('runProcess classifies a caller cancellation independently from timeout', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => child.emit('close', null)); return true; },
  });
  const controller = new AbortController();
  const result = runProcess({
    operation: 'session_git_probe', executableKind: 'git', command: 'git', args: ['status'], timeoutMs: 1_000, signal: controller.signal, spawnProcess: fakeSpawner(child),
  });
  controller.abort();
  await assert.rejects(result, (cause: unknown) => {
    assert.ok(cause instanceof ProcessBoundaryError);
    assert.equal(cause.exitCategory, 'cancelled');
    return true;
  });
});

test('windows kill tree uses System32 taskkill, not PATH', () => {
  assert.match(windowsTaskkillExecutable(), /System32[/\\]taskkill\.exe$/i);
  assert.notEqual(windowsTaskkillExecutable(), 'taskkill');
});

test('runProcess never enables Node shell and detaches POSIX kill trees', async () => {
  let options: { shell?: boolean; detached?: boolean } | undefined;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true,
  });
  queueMicrotask(() => child.emit('close', 0));
  const spawnProcess: ProcessSpawner = (command, args, spawnOptions) => {
    options = spawnOptions as { shell?: boolean; detached?: boolean };
    return fakeSpawner(child)(command, args, spawnOptions);
  };
  await runProcess({
    operation: 'shell_probe', executableKind: 'node', command: 'node', args: ['-e', '0'],
    timeoutMs: 1_000, killTree: true, spawnProcess,
  });
  assert.equal(options?.shell, false);
  assert.equal(options?.detached, process.platform === 'win32' ? undefined : true);
});

test('runProcess keeps spaced cwd and argv without a shell string', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise cwd 空格-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const result = await runProcess({
    operation: 'cwd_probe',
    executableKind: 'node',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.cwd())'],
    cwd: root,
    timeoutMs: 8_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toLowerCase(), root.toLowerCase());
});

test('runProcess classifies a missing executable as spawn_error ENOENT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-missing-shell-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runProcess({
      operation: 'shell_exec',
      executableKind: 'bash',
      command: join(root, 'no-such-shell'),
      args: ['-c', 'true'],
      timeoutMs: 2_000,
    }),
    (cause: unknown) => {
      assert.ok(cause instanceof ProcessBoundaryError);
      assert.equal(cause.exitCategory, 'spawn_error');
      assert.equal(cause.errnoCode, 'ENOENT');
      return true;
    },
  );
});

test('runProcess follows a symlink executable', async (t) => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'reprise-symlink-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const link = join(root, 'node-link');
  await symlink(process.execPath, link);
  const result = await runProcess({
    operation: 'symlink_probe', executableKind: 'node', command: link, args: ['-e', 'process.stdout.write("ok")'], timeoutMs: 5_000,
  });
  assert.equal(result.stdout, 'ok');
});

test('runProcess cancel with killTree stops a long child', async () => {
  const controller = new AbortController();
  const result = runProcess({
    operation: 'sleep_probe',
    executableKind: 'node',
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30_000)'],
    timeoutMs: 60_000,
    killTree: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(result, (cause: unknown) => {
    assert.ok(cause instanceof ProcessBoundaryError);
    assert.equal(cause.exitCategory, 'cancelled');
    return true;
  });
});
