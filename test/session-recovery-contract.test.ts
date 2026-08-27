import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { claudeSessionAdapter } from '../src/products/claude-code/sessions.js';
import { freezeCodexSession, inspectCodexSession, codexSessionAdapter } from '../src/products/codex/sessions.js';
import { catalogProjectKey } from '../src/products/shared/session-project.js';
import {
  freezeBlockedReason,
  importVerifiedSession,
} from '../src/products/shared/session-recovery.js';
import { groupSessionsByProject } from '../src/tui/pages/intake.js';

const STARTED = '2026-08-14T00:00:00.000Z';
const PRIVACY = { allowModelText: false, allowBinary: false, redactions: [] as const };
const THREAD = '11111111-2222-4333-8444-555555555555';
const THREAD_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';

function rollout(id: string, cwd: string, title = `Task ${id}`): string {
  return [
    JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id, cwd } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: title } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n';
}

function claudeRows(id: string, cwd: string): string {
  return [
    JSON.stringify({
      type: 'user', sessionId: id, timestamp: STARTED, cwd,
      message: { role: 'user', content: `Task ${id}` },
    }),
    JSON.stringify({
      type: 'assistant', sessionId: id, timestamp: STARTED, cwd,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' },
    }),
  ].join('\n') + '\n';
}

function writeSqlite(home: string, id: string, rolloutPath: string | null, cwd = 'C:\\demo'): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, cwd TEXT, title TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(id, rolloutPath, cwd, 'Indexed');
  db.close();
}

test('freezeBlockedReason separates transcript, catalog-only, history-only, and unreadable', () => {
  const transcript = { availability: 'indexed' as const, evidenceLevel: 'transcript' as const, sourcePath: 'C:/sessions/rollout.jsonl' };
  assert.equal(freezeBlockedReason(transcript), undefined);
  assert.equal(freezeBlockedReason({ ...transcript, availability: 'unindexed' }), undefined);
  assert.equal(freezeBlockedReason({ ...transcript, availability: 'catalog-only' }), 'source-missing');
  assert.equal(freezeBlockedReason({ ...transcript, sourcePath: 'C:/sessions/.catalog/id.jsonl' }), 'source-missing');
  assert.equal(freezeBlockedReason({ ...transcript, availability: 'unreadable' }), 'unreadable');
  assert.equal(freezeBlockedReason({
    availability: 'catalog-only', evidenceLevel: 'history', sourcePath: 'C:/history.jsonl#reprise-history=abc',
  }), 'history-only');
});

test('10.1 extended catalog path with an existing rollout inspects and freezes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-extended-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, 'rollout-extended.jsonl');
  await writeFile(file, rollout(THREAD, 'C:\\demo'));
  const stored = process.platform === 'win32' ? `\\\\?\\${file}` : file;
  writeSqlite(home, THREAD, stored);
  const page = await codexSessionAdapter.discover({ root: sessions });
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.ok(session);
  assert.equal(session.availability, 'indexed');
  assert.equal(session.sourceKind, 'catalog+transcript');
  assert.equal(freezeBlockedReason(session), undefined);
  const inspection = await inspectCodexSession(session.sourcePath);
  assert.equal(inspection.sessionId, THREAD);
  const imported = await importVerifiedSession(codexSessionAdapter, session, session.sourcePath);
  assert.equal(imported.source.sessionId, THREAD);
  const frozen = await freezeCodexSession({
    sourcePath: session.sourcePath, casesRoot: join(home, 'cases'), now: STARTED, privacy: PRIVACY,
  });
  assert.equal(frozen.taskCase.source.sessionId, THREAD);
});

test('10.2 locator recovers when the DB path is unusable but session_meta.id matches a file', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-locator-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, 'rollout-relocated.jsonl'), rollout(THREAD, 'C:\\demo'));
  writeSqlite(home, THREAD, join(sessions, 'missing-rollout.jsonl'));
  const page = await codexSessionAdapter.discover({ root: sessions });
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.ok(session);
  assert.equal(session.availability, 'indexed');
  assert.equal(session.sourceKind, 'catalog+transcript');
  assert.match(session.sourcePath, /rollout-relocated\.jsonl$/);
  await importVerifiedSession(codexSessionAdapter, session, session.sourcePath);
});

