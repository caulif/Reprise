import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isExcludedSession } from '../src/products/shared/session-exclusion.js';
import { claudeSessionAdapter } from '../src/products/claude-code/sessions.js';
import { codexSessionAdapter } from '../src/products/codex/sessions.js';
import { sessionDiscoveryQuery } from '../src/tui/controller-sessions.js';

const CODEX_ID = 'current-project-codex';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const RUNTIME_ID = '22222222-3333-4444-8555-666666666666';
const STARTED = '2026-08-14T00:00:00.000Z';

test('TUI discovery query excludes only the data directory, never process.cwd()', () => {
  const dataDir = resolve('C:/reprise-data');
  const query = sessionDiscoveryQuery({ root: resolve('C:/sessions'), dataDir });
  assert.deepEqual(query.excludeRoots, [dataDir]);
  assert.equal(query.excludeRoots?.includes(process.cwd()), false);
  assert.equal(query.excludeSessionIds, undefined);
});

test('cwd matching process.cwd() is not an exclusion key', () => {
  const cwd = process.cwd();
  const session = { sessionId: 'keep', sourcePath: 'C:/sessions/rollout-keep.jsonl' };
  assert.equal(isExcludedSession(session, { excludeRoots: [cwd] }, [cwd]), false);
});

test('excludeSessionIds and in-root excludeSourcePaths are exact; out-of-root paths are ignored', () => {
  const root = 'C:/sessions';
  const keep = { sessionId: 'keep', sourcePath: 'C:/sessions/keep.jsonl' };
  const drop = { sessionId: 'drop', sourcePath: 'C:/sessions/drop.jsonl' };
  assert.equal(isExcludedSession(drop, { excludeSessionIds: ['drop'] }, [root]), true);
  assert.equal(isExcludedSession(keep, { excludeSessionIds: ['drop'] }, [root]), false);
  assert.equal(isExcludedSession(drop, { excludeSourcePaths: ['C:/sessions/drop.jsonl'] }, [root]), true);
  assert.equal(isExcludedSession(keep, { excludeSourcePaths: ['C:/sessions/drop.jsonl'] }, [root]), false);
  assert.equal(isExcludedSession(drop, { excludeSourcePaths: ['C:/other/drop.jsonl'] }, [root]), false);
  assert.equal(isExcludedSession(drop, { excludeRoots: ['C:/sessions'] }, [root]), true);
});

test('Codex and Claude discovery return current-cwd history and only drop explicit runtime ids or source files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-discovery-cwd-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cwd = process.cwd();
  const dataDir = join(root, 'data');
  const nested = join(root, 'owned');
  await mkdir(dataDir);
  await mkdir(nested);
  const historicalCodex = join(root, 'rollout-historical.jsonl');
  const runtimeCodex = join(nested, 'rollout-runtime.jsonl');
  await writeFile(historicalCodex, codexRows(CODEX_ID, cwd));
  await writeFile(runtimeCodex, codexRows('runtime-codex', cwd));
  const historicalClaude = join(root, `${CLAUDE_ID}.jsonl`);
  const runtimeClaude = join(nested, `${RUNTIME_ID}.jsonl`);
  await writeFile(historicalClaude, claudeRows(CLAUDE_ID, cwd));
  await writeFile(runtimeClaude, claudeRows(RUNTIME_ID, cwd));

  const codexKept = await codexSessionAdapter.discover({
    root,
    excludeRoots: [dataDir],
  });
  assert.equal(codexKept.items.some((item) => item.sessionId === CODEX_ID && item.cwd === cwd), true);
  assert.equal(codexKept.items.some((item) => item.sessionId === 'runtime-codex'), true);

  const codexFiltered = await codexSessionAdapter.discover({
    root,
    excludeSessionIds: ['runtime-codex'],
    excludeSourcePaths: [runtimeCodex],
    excludeRoots: [dataDir],
  });
  assert.equal(codexFiltered.items.some((item) => item.sessionId === CODEX_ID), true);
  assert.equal(codexFiltered.items.some((item) => item.sessionId === 'runtime-codex'), false);

  const byRoot = await codexSessionAdapter.discover({ root, excludeRoots: [nested] });
  assert.equal(byRoot.items.some((item) => item.sessionId === CODEX_ID), true);
  assert.equal(byRoot.items.some((item) => item.sessionId === 'runtime-codex'), false);

  const claudeKept = await claudeSessionAdapter.discover({ root, excludeRoots: [dataDir] });
  assert.equal(claudeKept.items.some((item) => item.sessionId === CLAUDE_ID && item.cwd === cwd), true);
  assert.equal(claudeKept.items.some((item) => item.sessionId === RUNTIME_ID), true);

  const claudeFiltered = await claudeSessionAdapter.discover({
    root,
    excludeSessionIds: [RUNTIME_ID],
    excludeSourcePaths: [runtimeClaude],
  });
  assert.equal(claudeFiltered.items.some((item) => item.sessionId === CLAUDE_ID), true);
  assert.equal(claudeFiltered.items.some((item) => item.sessionId === RUNTIME_ID), false);
});

function codexRows(id: string, cwd: string): string {
  return [
    JSON.stringify({ timestamp: STARTED, type: 'session_meta', payload: { id, cwd } }),
    JSON.stringify({ timestamp: STARTED, type: 'event_msg', payload: { type: 'user_message', message: `Task ${id}` } }),
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
