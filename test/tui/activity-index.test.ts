import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import {
  activeNodes,
  createActivityIndex,
  historyNodes,
  ingestActivityEvent,
  resetActivityIndex,
} from '../../src/tui/activity-index.js';
import {
  appendProjectedEvent,
  appendTimelineEntries,
  projectPersistedTimeline,
  projectTimelineEvent,
  type TimelineEntry,
} from '../../src/tui/timeline.js';

const timestamp = '2026-09-20T06:00:00.000Z';

function event(type: string, payload: unknown, extras: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: extras.sequence ?? 1,
    eventId: extras.eventId ?? `event-${extras.sequence ?? 1}`,
    occurredAt: extras.occurredAt ?? timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
    ...(extras.runId ? { runId: extras.runId } : {}),
  };
}

test('T04 R07: two deliveries with identical text stay distinct', () => {
  const timeline: TimelineEntry[] = [];
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  for (const turn of [0, 1]) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
      status: 'completed',
      value: { type: 'send', message },
    }, { sequence: turn * 2 + 1, eventId: `send-${turn}` })));
    appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', {
      turnIndex: turn,
      clientMessageId: `client-${turn}`,
      text: message,
    }, { sequence: turn * 2 + 2, eventId: `input-${turn}` })));
  }
  const presented = timeline.filter((entry) =>
    entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·'));
  assert.equal(presented.length, 2);
  assert.equal(presented[0]?.deliveryPaired, true);
  assert.equal(presented[1]?.deliveryPaired, true);
  assert.notEqual(presented[0]?.deliveryId, presented[1]?.deliveryId);
});

test('T04 R05: collapsed identical failures keep one eventRef per occurrence', () => {
  const timeline: TimelineEntry[] = [];
  const message = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
  for (let index = 0; index < 5; index += 1) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'recovery',
      tool: 'shell_exec',
      message,
    }, { sequence: index + 1, eventId: `fail-${index}` })));
  }
  const failed = timeline.filter((entry) => !entry.hidden && entry.level === 'error');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.eventRefs?.length, 5);
  assert.equal(failed[0]?.count, 5);
  assert.match(failed[0]?.detail ?? '', / ×5$/);
});

test('T04 R06: toolCallId pairs started/completed; missing id stays linkUnknown', () => {
  const index = createActivityIndex();
  ingestActivityEvent(index, event('agent.tool_called', {
    role: 'comparison',
    tool: 'read',
    toolCallId: 'call-a',
    sessionId: 'sess',
    invocationId: 'inv-1',
    params: { path: 'a.md' },
  }, { sequence: 1, eventId: 'start-a' }));
  ingestActivityEvent(index, event('agent.tool_called', {
    role: 'comparison',
    tool: 'read',
    toolCallId: 'call-b',
    sessionId: 'sess',
    invocationId: 'inv-1',
    params: { path: 'b.md' },
  }, { sequence: 2, eventId: 'start-b' }));
  assert.equal(activeNodes(index).length, 2);
  ingestActivityEvent(index, event('agent.tool_completed', {
    role: 'comparison',
    tool: 'read',
    toolCallId: 'call-a',
    sessionId: 'sess',
    invocationId: 'inv-1',
    params: { path: 'a.md' },
  }, { sequence: 3, eventId: 'end-a' }));
  const stillActive = activeNodes(index);
  assert.equal(stillActive.length, 1);
  assert.equal(stillActive[0]?.correlationKey?.includes('call-b'), true);
  const failed = ingestActivityEvent(index, event('agent.tool_failed', {
    role: 'comparison',
    tool: 'read',
    message: 'path not found',
  }, { sequence: 4, eventId: 'fail-orphan' }));
  assert.equal(failed?.linkUnknown, true);
  assert.equal(failed?.identity.startsWith('orphan-fail:'), true);
});

test('T04 duplicate eventId is idempotent and replay matches live append', () => {
  const liveIndex = createActivityIndex({ experimentId: 'exp-1' });
  const live: TimelineEntry[] = [];
  const events = [
    event('candidate.session_bound', { sessionId: 'sess-42', productId: 'fake' }, { sequence: 1, eventId: 'bound' }),
    event('agent.tool_called', {
      role: 'recovery', tool: 'ls', toolCallId: 't1', params: { path: '.' },
    }, { sequence: 2, eventId: 'tool-1' }),
    event('agent.tool_called', {
      role: 'recovery', tool: 'ls', toolCallId: 't1', params: { path: '.' },
    }, { sequence: 2, eventId: 'tool-1' }),
  ];
  for (const item of events) appendProjectedEvent(live, item, liveIndex);
  assert.equal(liveIndex.seenEventIds.size, 2);
  assert.equal(activeNodes(liveIndex).length, 1);

  const replayIndex = createActivityIndex({ experimentId: 'exp-1' });
  const replay = projectPersistedTimeline(events, replayIndex);
  assert.equal(replayIndex.seenEventIds.size, 2);
  assert.deepEqual(
    live.filter((row) => row.sessionId).map((row) => row.sessionId),
    replay.filter((row) => row.sessionId).map((row) => row.sessionId),
  );
  assert.equal(replay.find((row) => row.sessionId)?.sessionId, 'sess-42');
});

