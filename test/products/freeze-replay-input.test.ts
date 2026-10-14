import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/core/identity.js';
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

test('freezeCase preserves a published instruction selection when automatic task selection changes', async (t) => {
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
  const caseDir = join(root, pinned.taskCase.caseId);
  const before = await frozenHashes(caseDir);
  await assert.rejects(freezeCase(session, root, PRIVACY, NOW), /conflicts with the selected task/);
  assert.deepEqual(await frozenHashes(caseDir), before);
});

const PRIVACY = { allowModelText: true, allowBinary: false, redactions: [] };
const NOW = '2026-10-14T00:00:00.000Z';

async function frozenHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, hash] of Object.entries(await frozenHashes(join(directory, entry.name)))) {
        hashes[`${entry.name}/${path}`] = hash;
      }
    } else hashes[entry.name] = sha256(await readFile(join(directory, entry.name)));
  }
  return hashes;
}

test('different selected user input refuses replacement before any injected write failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-preserve-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const session = imported([message('u1', 'user', 'First task'), message('u2', 'user', 'Second task')]);
  const first = await freezeCase(session, root, PRIVACY, NOW, { initialMessageId: 'u1' });
  const caseDir = join(root, first.taskCase.caseId);
  const before = await frozenHashes(caseDir);
  let writes = 0;
  await assert.rejects(freezeCase(session, root, PRIVACY, NOW, {
    initialMessageId: 'u2', write: async () => { writes++; throw new Error('Injected write failure'); },
  }), /conflicts with the selected task/);
  assert.equal(writes, 0);
  assert.deepEqual(await frozenHashes(caseDir), before);
  const again = await freezeCase(session, root, PRIVACY, '2026-10-15T00:00:00.000Z', { initialMessageId: 'u1' });
  assert.equal(again.reused, true);
  assert.deepEqual(again.taskCase, first.taskCase);
  assert.deepEqual(await frozenHashes(caseDir), before);
});

for (const variant of ['invalid-json', 'invalid-structure', 'future-version', 'wrong-case-id', 'wrong-source', 'wrong-hash', 'wrong-text', 'wrong-privacy', 'missing-marker'] as const) {
  test(`freeze refuses ${variant} existing case and preserves all original bytes`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'reprise-freeze-invalid-'));
    t.after(async () => rm(root, { recursive: true, force: true }));
    const session = imported([message('u1', 'user', TASK)]);
    const first = await freezeCase(session, root, PRIVACY, NOW);
    const caseDir = join(root, first.taskCase.caseId);
    const existing = structuredClone(first.taskCase);
    if (variant === 'future-version') existing.schemaVersion = 2;
    if (variant === 'wrong-case-id') existing.caseId = 'case-other';
    if (variant === 'wrong-source') existing.source.sessionId = 'other';
    if (variant === 'wrong-hash') existing.contentHash = 'f'.repeat(64);
    if (variant === 'wrong-text') existing.initialInput.text = 'Changed';
    if (variant === 'wrong-privacy') existing.privacy.allowBinary = true;
    const text = variant === 'invalid-json' ? '{' : variant === 'invalid-structure' ? '{}' : JSON.stringify(existing);
    await writeFile(join(caseDir, 'case.json'), text);
    if (variant === 'missing-marker') await rm(join(caseDir, 'case.complete'));
    const before = await frozenHashes(caseDir);
    await assert.rejects(freezeCase(session, root, PRIVACY, NOW), /Existing case cannot be safely reused/);
    assert.deepEqual(await frozenHashes(caseDir), before);
    assert.deepEqual(await readdir(root), [first.taskCase.caseId]);
  });
}
