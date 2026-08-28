import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, openSync, writeSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isEligibleSession } from '../src/products/contract.js';
import {
  attemptSessionRecovery,
  freezeBlockedReason,
  importVerifiedSession,
  listSummaryIncomplete,
  replayBlockedAfterInspect,
  SessionReplayError,
} from '../src/products/shared/session-recovery.js';
import {
  discoverCodexSessions,
  freezeCodexSession,
  inspectCodexSession,
  codexSessionAdapter,
} from '../src/products/codex/sessions.js';
import { forEachJsonlRecord, forEachJsonlRecordLenient } from '../src/products/shared/jsonl-io.js';

const STARTED = '2026-08-14T00:00:00.000Z';
const PRIVACY = { allowModelText: false, allowBinary: false, redactions: [] as const };
const THREAD = '11111111-2222-4333-8444-555555555555';

function meta(id = THREAD): string {
  return JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id, cwd: 'C:\\demo' } });
}

function eventUser(text: string): string {
  return JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: text } });
}

function eventAssistant(text: string): string {
  return JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'agent_message', message: text } });
}

function taskComplete(): string {
  return JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'task_complete' } });
}

function desktopMessage(role: 'user' | 'assistant' | 'developer' | 'system', content: unknown): string {
  return JSON.stringify({
    timestamp: STARTED,
    type: 'response_item',
    payload: { type: 'message', role, content },
  });
}

async function writeRollout(path: string, rows: string[]): Promise<void> {
  await writeFile(path, `${rows.join('\n')}\n`);
}

function writePadded(path: string, padBytes: number, user: string, id = THREAD): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, `${meta(id)}\n`);
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    chunk[chunk.length - 1] = 0x0a;
    for (let written = 0; written < padBytes; written += chunk.length) writeSync(fd, chunk);
    writeSync(fd, `${eventUser(user)}\n${eventAssistant('Done.')}\n${taskComplete()}\n`);
  } finally {
    closeSync(fd);
  }
}

test('Codex event_msg, Desktop message, mixed formats, and unknown content share one user count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-codex-normalize-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const legacy = join(sessions, 'rollout-legacy.jsonl');
  const desktop = join(sessions, 'rollout-desktop.jsonl');
  const mixed = join(sessions, 'rollout-mixed.jsonl');
  const unknown = join(sessions, 'rollout-unknown.jsonl');
  const developer = join(sessions, 'rollout-developer.jsonl');
  await writeRollout(legacy, [meta('legacy-session'), eventUser('Legacy task.'), eventAssistant('Done.'), taskComplete()]);
  await writeRollout(desktop, [
    meta('desktop-session'),
    desktopMessage('user', [{ type: 'input_text', text: 'Desktop task.' }, { type: 'output_text', text: 'more' }]),
    desktopMessage('assistant', [{ type: 'output_text', text: 'Desktop done.' }]),
    taskComplete(),
  ]);
  await writeRollout(mixed, [
    meta('mixed-session'),
    eventUser('Old turn.'),
    desktopMessage('user', [{ type: 'text', text: 'New turn.' }]),
    eventAssistant('Ack.'),
    taskComplete(),
  ]);
  await writeRollout(unknown, [
    meta('unknown-session'),
    desktopMessage('user', [{ type: 'input_text', text: 'Keep text.' }, { type: 'image', url: 'x' }]),
    { type: 'mystery_event', payload: { type: 'ignored' } },
    eventAssistant('Done.'),
    taskComplete(),
  ].map((row) => typeof row === 'string' ? row : JSON.stringify(row)));
  await writeRollout(developer, [
    meta('developer-session'),
    desktopMessage('developer', [{ type: 'input_text', text: 'AGENTS.md rules' }]),
    desktopMessage('system', [{ type: 'input_text', text: 'system prompt' }]),
    eventAssistant('No user.'),
  ]);

  const discovered = await discoverCodexSessions(sessions);
  const byId = new Map(discovered.map((session) => [session.sessionId, session]));
  assert.equal(byId.get('legacy-session')?.signals.userMessages, 1);
  assert.equal(byId.get('desktop-session')?.signals.userMessages, 1);
  assert.equal(byId.get('mixed-session')?.signals.userMessages, 2);
  assert.equal(byId.get('unknown-session')?.signals.userMessages, 1);
  assert.equal(byId.get('developer-session')?.signals.userMessages, 0);
  assert.equal(byId.get('developer-session')?.recoveryReadiness, 'no-user-input');

  for (const id of ['legacy-session', 'desktop-session', 'mixed-session', 'unknown-session']) {
    const listed = byId.get(id);
    assert.ok(listed);
    const inspected = await inspectCodexSession(listed.sourcePath);
    const imported = await importVerifiedSession(codexSessionAdapter, listed, listed.sourcePath);
    assert.equal(listed.signals.userMessages, inspected.signals.userMessages);
    assert.equal(inspected.signals.userMessages, imported.signals.userMessages);
  }
  const unknownInspect = await inspectCodexSession(unknown);
  assert.match(unknownInspect.transcript.find((message) => message.role === 'user')?.text ?? '', /Keep text/);
  assert.equal(unknownInspect.transcript.some((message) => message.text.includes('image')), false);
  await assert.rejects(
    importVerifiedSession(codexSessionAdapter, byId.get('developer-session')!, developer),
    (error: unknown) => error instanceof SessionReplayError && error.code === 'no-user-input',
  );
});

