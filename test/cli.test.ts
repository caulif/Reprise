import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSupportedNodeVersion, runCli, type CliIo } from '../src/cli/main.js';

function ioCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) }, stdout, stderr };
}


test('accepts the supported minimum Node.js version', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.19.0'));
  assert.throws(() => assertSupportedNodeVersion('22.18.9'), /requires Node\.js >= 22\.19\.0/);
});

test('CLI help is side-effect free and documents the TUI entrypoint', async () => {
  const output: string[] = [];
  const exitCode = await runCli(['--help'], {
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(`stderr:${message}`),
  });
  assert.equal(exitCode, 0);
  assert.match(output.join('\n'), /Usage:/);
  assert.match(output.join('\n'), /--sessions-dir/);
  assert.doesNotMatch(output.join('\n'), /smoke-record/);
  assert.doesNotMatch(output.join('\n'), /stderr:/);
});

test('CLI starts the interactive intake through an injected terminal workflow', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-cli-tui-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const calls: Array<{ dataDir: string; sessionsRoot: string; sessionsRoots: Readonly<Record<string, string>> }> = [];
  const captured = ioCapture();
  const codexSessions = join(dataDir, 'codex-sessions');
  const claudeSessions = join(dataDir, 'claude-sessions');
  assert.equal(await runCli(['--data-dir', dataDir, '--sessions-dir', `codex=${codexSessions}`, '--sessions-dir', `claude-code=${claudeSessions}`], captured.io, {
    now: '2026-08-11T00:00:00.000Z',
    runTui: async (input) => { calls.push({ dataDir: input.dataDir, sessionsRoot: input.sessionsRoot, sessionsRoots: input.sessionsRoots }); },
  }), 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.dataDir, dataDir);
  assert.equal(calls[0]?.sessionsRoots.codex, codexSessions);
  assert.equal(calls[0]?.sessionsRoots['claude-code'], claudeSessions);
  assert.match(captured.stdout.join('\n'), /TUI closed/);
});

test('CLI reports unexpected positional arguments', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['compare', '--case', 'case-1'], captured.io), 1);
  assert.match(captured.stderr.join('\n'), /Unexpected argument 'compare'/);
});