test('10.4 catalog-only without a transcript stays visible and freeze is blocked', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-catalog-only-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  writeSqlite(home, THREAD, null);
  const page = await codexSessionAdapter.discover({ root: sessions });
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.ok(session);
  assert.equal(session.availability, 'catalog-only');
  assert.equal(session.sourceKind, 'catalog-only');
  assert.equal(freezeBlockedReason(session), 'source-missing');
  assert.match(session.sourcePath.replaceAll('\\', '/'), /\.catalog\//);
  await assert.rejects(importVerifiedSession(codexSessionAdapter, session, session.sourcePath), /no readable transcript/);
  await assert.rejects(
    codexSessionAdapter.inspect({ productId: 'codex', sessionId: THREAD, sourcePath: session.sourcePath }),
    /no readable transcript/,
  );
});

test('10.5 deleting the transcript after listing blocks freeze instead of importing stale bytes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-deleted-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, 'rollout-live.jsonl');
  await writeFile(file, rollout(THREAD, 'C:\\demo'));
  const page = await codexSessionAdapter.discover({ root: sessions });
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.ok(session);
  await unlink(file);
  await assert.rejects(importVerifiedSession(codexSessionAdapter, session, session.sourcePath), /cannot be read|unreadable|no readable transcript/i);
});

test('10.6 filename UUID is not used as session id when metadata differs', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-filename-id-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, `rollout-${THREAD}.jsonl`), rollout(THREAD_B, 'C:\\demo'));
  writeSqlite(home, THREAD, join(sessions, `rollout-${THREAD}.jsonl`));
  const page = await codexSessionAdapter.discover({ root: sessions });
  assert.equal(page.items.some((item) => item.sessionId === THREAD_B), true);
  assert.equal(page.items.find((item) => item.sessionId === THREAD)?.sourceKind, 'catalog-only');
  const transcript = page.items.find((item) => item.sessionId === THREAD_B);
  assert.ok(transcript);
  assert.equal(transcript.sourceKind, 'rollout-only');
  await assert.rejects(
    codexSessionAdapter.inspect({ productId: 'codex', sessionId: THREAD, sourcePath: transcript.sourcePath }),
    /does not match/,
  );
});

test('10.7 same cwd sessions all remain visible and freeze independently', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-same-cwd-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const cwd = process.cwd();
  await writeFile(join(sessions, 'rollout-a.jsonl'), rollout(THREAD, cwd, 'First title'));
  await writeFile(join(sessions, 'rollout-b.jsonl'), rollout(THREAD_B, cwd, 'Second title'));
  const page = await codexSessionAdapter.discover({ root: sessions });
  const first = page.items.find((item) => item.sessionId === THREAD);
  const second = page.items.find((item) => item.sessionId === THREAD_B);
  assert.ok(first && second);
  assert.equal(first.cwd, cwd);
  assert.equal(second.cwd, cwd);
  await importVerifiedSession(codexSessionAdapter, first, first.sourcePath);
  await importVerifiedSession(codexSessionAdapter, second, second.sourcePath);
});

test('10.8 rollout-only, catalog-only, and catalog+transcript share grouping and freeze rules', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-kinds-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const projectRoot = 'C:\\Users\\demo\\Reprise';
  await writeFile(join(sessions, 'rollout-merged.jsonl'), rollout(THREAD, projectRoot));
  await writeFile(join(sessions, 'rollout-only.jsonl'), rollout(THREAD_B, projectRoot));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(THREAD, join(sessions, 'rollout-merged.jsonl'), projectRoot);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run('catalog-only-id', null, projectRoot);
  db.close();
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { reprise: { id: 'reprise', name: 'reprise开发', rootPaths: [projectRoot] } },
    'thread-project-assignments': {
      [THREAD]: { projectId: 'reprise' },
      'catalog-only-id': { projectId: 'reprise' },
    },
  }));
  const page = await codexSessionAdapter.discover({ root: sessions });
  const merged = page.items.find((item) => item.sessionId === THREAD);
  const rolloutOnly = page.items.find((item) => item.sessionId === THREAD_B);
  const catalogOnly = page.items.find((item) => item.sessionId === 'catalog-only-id');
  assert.equal(merged?.sourceKind, 'catalog+transcript');
  assert.equal(rolloutOnly?.sourceKind, 'rollout-only');
  assert.equal(catalogOnly?.sourceKind, 'catalog-only');
  assert.ok(merged && rolloutOnly && catalogOnly);
  assert.equal(freezeBlockedReason(merged), undefined);
  assert.equal(freezeBlockedReason(rolloutOnly), undefined);
  assert.ok(freezeBlockedReason(catalogOnly));
  const grouped = groupSessionsByProject(page.items, page.projects);
  const project = grouped.find((item) => item.key === catalogProjectKey('codex', projectRoot, 'reprise'));
  assert.ok(project);
  assert.equal(project.sessions.some((item) => item.sessionId === THREAD), true);
  assert.equal(project.sessions.some((item) => item.sessionId === THREAD_B), true);
  assert.equal(project.sessions.some((item) => item.sessionId === 'catalog-only-id'), true);
});

