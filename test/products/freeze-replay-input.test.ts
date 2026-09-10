import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeCase } from '../../src/products/shared/freeze.js';
import { firstReplayUserMessage, looksLikeInjectedInstruction } from '../../src/products/shared/replay-user-input.js';
import type { ImportedSession, SessionMessage } from '../../src/products/contract.js';

const AGENTS = "# AGENTS.md\nFollow these rules. don't re-write it";
const TASK = 'Fix the login regression.';

function message(id: string, role: SessionMessage['role'], text: string): SessionMessage {
  return { id, role, text };
}

function imported(transcript: readonly SessionMessage[]): ImportedSession {
  const initial = transcript.find((item) => item.role === 'user');
  if (!initial) throw new Error('fixture has no user message');
  const users = transcript.filter((item) => item.role === 'user').length;
  const assistants = transcript.filter((item) => item.role === 'assistant').length;
  return {
    source: { productId: 'codex', sessionId: 'session-replay-input', sourcePath: 'session.jsonl' },
    initialInput: initial,
    transcript,
    historicalEvents: [],
    baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] },
    provenance: { packVersion: 'test' },
    raw: { relativePath: 'raw/session.jsonl', text: JSON.stringify(transcript) },
    diagnostics: [],
    signals: { userMessages: users, assistantMessages: assistants, toolCalls: 0, completedTurns: 1 },
  };
}

test('looksLikeInjectedInstruction matches AGENTS.md and instruction fences', () => {
  assert.equal(looksLikeInjectedInstruction(AGENTS), true);
  assert.equal(looksLikeInjectedInstruction('<INSTRUCTIONS>\nBe careful.'), true);
  assert.equal(looksLikeInjectedInstruction('<environment_context>\n<current_date>2026-08-30</current_date>'), true);
  assert.equal(looksLikeInjectedInstruction(TASK), false);
});

test('firstReplayUserMessage skips injected instruction blocks', () => {
  const transcript = [
    message('u1', 'user', AGENTS),
    message('a1', 'assistant', 'Loaded.'),
    message('u2', 'user', TASK),
  ];
  assert.equal(firstReplayUserMessage(transcript)?.id, 'u2');
});

test('firstReplayUserMessage falls back to the first user row when every user row looks injected', () => {
  const transcript = [message('u1', 'user', AGENTS), message('a1', 'assistant', 'Loaded.')];
  assert.equal(firstReplayUserMessage(transcript)?.id, 'u1');
});

test('freezeCase uses the first user task, not an injected AGENTS block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-replay-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = imported([
    message('u1', 'user', AGENTS),
    message('a1', 'assistant', 'Loaded.'),
    message('u2', 'user', TASK),
  ]);
  const first = await freezeCase(session, root, { allowModelText: true, allowBinary: false, redactions: [] }, '2026-08-31T00:00:00.000Z');
  assert.equal(first.reused, false);
  assert.equal(first.taskCase.initialInput.id, 'u2');
  assert.equal(first.taskCase.initialInput.text, TASK);
  const second = await freezeCase(session, root, { allowModelText: true, allowBinary: false, redactions: [] }, '2026-08-31T00:00:00.000Z');
  assert.equal(second.reused, true);
  assert.equal(second.taskCase.initialInput.id, 'u2');
});

test('freezeCase keeps the only user row when it is an instruction block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-replay-only-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = imported([message('u1', 'user', AGENTS), message('a1', 'assistant', 'Loaded.')]);
  const frozen = await freezeCase(session, root, { allowModelText: true, allowBinary: false, redactions: [] }, '2026-08-31T00:00:00.000Z');
  assert.equal(frozen.taskCase.initialInput.id, 'u1');
});

test('freezeCase rewrites a reused case whose initialInput is still the injected block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-replay-rewrite-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = imported([
    message('u1', 'user', AGENTS),
    message('a1', 'assistant', 'Loaded.'),
    message('u2', 'user', TASK),
  ]);
  const pinned = await freezeCase(
    session,
    root,
    { allowModelText: true, allowBinary: false, redactions: [] },
    '2026-08-31T00:00:00.000Z',
    { initialMessageId: 'u1' },
  );
  assert.equal(pinned.taskCase.initialInput.id, 'u1');
  const rewritten = await freezeCase(session, root, { allowModelText: true, allowBinary: false, redactions: [] }, '2026-08-31T00:00:00.000Z');
  assert.equal(rewritten.reused, false);
  assert.equal(rewritten.taskCase.initialInput.id, 'u2');
});
