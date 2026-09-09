import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/core/identity.js';
import { historicalRunStatus, readCommittedModelLog } from '../src/infrastructure/agent/history-read.js';

const occurredAt = '2026-09-08T00:00:00.000Z';

function line(sequence: number, type: string, payload: Record<string, unknown>): string {
  const body = { schemaVersion: 1, sequence, eventId: `event${sequence}`, occurredAt, type, payload };
  return `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`;
}

test('committed prefix is readable after a truncated tail and lock files do not decide run status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-history-read-'));
  try {
    const eventsPath = join(root, 'events.jsonl');
    await writeFile(eventsPath, `${line(1, 'run.attempt_created', { runId: 'run-1' })}${line(2, 'agent.session_started', { sessionId: 'session-1', role: 'recovery', systemPrompt: 'x', tools: [] })}{"schemaVersion":1`);
    await writeFile(join(root, 'writer.lock'), JSON.stringify({ pid: process.pid, host: 'other' }));
    const history = await readCommittedModelLog(eventsPath);
    assert.equal(history.diagnostic?.code, 'incomplete_tail');
    assert.equal(history.events.length, 2);
    assert.equal(history.runStatus, 'interrupted');
    assert.equal(historicalRunStatus(history.events), 'interrupted');
    assert.equal(historicalRunStatus([...history.events, {
      schemaVersion: 1,
      sequence: 3,
      eventId: 'event3',
      occurredAt,
      type: 'run.finished',
      payload: {},
      checksum: 'a'.repeat(64),
    }]), 'finished');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