test('damaged JSONL stays in the catalog as unreadable and cannot freeze', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-broken-jsonl-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, 'rollout-ok.jsonl'), rollout(THREAD, 'C:\\demo'));
  await writeFile(join(sessions, 'rollout-broken.jsonl'), 'not-json\n');
  const page = await codexSessionAdapter.discover({ root: sessions });
  const broken = page.items.find((item) => item.availability === 'unreadable');
  assert.ok(broken);
  assert.equal(page.items.some((item) => item.sessionId === THREAD), true);
  assert.ok(page.diagnostics.some((item) => item.code === 'invalid-jsonl'));
  await assert.rejects(importVerifiedSession(codexSessionAdapter, broken, broken.sourcePath), /unreadable/);
});

test('refresh keeps Codex project assignment and Claude cwd transcripts', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-refresh-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const projectRoot = process.cwd();
  await writeFile(join(sessions, 'rollout-refresh.jsonl'), rollout(THREAD, projectRoot));
  writeSqlite(home, THREAD, join(sessions, 'rollout-refresh.jsonl'), projectRoot);
  await writeFile(join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { reprise: { id: 'reprise', name: 'reprise开发', rootPaths: [projectRoot] } },
    'thread-project-assignments': { [THREAD]: { projectId: 'reprise' } },
  }));
  const first = await codexSessionAdapter.discover({ root: sessions });
  const second = await codexSessionAdapter.discover({ root: sessions, refresh: true });
  assert.equal(first.items[0]?.cwd, second.items[0]?.cwd);
  assert.deepEqual(first.projects, second.projects);

  const claudeRoot = join(home, 'claude');
  await mkdir(claudeRoot);
  await writeFile(join(claudeRoot, `${CLAUDE_ID}.jsonl`), claudeRows(CLAUDE_ID, projectRoot));
  const claude = await claudeSessionAdapter.discover({ root: claudeRoot });
  const session = claude.items.find((item) => item.sessionId === CLAUDE_ID);
  assert.ok(session);
  assert.equal(session.cwd, projectRoot);
  assert.equal(freezeBlockedReason(session), undefined);
  await importVerifiedSession(claudeSessionAdapter, session, session.sourcePath);
});

test('duplicate Codex rollouts keep one verified file and record duplicate-source', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-recovery-duplicate-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  await writeFile(join(sessions, 'rollout-older.jsonl'), rollout(THREAD, 'C:\\demo', 'Older'));
  await writeFile(join(sessions, 'rollout-newer.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-15T00:00:00.000Z', type: 'session_meta', payload: { id: THREAD, cwd: 'C:\\demo' } }),
    JSON.stringify({ timestamp: '2026-08-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Newer' } }),
    JSON.stringify({ timestamp: '2026-08-15T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
    JSON.stringify({ timestamp: '2026-08-15T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  const page = await codexSessionAdapter.discover({ root: sessions });
  assert.equal(page.items.filter((item) => item.sessionId === THREAD).length, 1);
  assert.ok(page.diagnostics.some((item) => item.code === 'duplicate-source'));
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.match(session?.sourcePath ?? '', /rollout-newer\.jsonl$/);
});
