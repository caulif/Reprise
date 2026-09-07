import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codexSessionAdapter } from '../src/products/codex/sessions.js';
import { claudeSessionAdapter } from '../src/products/claude-code/sessions.js';
import { listJsonlFiles } from '../src/products/shared/session-files.js';

function rollout(id: string, timestamp = '2026-08-11T00:00:00.000Z'): string {
  return [
    JSON.stringify({ timestamp, type: 'session_meta', payload: { id } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: `Task ${id}` } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
  ].join('\n') + '\n';
}

test('both discovery summaries skip injected instructions before and after the task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-summary-instructions-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const timestamp = '2026-08-11T00:00:00.000Z';
  const texts = ['# AGENTS.md\nFollow repository rules.', 'Create two PPT slides.', '<environment_context>cwd</environment_context>', 'Use a white background.'];
  const codex = join(root, 'codex');
  const claude = join(root, 'claude');
  await mkdir(codex);
  await mkdir(claude);
  await writeFile(join(codex, 'rollout-instructions.jsonl'), [
    { timestamp, type: 'session_meta', payload: { id: 'instructions', cwd: root } },
    ...texts.map((message) => ({ timestamp, type: 'event_msg', payload: { type: 'user_message', message } })),
  ].map((row) => JSON.stringify(row)).join('\n'));
  await writeFile(join(claude, 'instructions.jsonl'), texts.map((text, index) => JSON.stringify({ timestamp, type: 'user', sessionId: 'instructions', uuid: `message-${index}`, cwd: root, message: { role: 'user', content: text } })).join('\n'));
  for (const [adapter, directory] of [[codexSessionAdapter, codex], [claudeSessionAdapter, claude]] as const) {
    const page = await adapter.discover({ root: directory, limit: 10 });
    assert.equal(page.items[0]?.summary, 'Create two PPT slides.');
    assert.deepEqual(page.items[0]?.laterUserSummaries, ['Use a white background.']);
  }
});

test('Codex discovery builds a bounded global summary index for a large local tree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-tree-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const writes: Promise<void>[] = [];
  for (let index = 0; index < 1_500; index += 1) {
    const directory = join(root, `day-${Math.floor(index / 100)}`);
    if (index % 100 === 0) await mkdir(directory);
    writes.push(writeFile(join(directory, `rollout-${String(index).padStart(4, '0')}.jsonl`), rollout(`session-${index}`)));
    if (writes.length === 100) { await Promise.all(writes); writes.length = 0; }
  }
  await Promise.all(writes);

  const page = await codexSessionAdapter.discover({ root, limit: 50 });
  assert.equal(page.items.length, 50);
  assert.equal(page.scanned, 1_500);
  assert.ok(page.nextCursor);
  assert.equal(page.skipped, 0);

  const listing = await listJsonlFiles(root, (name) => name.endsWith('.jsonl'));
  assert.equal(listing.entries.length, 1_500);
  assert.equal(new Set(listing.entries.map((entry) => entry.path)).size, 1_500);
  assert.deepEqual(listing.diagnostics, []);
});

test('Codex discovery does not follow a directory junction back into its root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-link-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'rollout-real.jsonl'), rollout('real'));
  const loop = join(root, 'loop');
  await symlink(root, loop, 'junction');
  assert.equal((await lstat(loop)).isSymbolicLink(), true);

  const listing = await listJsonlFiles(root, (name) => name.endsWith('.jsonl'));
  assert.equal(listing.entries.length, 1);
  assert.deepEqual(listing.diagnostics, [{ code: 'unsupported-entry', count: 1, samplePath: 'loop' }]);
});

test('Codex discovery aggregates a file deleted between enumeration and metadata read', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-enoent-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'rollout-readable.jsonl'), rollout('readable'));
  const transient = join(root, 'rollout-transient.jsonl');
  await writeFile(transient, rollout('transient'));

  const listing = await listJsonlFiles(root, (name) => {
    if (name === 'rollout-transient.jsonl') unlinkSync(transient);
    return name.endsWith('.jsonl');
  });
  assert.equal(listing.entries.length, 1);
  assert.deepEqual(listing.diagnostics, [{ code: 'unreadable-file', count: 1, samplePath: 'rollout-transient.jsonl' }]);
});

test('Codex discovery aggregates an ACL-denied child directory on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-acl-'));
  const locked = join(root, 'locked');
  const username = process.env.USERNAME;
  assert.ok(username, 'Windows ACL fixture requires USERNAME.');
  let accessDenied = false;
  t.after(async () => {
    if (accessDenied) execFileSync('icacls.exe', [locked, '/remove:d', username], { stdio: 'pipe' });
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await writeFile(join(root, 'rollout-readable.jsonl'), rollout('readable'));
  await mkdir(locked);
  await writeFile(join(locked, 'rollout-blocked.jsonl'), rollout('blocked'));
  execFileSync('icacls.exe', [locked, '/deny', `${username}:(OI)(CI)(RX)`], { stdio: 'pipe' });
  accessDenied = true;

  const listing = await listJsonlFiles(root, (name) => name.endsWith('.jsonl'));
  assert.equal(listing.entries.length, 1);
  assert.deepEqual(listing.diagnostics, [{ code: 'unreadable-directory', count: 1, samplePath: 'locked' }]);
});

test('Codex discovery reports malformed and oversized summaries but keeps a file-mtime fallback explicit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-summary-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fallback = join(root, 'rollout-fallback.jsonl');
  await writeFile(fallback, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'fallback' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'No event clock.' } }),
  ].join('\n') + '\n');
  const fallbackMtime = new Date('2026-08-12T03:04:05.000Z');
  await utimes(fallback, fallbackMtime, fallbackMtime);
  await writeFile(join(root, 'rollout-invalid.jsonl'), rollout('invalid', 'not-a-timestamp'));
  await writeFile(join(root, 'rollout-large.jsonl'), Buffer.alloc(4 * 1024 * 1024 + 1));

  const page = await codexSessionAdapter.discover({ root, limit: 50 });
  const session = page.items.find((item) => item.sessionId === 'fallback');
  assert.ok(session);
  assert.equal(session.startedAt, undefined);
  assert.equal(session.updatedAt, fallbackMtime.toISOString());
  assert.equal(session.updatedAtSource, 'file-mtime');
  assert.deepEqual(page.diagnostics.map((item) => item.code), ['invalid-metadata', 'too-large', 'catalog-unavailable']);
  assert.equal(page.skipped, 2);
});
test('Codex discovery uses the earliest valid event instant as the session start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-started-at-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'rollout-earliest.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-10T23:59:59.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Earlier task.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'earliest' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');

  const page = await codexSessionAdapter.discover({ root, limit: 50 });
  assert.equal(page.items[0]?.startedAt, '2026-08-10T23:59:59.000Z');
  assert.equal(page.items[0]?.startedAtSource, 'event');
});