test('user messages past the 256 KiB head and 4 MiB summary still inspect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-codex-late-user-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const lateHead = join(sessions, 'rollout-late-head.jsonl');
  writePadded(lateHead, 300 * 1024, 'After head.', 'late-head-session');
  const lateSummary = join(sessions, 'rollout-late-summary.jsonl');
  writePadded(lateSummary, 5 * 1024 * 1024, 'After summary window.', 'late-summary-session');
  const discovered = await discoverCodexSessions(sessions);
  const head = discovered.find((session) => session.sourcePath.endsWith('rollout-late-head.jsonl'));
  const summary = discovered.find((session) => session.sourcePath.endsWith('rollout-late-summary.jsonl'));
  assert.ok(head);
  assert.ok(summary);
  assert.equal(head.recoveryReadiness, 'verified');
  assert.equal(summary.recoveryReadiness, 'pending');
  assert.equal(freezeBlockedReason(summary), undefined);
  assert.equal(head.availability, 'indexed');
  const importedLate = await importVerifiedSession(codexSessionAdapter, summary, lateSummary);
  assert.equal(importedLate.transcript.find((message) => message.role === 'user')?.text, 'After summary window.');
  const inspectedHead = await inspectCodexSession(lateHead);
  const inspectedSummary = await inspectCodexSession(lateSummary);
  assert.equal(inspectedHead.signals.userMessages, 1);
  assert.equal(inspectedSummary.signals.userMessages, 1);
  assert.equal(inspectedHead.transcript.find((message) => message.role === 'user')?.text, 'After head.');
  assert.equal(inspectedSummary.transcript.find((message) => message.role === 'user')?.text, 'After summary window.');
});

test('trailing invalid JSON is best-effort; interior invalid JSON is corrupt and keeps the prefix', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-jsonl-degrade-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const trailing = join(root, 'trailing.jsonl');
  const interior = join(root, 'interior.jsonl');
  await writeFile(trailing, `${meta()}\n${eventUser('Keep me.')}\n${eventAssistant('Done.')}\n${taskComplete()}\n{not json\n`);
  await writeFile(interior, `${meta()}\n${eventUser('Prefix user.')}\nnot-json\n${eventAssistant('After hole.')}\n${taskComplete()}\n`);
  const trailingWalk = await forEachJsonlRecordLenient(trailing, 'Codex', () => undefined);
  assert.equal(trailingWalk.truncated, true);
  assert.equal(trailingWalk.diagnostics.some((item) => item.code === 'truncated-tail'), true);
  const interiorWalk = await forEachJsonlRecordLenient(interior, 'Codex', () => undefined);
  assert.equal(interiorWalk.diagnostics.some((item) => item.code === 'invalid-jsonl'), true);
  const trailingInspect = await inspectCodexSession(trailing);
  const interiorInspect = await inspectCodexSession(interior);
  assert.equal(trailingInspect.recoveryReadiness, 'best-effort');
  assert.equal(interiorInspect.recoveryReadiness, 'corrupt');
  assert.equal(trailingInspect.signals.userMessages, 1);
  assert.equal(interiorInspect.signals.userMessages, 1);
  assert.equal(interiorInspect.transcript.some((message) => message.text === 'After hole.'), false);
  const listed = { productId: 'codex', sessionId: THREAD, sourcePath: trailing, availability: 'indexed' as const, evidenceLevel: 'transcript' as const, recoveryReadiness: trailingInspect.recoveryReadiness };
  const imported = await importVerifiedSession(codexSessionAdapter, listed, trailing);
  const frozen = await freezeCodexSession({ sourcePath: trailing, casesRoot: join(root, 'cases'), now: STARTED, privacy: PRIVACY });
  assert.equal(imported.recoveryReadiness, 'best-effort');
  assert.equal(frozen.taskCase.source.sessionId, THREAD);
  await assert.rejects(
    importVerifiedSession(codexSessionAdapter, { ...listed, sourcePath: interior, recoveryReadiness: 'corrupt' }, interior),
    (error: unknown) => error instanceof SessionReplayError && error.code === 'corrupt',
  );
});

