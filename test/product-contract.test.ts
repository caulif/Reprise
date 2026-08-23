import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema, type EventEnvelope } from '../src/core/schema.js';
import { freezeCase } from '../src/products/shared/freeze.js';
import { claudeCodeProductPack } from '../src/products/claude-code/pack.js';
import { codexProductPack } from '../src/products/codex/pack.js';
import type { ProductPack, TargetActivity } from '../src/products/contract.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';

const packs: readonly ProductPack[] = [codexProductPack, fakeProductPack, claudeCodeProductPack];

for (const pack of packs) {
  test(`${pack.manifest.productId} manifest is complete`, () => {
    assert.ok(pack.manifest.productId);
    assert.ok(pack.manifest.displayName);
    assert.ok(pack.manifest.packVersion);
    assert.equal(typeof pack.manifest.schemaVersion, 'number');
    assert.ok(pack.sessions);
    assert.ok(pack.runtime);
    assert.ok(pack.activity);
    assert.ok(pack.recoveryPlaybook().text);
    assert.ok(pack.defaultCandidate().productId === pack.manifest.productId);
  });
}

test('fake pack import freezes idempotently and redacts secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-freeze-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = await fakeProductPack.sessions.discover();
  const session = sessions.items[0];
  assert.ok(session);
  const imported = await fakeProductPack.sessions.import({
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
  const imported = await claudeCodeProductPack.sessions.import({ productId: 'claude-code', sessionId, sourcePath });
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
  assert.ok(otherRatio(fakeEvents.flatMap((event) => fakeProductPack.activity.translate(event)).map((entry) => entry.activity)) < 0.4);
  const claudeEvents: EventEnvelope[] = [
    envelope('claude-code.assistant', {
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
  assert.ok(otherRatio(claudeEvents.flatMap((event) => claudeCodeProductPack.activity.translate(event)).map((entry) => entry.activity)) < 0.4);
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
