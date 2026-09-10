import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classifyCodexProject } from '../../src/products/packs/codex/project-attribution.js';
import { freezeCodexSession, inspectCodexSession, codexSessionAdapter } from '../../src/products/packs/codex/sessions.js';
import { importClaudeSession, claudeSessionAdapter } from '../../src/products/packs/claude-code/sessions.js';
import { freezeCase } from '../../src/products/shared/freeze.js';
import { catalogPathKey, readCodexCatalog } from '../../src/products/packs/codex/catalog.js';
import { catalogProjectKey, sessionGroupingKey, sessionProjectKey } from '../../src/products/shared/session-project.js';
import { SESSION_HEAD_BYTES, forEachJsonlRecord, readFileHeadSync } from '../../src/products/shared/jsonl-io.js';
import { freezeBlockedReason } from '../../src/products/shared/session-recovery.js';
import { sha256File } from '../../src/core/identity.js';

const STARTED = '2026-08-14T00:00:00.000Z';
const THREAD = '11111111-2222-4333-8444-555555555555';
const PRIVACY = { allowModelText: false, allowBinary: false, redactions: [] as const };

test('readFileHeadSync reads only the requested prefix of a larger file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-head-bytes-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.jsonl');
  const marker = 'TAIL-MARKER-SHOULD-NOT-BE-IN-HEAD';
  const head = `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`;
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, head);
    writeSync(fd, ' '.repeat(512 * 1024));
    writeSync(fd, `\n${marker}\n`, 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(path).size > SESSION_HEAD_BYTES);
  const result = readFileHeadSync(path, SESSION_HEAD_BYTES);
  assert.ok(result.bytesRead <= SESSION_HEAD_BYTES);
  assert.equal(result.bytesRead, SESSION_HEAD_BYTES);
  assert.equal(result.text.includes(marker), false);
  assert.match(result.text, /session_meta/);
});

test('catalog uses the rollout id map instead of peeking a file whose id is past the head', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-catalog-map-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, 'rollout-late-id.jsonl');
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, `${'{ \n'.repeat(90_000)}`);
    writeSync(fd, `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`);
  } finally {
    closeSync(fd);
  }
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(THREAD, file);
  db.close();
  const peeked = await readCodexCatalog({ codexHome: home, sessionsRoot: sessions });
  assert.equal(peeked.sessions[0]?.availability, 'catalog-only');
  const mapped = await readCodexCatalog({
    codexHome: home,
    sessionsRoot: sessions,
    sessionIdsByPath: new Map([[catalogPathKey(file), THREAD]]),
  });
  assert.equal(mapped.sessions[0]?.availability, 'indexed');
  assert.equal(catalogPathKey(mapped.sessions[0]?.sourcePath ?? ''), catalogPathKey(file));
});

test('cwd matching is one-way and prefers the longest project root', () => {
  const projectsById = new Map([
    ['a', { id: 'a', rootPaths: ['C:\\Users\\demo\\A'] }],
    ['b', { id: 'b', rootPaths: ['C:\\Users\\demo\\B'] }],
    ['outer', { id: 'outer', rootPaths: ['C:\\repo'] }],
    ['inner', { id: 'inner', rootPaths: ['C:\\repo\\nested'] }],
  ]);
  const parent = classifyCodexProject({
    threadId: 't-parent', cwd: 'C:\\Users\\demo', projectless: new Set(), projectsById,
  });
  assert.equal(parent.projectId, undefined);
  assert.equal(parent.projectRoot, 'C:\\Users\\demo');
  const siblingA = classifyCodexProject({
    threadId: 't-a', cwd: 'C:\\Users\\demo\\A\\src', projectless: new Set(), projectsById,
  });
  assert.equal(siblingA.projectId, 'a');
  const siblingB = classifyCodexProject({
    threadId: 't-b', cwd: 'C:\\Users\\demo\\B\\src', projectless: new Set(), projectsById,
  });
  assert.equal(siblingB.projectId, 'b');
  const nested = classifyCodexProject({
    threadId: 't-nested', cwd: 'C:\\repo\\nested\\src', projectless: new Set(), projectsById,
  });
  assert.equal(nested.projectId, 'inner');
  const outerKey = sessionProjectKey('codex', 'c:/repo');
  const innerKey = sessionProjectKey('codex', 'c:/repo/nested');
  const grouped = sessionGroupingKey({
    productId: 'codex', sessionId: 's', cwd: 'C:\\repo\\nested\\src', availability: 'indexed',
  }, new Map([['c:/repo', outerKey], ['c:/repo/nested', innerKey]]));
  assert.equal(grouped, innerKey);
  assert.equal(catalogProjectKey('codex', 'C:\\repo\\nested', 'inner'), innerKey);
});

