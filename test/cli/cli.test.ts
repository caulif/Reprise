import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSupportedNodeVersion, runCli, type CliIo } from '../../src/cli/main.js';

function ioCapture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) }, stdout, stderr };
}


test('accepts the supported minimum Node.js version', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.19.0'));
  assert.throws(() => assertSupportedNodeVersion('22.18.9'), /requires Node\.js >= 22\.19\.0/);
});

test('CLI help documents TUI entry and shared prepare/run/compare operations', async () => {
  const output: string[] = [];
  const exitCode = await runCli(['--help'], {
    stdout: (message) => output.push(message),
    stderr: (message) => output.push(`stderr:${message}`),
  });
  assert.equal(exitCode, 0);
  assert.match(output.join('\n'), /Usage:/);
  assert.match(output.join('\n'), /reprise prepare/);
  assert.match(output.join('\n'), /reprise run/);
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

test('CLI reports compare subcommand usage instead of launching TUI', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['compare', '--case', 'case-1'], captured.io), 2);
  assert.match(captured.stderr.join('\n'), /Unknown option '--case'|Usage: reprise compare/);
  assert.doesNotMatch(captured.stdout.join('\n'), /TUI closed/);
});

test('CLI prepare and run require source and TaskCase and do not open TUI', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['prepare'], captured.io), 2);
  assert.match(captured.stderr.join('\n'), /reprise prepare/);
  assert.equal(await runCli(['run'], captured.io), 2);
  assert.match(captured.stderr.join('\n'), /source-root|scenario/);
  assert.doesNotMatch(captured.stdout.join('\n'), /TUI closed/);
});

test('CLI query products returns JSON identities without opening TUI', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-cli-products-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const captured = ioCapture();
  assert.equal(await runCli(['products', '--json', '--data-dir', dataDir], captured.io), 0);
  const body = JSON.parse(captured.stdout.join('\n')) as { ok: boolean; data: { products: Array<{ productId: string }> } };
  assert.equal(body.ok, true);
  assert.ok(body.data.products.some((item) => item.productId === 'codex'));
  assert.equal(captured.stderr.join(''), '');
  assert.doesNotMatch(captured.stdout.join('\n'), /TUI closed/);
});

test('CLI rejects API keys on the command line', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['config', 'set', '--api-key', 'sk-secret'], captured.io), 2);
  assert.match(captured.stderr.join('\n'), /Do not pass API keys/);
  assert.doesNotMatch(captured.stdout.join('\n'), /sk-secret/);
});

test('CLI history query succeeds for a failed experiment record', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-cli-hist-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const captured = ioCapture();
  assert.equal(await runCli(['history', '--data-dir', dataDir, '--json'], captured.io), 0);
  const body = JSON.parse(captured.stdout.join('\n')) as { ok: boolean; data: { items: unknown[] } };
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.items, []);
});

test('CLI events of an unknown experiment exits not_found without TUI', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['events', '--experiment', 'missing-exp', '--json'], captured.io), 3);
  assert.match(captured.stderr.join('\n'), /Unknown experiment/);
  assert.doesNotMatch(captured.stdout.join('\n'), /TUI closed/);
});

test('CLI json and jsonl together is usage', async () => {
  const captured = ioCapture();
  assert.equal(await runCli(['products', '--json', '--jsonl'], captured.io), 2);
  assert.match(captured.stderr.join('\n'), /either --json or --jsonl/);
});
