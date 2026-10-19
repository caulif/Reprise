import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { codexSessionAdapter } from '../../src/products/packs/codex/sessions.js';
import { readCodexCatalog } from '../../src/products/packs/codex/catalog.js';

function transcript(id: string): Buffer {
  return Buffer.from([
    { type: 'session_meta', payload: { id, cwd: 'C:\\demo' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Explain this lesson.' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Lesson explained.' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
}

test('Codex discovers archived rollouts without an index and deduplicates active copies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-archived-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const archived = join(root, 'archived_sessions');
  await mkdir(sessions);
  await mkdir(archived);
  await writeFile(join(sessions, 'rollout-duplicate.jsonl'), transcript('duplicate'));
  await writeFile(join(archived, 'rollout-duplicate.jsonl'), transcript('duplicate'));
  const archivedPath = join(archived, 'rollout-lesson.jsonl');
  await writeFile(archivedPath, transcript('lesson'));
  const page = await codexSessionAdapter.discover({ root: sessions });
  assert.equal(page.items.length, 2);
  const lesson = page.items.find(item => item.sessionId === 'lesson')!;
  assert.equal(lesson.availability, 'indexed');
  assert.equal(lesson.sourcePath, archivedPath);
  assert.equal(lesson.signals.userMessages, 1);
  const inspected = await codexSessionAdapter.inspect(lesson);
  assert.equal(inspected.transcript[0]?.text, 'Explain this lesson.');
  assert.equal(inspected.signals.completedTurns, 1);
  const excluded = await codexSessionAdapter.discover({ root: sessions, excludeSourcePaths: [archivedPath] });
  assert.equal(excluded.items.some(item => item.sessionId === 'lesson'), false);
});

test('Codex authenticates plain and compressed archive index paths without an active directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-archived-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const archived = join(root, 'archived_sessions');
  await mkdir(archived);
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, cwd TEXT)');
  for (const compressed of [false, true]) {
    const id = compressed ? 'compressed-archive' : 'plain-archive';
    const plain = join(archived, `rollout-${id}.jsonl`);
    await writeFile(compressed ? `${plain}.zst` : plain, compressed ? zstdCompressSync(transcript(id)) : transcript(id));
    db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(id, plain, 'C:\\demo');
  }
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('wrong-id', join(archived, 'rollout-plain-archive.jsonl'), 'C:\\demo');
  const outside = join(root, 'outside.jsonl');
  await writeFile(outside, transcript('outside'));
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('outside', outside, 'C:\\demo');
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot: sessions });
  for (const id of ['plain-archive', 'compressed-archive']) {
    assert.equal(catalog.sessions.find(item => item.sessionId === id)?.availability, 'indexed');
  }
  for (const id of ['wrong-id', 'outside']) {
    assert.equal(catalog.sessions.find(item => item.sessionId === id)?.availability, 'catalog-only');
  }
  const page = await codexSessionAdapter.discover({ root: sessions });
  assert.equal(page.items.length, 4);
  for (const id of ['plain-archive', 'compressed-archive']) {
    const summary = page.items.find(item => item.sessionId === id)!;
    assert.equal(summary.availability, 'indexed');
    assert.equal((await codexSessionAdapter.inspect(summary)).transcript[0]?.text, 'Explain this lesson.');
  }
});

test('Codex does not treat unrelated custom roots as a Codex home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-archived-custom-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const custom = join(root, 'custom');
  const archived = join(root, 'archived_sessions');
  await mkdir(custom);
  await mkdir(archived);
  await writeFile(join(archived, 'rollout-private.jsonl'), transcript('private'));
  assert.equal((await codexSessionAdapter.discover({ root: custom })).items.length, 0);
});

test('Codex does not follow a linked archive root outside the configured home', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-archived-linked-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  const outside = join(root, 'outside');
  const archived = join(root, 'archived_sessions');
  await mkdir(sessions);
  await mkdir(outside);
  const sourcePath = join(outside, 'rollout-linked.jsonl');
  await writeFile(sourcePath, transcript('linked'));
  await symlink(outside, archived, process.platform === 'win32' ? 'junction' : 'dir');
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run('linked', join(archived, 'rollout-linked.jsonl'));
  db.close();
  const page = await codexSessionAdapter.discover({ root: sessions });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.availability, 'catalog-only');
});