test('damaged transcript with a valid session_meta merges onto the SQLite id as unreadable', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-unreadable-merge-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, 'rollout-damaged.jsonl');
  await writeFile(file, [
    JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id: THREAD, cwd: 'C:\\demo' } }),
    'this is not json',
  ].join('\n') + '\n');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?)').run(THREAD, file, 'C:\\demo');
  db.close();
  const page = await codexSessionAdapter.discover({ root: sessions });
  const matches = page.items.filter((item) => item.sourcePath.toLowerCase() === file.toLowerCase());
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.sessionId, THREAD);
  assert.equal(matches[0]?.availability, 'indexed');
  assert.equal(matches[0]?.recoveryReadiness, 'pending');
  assert.equal(freezeBlockedReason(matches[0]), undefined);
  assert.equal(page.items.some((item) => item.sessionId.startsWith('unreadable-')), false);
});

test('inspect and freeze succeed for a transcript larger than 64 MiB', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-large-transcript-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'rollout-large.jsonl');
  const head = [
    JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id: THREAD, cwd: 'C:\\demo' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: 'Large task.' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
  ].join('\n') + '\n';
  const tail = `${JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'task_complete' } })}\n`;
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, head);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    chunk[chunk.length - 1] = 0x0a;
    for (let index = 0; index < 1_025; index += 1) writeSync(fd, chunk);
    writeSync(fd, tail);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(file).size > 64 * 1024 * 1024);
  const inspection = await inspectCodexSession(file);
  assert.equal(inspection.sessionId, THREAD);
  const frozen = await freezeCodexSession({
    sourcePath: file, casesRoot: join(home, 'cases'), now: STARTED, privacy: PRIVACY,
  });
  assert.equal(frozen.taskCase.source.sessionId, THREAD);
});

test('JSONL errors report the physical line when blank lines precede the bad row', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-jsonl-line-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'blank-lines.jsonl');
  await writeFile(path, `${JSON.stringify({ ok: true })}\n\n\n{not json}\n`);
  await assert.rejects(
    forEachJsonlRecord(path, 'Codex', () => undefined),
    /invalid JSONL at line 4/,
  );
});

test('freeze hashes the snapshot copy so later source edits cannot desync raw', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-freeze-snapshot-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const file = join(home, 'rollout.jsonl');
  const original = [
    JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id: THREAD, cwd: 'C:\\demo' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: 'Snapshot task.' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n';
  await writeFile(file, original);
  const frozen = await freezeCodexSession({
    sourcePath: file, casesRoot: join(home, 'cases'), now: STARTED, privacy: PRIVACY,
  });
  const raw = join(home, 'cases', frozen.taskCase.caseId, 'raw', 'session.jsonl');
  assert.equal(await sha256File(raw), frozen.taskCase.contentHash);
  assert.equal(frozen.taskCase.provenance.sourceHash, frozen.taskCase.contentHash);
  await writeFile(file, `${original}${JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: 'later write' } })}\n`);
  assert.equal(await sha256File(raw), frozen.taskCase.contentHash);
  assert.notEqual(await sha256File(file), frozen.taskCase.contentHash);
});

test('Claude inspect and freeze succeed for a transcript larger than 64 MiB', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-claude-large-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const file = join(home, '22222222-3333-4444-8555-666666666666.jsonl');
  const sessionId = '22222222-3333-4444-8555-666666666666';
  const head = [
    JSON.stringify({ type: 'user', sessionId, timestamp: STARTED, cwd: 'C:\\demo', message: { role: 'user', content: 'Large Claude task.' } }),
    JSON.stringify({ type: 'assistant', sessionId, timestamp: STARTED, cwd: 'C:\\demo', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } }),
  ].join('\n') + '\n';
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, head);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    chunk[chunk.length - 1] = 0x0a;
    for (let index = 0; index < 1_025; index += 1) writeSync(fd, chunk);
  } finally {
    closeSync(fd);
  }
  assert.ok(statSync(file).size > 64 * 1024 * 1024);
  const inspection = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId, sourcePath: file });
  assert.equal(inspection.sessionId, sessionId);
  const imported = await importClaudeSession(file);
  const frozen = await freezeCase(imported, join(home, 'cases'), PRIVACY, STARTED);
  assert.equal(frozen.taskCase.source.sessionId, sessionId);
  assert.equal(await sha256File(join(home, 'cases', frozen.taskCase.caseId, 'raw', 'session.jsonl')), frozen.taskCase.contentHash);
});