test('strict JSONL walking still reports the physical line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-jsonl-strict-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, 'blank-lines.jsonl');
  await writeFile(path, `${JSON.stringify({ ok: true })}\n\n\n{not json}\n`);
  await assert.rejects(forEachJsonlRecord(path, 'Codex', () => undefined), /invalid JSONL at line 4/);
});

test('catalog metadata does not overlay a verified transcript, and mismatching session ids are rejected', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reprise-catalog-priority-'));
  t.after(async () => rm(home, { recursive: true, force: true }));
  const sessions = join(home, 'sessions');
  await mkdir(sessions);
  const file = join(sessions, 'rollout-verified.jsonl');
  await writeRollout(file, [meta(THREAD), eventUser('Verified task.'), eventAssistant('Done.'), taskComplete()]);
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, title TEXT, cwd TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(THREAD, file, 'Catalog title', 'C:\\catalog');
  db.close();
  const page = await codexSessionAdapter.discover({ root: sessions });
  const session = page.items.find((item) => item.sessionId === THREAD);
  assert.ok(session);
  assert.notEqual(session.availability, 'unreadable');
  assert.equal(session.recoveryReadiness, 'verified');
  assert.equal(session.signals.userMessages, 1);
  await assert.rejects(
    codexSessionAdapter.inspect({ productId: 'codex', sessionId: 'other-id', sourcePath: file }),
    /does not match/,
  );
  await assert.rejects(
    importVerifiedSession(codexSessionAdapter, { ...session, sessionId: 'other-id' }, file),
    /does not match/,
  );
});

test('no-user-input, catalog-only, and history-only stay non-replayable', () => {
  assert.equal(isEligibleSession({
    productId: 'codex', sessionId: 'x', sourcePath: 'a.jsonl',
    signals: { userMessages: 0, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    recoveryReadiness: 'no-user-input',
  }), false);
  assert.equal(freezeBlockedReason({
    availability: 'indexed', evidenceLevel: 'transcript', sourcePath: 'a.jsonl', recoveryReadiness: 'no-user-input',
  }), undefined);
  assert.equal(replayBlockedAfterInspect({
    availability: 'indexed', evidenceLevel: 'transcript', sourcePath: 'a.jsonl', recoveryReadiness: 'no-user-input',
  }), 'no-user-input');
  assert.equal(freezeBlockedReason({
    availability: 'catalog-only', evidenceLevel: 'transcript', sourcePath: 'C:/sessions/.catalog/id.jsonl',
  }), 'source-missing');
  assert.equal(freezeBlockedReason({
    availability: 'catalog-only', evidenceLevel: 'history', sourcePath: 'C:/history.jsonl#reprise-history=abc',
  }), 'history-only');
  assert.equal(listSummaryIncomplete({ recoveryReadiness: 'pending' }), true);
  assert.equal(listSummaryIncomplete({ partial: true }), true);
  assert.equal(listSummaryIncomplete({ recoveryReadiness: 'verified' }), false);
});

test('attemptSessionRecovery records recovered versus not-replayable outcomes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-attempt-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const file = join(root, 'rollout.jsonl');
  await writeRollout(file, [meta(), eventUser('Attempt me.'), eventAssistant('Done.'), taskComplete()]);
  const recovered = await attemptSessionRecovery(
    codexSessionAdapter,
    { productId: 'codex', sessionId: THREAD, sourcePath: file, availability: 'indexed', evidenceLevel: 'transcript' },
    file,
  );
  assert.equal(recovered.attempted, true);
  assert.equal(recovered.status, 'recovered');
  assert.ok(recovered.parsedMessageCount >= 2);
  assert.ok(recovered.imported);
});