test('T04 reset scope clears active/flush identity between experiments', () => {
  const index = createActivityIndex({ experimentId: 'exp-a' });
  ingestActivityEvent(index, event('agent.tool_called', {
    role: 'recovery', tool: 'read', toolCallId: 'shared', params: { path: 'x' },
  }, { sequence: 1, eventId: 'a1' }));
  assert.equal(activeNodes(index).length, 1);
  resetActivityIndex(index, { experimentId: 'exp-b' });
  assert.equal(activeNodes(index).length, 0);
  assert.equal(historyNodes(index).length, 0);
  assert.equal(index.scope.experimentId, 'exp-b');
  assert.equal(index.revision, 0);
});

test('T04 structured sessionId survives candidate.session_bound projection', () => {
  const [row] = projectTimelineEvent(event('candidate.session_bound', {
    sessionId: 'structured-sess',
    productId: 'fake',
  }, { sequence: 1, eventId: 'bound' }));
  assert.equal(row?.sessionId, 'structured-sess');
  assert.equal(row?.eventType, 'candidate.session_bound');
  assert.equal(row?.eventRefs?.[0]?.eventId, 'bound');
});

test('T04 H1: candidateSessionId ignores later agent Host sessionId', () => {
  const timeline: TimelineEntry[] = [];
  const index = createActivityIndex();
  appendProjectedEvent(timeline, event('candidate.session_bound', {
    sessionId: 'candidate-sess',
    productId: 'fake',
  }, { sequence: 1, eventId: 'bound' }), index);
  appendProjectedEvent(timeline, event('agent.tool_called', {
    role: 'recovery',
    sessionId: 'agent-host-sess',
    tool: 'read',
    toolCallId: 't1',
    params: { path: 'x.md' },
  }, { sequence: 2, eventId: 'tool' }), index);
  assert.equal(timeline.at(-1)?.sessionId, undefined);
  assert.equal(timeline.find((row) => row.eventType === 'candidate.session_bound')?.sessionId, 'candidate-sess');
  // Mirrors candidateSessionIdFrom: only session_bound eventType, never latest arbitrary sessionId.
  let picked: string | undefined;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const entry = timeline[i];
    if (entry?.eventType === 'candidate.session_bound' && entry.sessionId) {
      picked = entry.sessionId;
      break;
    }
  }
  assert.equal(picked, 'candidate-sess');
  assert.notEqual(picked, 'agent-host-sess');
});

test('T04 H2: orphan tool_failed then invocation end does not complete in-flight starts', () => {
  const index = createActivityIndex();
  ingestActivityEvent(index, event('agent.tool_called', {
    role: 'recovery',
    tool: 'read',
    toolCallId: 'still-open',
    sessionId: 'sess',
    invocationId: 'inv-1',
    params: { path: 'a.md' },
  }, { sequence: 1, eventId: 'start' }));
  ingestActivityEvent(index, event('agent.tool_failed', {
    role: 'recovery',
    tool: 'read',
    message: 'boom',
  }, { sequence: 2, eventId: 'orphan-fail' }));
  assert.equal(activeNodes(index).length, 1);
  ingestActivityEvent(index, event('agent.invocation_failed', {
    role: 'recovery',
    sessionId: 'sess',
    invocationId: 'inv-1',
  }, { sequence: 3, eventId: 'inv-fail' }));
  assert.equal(activeNodes(index).length, 0);
  const sealed = historyNodes(index);
  const started = sealed.find((node) => node.correlationKey?.includes('still-open'));
  const orphan = sealed.find((node) => node.identity.startsWith('orphan-fail:'));
  assert.equal(orphan?.status, 'failed');
  assert.equal(started?.status, 'failed');
  assert.notEqual(started?.status, 'completed');
});

test('T04 index composite correlationId is stamped onto timeline entries', () => {
  const timeline: TimelineEntry[] = [];
  const index = createActivityIndex();
  appendProjectedEvent(timeline, event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    toolCallId: 'raw-id',
    sessionId: 'sess',
    invocationId: 'inv',
    params: { path: 'brief.md' },
  }, { sequence: 1, eventId: 't1' }), index);
  const live = timeline.find((row) => row.kind === 'live' || row.itemId === 'now:controller');
  assert.ok(live?.correlationId?.startsWith('tool:controller:'));
  assert.match(live?.correlationId ?? '', /raw-id$/);
  assert.notEqual(live?.correlationId, 'raw-id');
});
