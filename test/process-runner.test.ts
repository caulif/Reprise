import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import test from 'node:test';
import { ProcessBoundaryError, runProcess, type ProcessSpawner } from '../src/infrastructure/process-runner.js';

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
