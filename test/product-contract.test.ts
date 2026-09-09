import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema, type EventEnvelope } from '../src/core/schema.js';
import { freezeCase } from '../src/products/shared/freeze.js';
import { claudeCodeProductPack } from '../src/products/claude-code/pack.js';
import { PACK_API_MAJOR } from '../src/products/index.js';
import { codexProductPack } from '../src/products/codex/pack.js';
import type { CompleteProductPack, TargetActivity } from '../src/products/contract.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';
import { rankSessionFiles } from '../src/products/shared/session-files.js';

const packs: readonly CompleteProductPack[] = [codexProductPack, fakeProductPack, claudeCodeProductPack];

test('shared session ranking is newest-first with a stable path tie-breaker', () => {
  const ranked = rankSessionFiles([
    { path: 'b.jsonl', mtime: 10, size: 1 },
    { path: 'a.jsonl', mtime: 10, size: 1 },
    { path: 'c.jsonl', mtime: 11, size: 1 },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.path), ['c.jsonl', 'a.jsonl', 'b.jsonl']);
});

for (const pack of packs) {
  test(`${pack.manifest.productId} manifest is complete`, () => {
    assert.ok(pack.manifest.productId);
    assert.ok(pack.manifest.displayName);
    assert.ok(pack.manifest.packVersion);
    assert.equal(typeof pack.manifest.schemaVersion, 'number');
    assert.equal(pack.manifest.apiMajor, PACK_API_MAJOR);
    assert.deepEqual([...pack.manifest.capabilities], ['import', 'runtime']);
    assert.ok(pack.history);
    assert.ok(pack.runtime);
    assert.ok(pack.projection);
    assert.ok(pack.recoveryPlaybook().text);
    assert.ok(pack.defaultCandidate().productId === pack.manifest.productId);
    assert.equal(typeof pack.runtime.listCatalog, 'function');
  });
}

test('fake pack import freezes idempotently and redacts secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-freeze-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = await fakeProductPack.history.discover();
  const session = sessions.items[0];
  assert.ok(session);
  const imported = await fakeProductPack.history.import({
    productId: 'fake',
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
  });
  const first = await freezeCase(imported, root, { allowModelText: true, allowBinary: false, redactions: ['pong'] }, '2026-08-14T00:00:00.000Z');
  assert.ok(Value.Check(TaskCaseSchema, first.taskCase));
  assert.match(first.taskCase.initialInput.text, /\[REDACTED\]/);
  const second = await freezeCase(imported, root, { allowModelText: true, allowBinary: false, redactions: ['pong'] }, '2026-08-14T00:00:00.000Z');
  assert.equal(second.reused, true);
  assert.equal(second.taskCase.caseId, first.taskCase.caseId);
});

test('Claude pack import freezes idempotently through the shared path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-contract-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const cwd = join(root, 'project');
  const dir = join(root, 'sessions');
  await mkdir(dir, { recursive: true });
  const sourcePath = join(dir, `${sessionId}.jsonl`);
  await writeFile(sourcePath, [
    { type: 'user', sessionId, timestamp: '2026-08-14T00:00:00.000Z', cwd, message: { role: 'user', content: 'Create ping.txt with pong' } },
    { type: 'assistant', sessionId, timestamp: '2026-08-14T00:00:00.000Z', cwd, message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Created.' }], stop_reason: 'end_turn' } },
  ].map((row) => JSON.stringify(row)).join('\n'));
  const imported = await claudeCodeProductPack.history.import({ productId: 'claude-code', sessionId, sourcePath });
  const first = await freezeCase(imported, root, { allowModelText: true, allowBinary: false, redactions: ['pong'] }, '2026-08-14T00:00:00.000Z');
  assert.ok(Value.Check(TaskCaseSchema, first.taskCase));
  assert.match(first.taskCase.initialInput.text, /\[REDACTED\]/);
  const second = await freezeCase(imported, root, { allowModelText: true, allowBinary: false, redactions: ['pong'] }, '2026-08-14T00:00:00.000Z');
  assert.equal(second.reused, true);
});

test('activity other-kind share stays below the contract threshold', () => {
  const fakeEvents: EventEnvelope[] = [
    envelope('fake.message', { text: 'hello' }),
    envelope('fake.message', { text: 'world' }),
    envelope('fake.other', { label: 'note', body: 'rare' }),
  ];
  assert.ok(otherRatio(fakeEvents.flatMap((event) => fakeProductPack.projection.translate(event)).map((entry) => entry.activity)) < 0.4);
  const claudeEvents: EventEnvelope[] = [
    envelope('runtime.visible_output', {
      message: {
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'echo' } },
          { type: 'tool_use', id: '2', name: 'Write', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: '3', name: 'Task', input: {} },
          { type: 'tool_use', id: '4', name: 'CronCreate', input: {} },
          { type: 'tool_use', id: '5', name: 'Skill', input: {} },
        ],
      },
    }),
  ];
  assert.ok(otherRatio(claudeEvents.flatMap((event) => claudeCodeProductPack.projection.translate(event)).map((entry) => entry.activity)) < 0.4);
});

function otherRatio(activities: readonly TargetActivity[]): number {
  if (!activities.length) return 0;
  return activities.filter((activity) => activity.kind === 'other').length / activities.length;
}

function envelope(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: '2026-08-14T00:00:00.000Z',
    type,
    payload,
    checksum: 'a'.repeat(64),
  };
}
