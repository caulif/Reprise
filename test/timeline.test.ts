import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../src/core/schema.js';
import { projectTimelineEvent } from '../src/tui/timeline.js';

const timestamp = '2026-08-10T11:33:12.000Z';

function event(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

test('timeline projects operator-relevant persisted facts', () => {
  assert.deepEqual(projectTimelineEvent(event('run.state_changed', { from: 'created', to: 'preparing' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'HARNESS',
    title: 'State: created → preparing',
  });

  const plan = projectTimelineEvent(event('codex.turn_plan_updated', {
    plan: [{ step: 'Inspect existing service', status: 'inProgress' }, { step: 'Run tests', status: 'pending' }],
  }))[0];
  assert.equal(plan?.source, 'TARGET');
  assert.equal(plan?.detail, 'inProgress · Inspect existing service\npending · Run tests');

  const sent = projectTimelineEvent(event('controller.decision', {
    status: 'completed', sessionId: 'controller-1', value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
  }));
  assert.deepEqual(sent.map(({ title, detail }) => ({ title, detail })), [
    { title: 'Decision: SEND', detail: 'One check remains.' },
    { title: 'Input to Target', detail: 'Run the focused test.' },
  ]);

  assert.deepEqual(projectTimelineEvent(event('controller.done', { reason: 'satisfied' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Done: satisfied',
  });

  assert.deepEqual(projectTimelineEvent(event('comparison.completed', { status: 'failed', failure: { message: 'missing narrative' } }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Comparison failed',
    detail: 'missing narrative',
    level: 'warning',
  });
});

test('timeline keeps useful completed target items and drops unavailable reasoning and deltas', () => {
  assert.deepEqual(projectTimelineEvent(event('codex.item_commandExecution_outputDelta', { delta: 'noise' })), []);
  assert.deepEqual(projectTimelineEvent(event('codex.item_completed', { item: { type: 'reasoning', summary: [], content: [] } })), []);

  const command = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: 'one\ntwo\nthree\nfour\nfive\nsix\nseven' },
  }))[0];
  assert.equal(command?.title, 'Command completed');
  assert.equal(command?.detail, 'npm test\none\ntwo\nthree\nfour\nfive\nsix\nseven');

  const longCommandOutput = `${Array.from({ length: 200 }, (_, index) => `public output ${index + 1}`).join('\n')}\nCOMMAND_OUTPUT_END`;
  const fullCommand = projectTimelineEvent(event('codex.item_completed', {
    item: { type: 'commandExecution', command: 'npm test', status: 'completed', aggregatedOutput: longCommandOutput },
  }))[0];
  assert.equal(fullCommand?.detail, `npm test\n${longCommandOutput}`);

  const response = projectTimelineEvent(event('codex.item_completed', { item: { type: 'agentMessage', text: 'Visible final answer.' } }))[0];
  assert.equal(response?.title, 'Visible response');
  assert.equal(response?.detail, 'Visible final answer.');
});
