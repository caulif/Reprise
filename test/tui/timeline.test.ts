import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import { appendTimelineEntries, projectPersistedTimeline, projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';

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
    hidden: true,
  });

  assert.deepEqual(projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Fix the failing test.' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'TARGET',
    title: 'Prompt · Fix the failing test.',
    detail: 'Fix the failing test.',
  });
  assert.equal(projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: 'Edit slides.html in the current directory.' }))[0]?.detail, 'Edit slides.html in the current directory.');
  assert.deepEqual(projectTimelineEvent(event('input.submitted', { turnIndex: 0 })), []);
  assert.equal(projectTimelineEvent(event('candidate.session_bound', { sessionId: 'sess-1', productId: 'fake' }))[0]?.title, 'Candidate session · sess-1');
  assert.equal(projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 1,
    status: 'completed',
    observedAt: timestamp,
    assistantText: 'Visible final answer.',
  }))[0]?.title, 'Visible response');

  assert.deepEqual(projectTimelineEvent(event('runtime.visible_output', {
    plan: [{ step: 'Inspect existing service', status: 'inProgress' }],
  })), []);

  const sent = projectTimelineEvent(event('controller.decision', {
    status: 'completed', sessionId: 'controller-1', value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
  }));
  assert.deepEqual(sent.map(({ title, detail }) => ({ title, detail })), [
    { title: 'Decision: SEND', detail: 'One check remains.' },
    { title: 'Input to Target', detail: 'Run the focused test.' },
  ]);

  const done = projectTimelineEvent(event('controller.decision', {
    status: 'completed', sessionId: 'controller-1', value: { type: 'done', reason: 'blocked', rationale: 'Sandbox denied the path.' },
  }))[0];
  assert.equal(done?.title, 'Decision: DONE · blocked');
  assert.equal(done?.detail, 'Sandbox denied the path.');
  assert.deepEqual(projectTimelineEvent(event('controller.decision', { status: 'failed', failure: { message: 'Model text is disallowed by TaskCase privacy policy.' } })), []);

  assert.equal(projectTimelineEvent(event('run.stop_requested', { code: 'blocked.controller_done', reason: 'failed' }))[0]?.title, 'Candidate stopped · blocked');
  assert.equal(projectTimelineEvent(event('run.stop_requested', { code: 'failed.controller', reason: 'failed' }))[0]?.title, 'Stop requested: failed');

  assert.deepEqual(projectTimelineEvent(event('controller.done', { reason: 'satisfied' }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Done: satisfied',
    hidden: true,
  });

  assert.deepEqual(projectTimelineEvent(event('comparison.completed', { status: 'failed', failure: { message: 'missing narrative' } }))[0], {
    sequence: 1,
    occurredAt: timestamp,
    source: 'CONTROLLER',
    title: 'Comparison failed',
    detail: 'missing narrative',
    level: 'error',
    lane: 'comparison',
    kind: 'deliver',
  });
});

test('official timeline consumes UserVisibleTurn instead of product payloads', () => {
  assert.deepEqual(projectTimelineEvent(event('runtime.visible_output', { item: { type: 'agentMessage', text: 'Visible final answer.' } })), []);
  assert.deepEqual(projectTimelineEvent(event('runtime.public_activity', {
    schemaVersion: 1,
    activity: { kind: 'message', text: 'must not appear' },
  })), []);
  const view = projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 1,
    status: 'completed',
    observedAt: timestamp,
    assistantText: 'Visible final answer.',
  }))[0];
  assert.equal(view?.title, 'Visible response');
  assert.equal(view?.detail, 'Visible final answer.');
  assert.equal(view?.hidden, undefined);
});

test('timeline keeps target stderr in the trace instead of the operator list', () => {
  assert.deepEqual(projectTimelineEvent(event('codex.codex.stderr', { line: 'windows sandbox: helper_unknown_error' })), []);
});

test('send and input.submitted keep one presented user sentence', () => {
  const timeline: TimelineEntry[] = [];
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: message })));
  const presented = timeline.filter((entry) => entry.title.startsWith('Input to Target') || entry.title.startsWith('Prompt ·'));
  assert.equal(presented.length, 1);
  assert.equal(presented[0]?.title, 'Input to Target');
});

test('recovery timeline keeps inspect, shell_exec, writes, and failures visible', () => {
  const listed = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'ls', params: { path: '.' } }))[0];
  const deleted = projectTimelineEvent(event('agent.tool_called', { role: 'recovery', tool: 'shell_exec', params: { command: 'Remove-Item ppt_build/out.pptx' } }))[0];
  const reported = projectTimelineEvent(event('agent.tool_completed', { role: 'recovery', tool: 'write', params: { path: 'recovery.md' } }))[0];
  const failed = projectTimelineEvent(event('agent.tool_failed', { role: 'recovery', tool: 'read_observation', message: 'tool budget exhausted' }))[0];
  assert.equal(listed?.hidden, undefined);
  assert.match(listed?.title ?? '', /Recovery · inspect/);
  assert.equal(deleted?.hidden, undefined);
  assert.match(deleted?.detail ?? '', /Remove-Item/);
  assert.equal(reported?.hidden, undefined);
  assert.match(reported?.detail ?? '', /recovery.md/);
  assert.equal(failed?.hidden, undefined);
  assert.equal(failed?.level, 'error');
  const duplicate = projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'ls',
    message: 'path not found',
  }))[0];
  assert.equal(duplicate?.hidden, undefined);
  assert.equal(duplicate?.level, 'error');
});

test('recovery timeline collapses identical consecutive tool failures', () => {
  const timeline: TimelineEntry[] = [];
  const message = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
  for (let index = 0; index < 34; index += 1) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'recovery',
      tool: 'shell_exec',
      message,
    })));
  }
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0]?.detail ?? '', / ×34$/);
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'shell_exec',
    message: 'Recovery tool-call budget of 64 was exhausted.',
  })));
  assert.equal(timeline.filter((entry) => !entry.hidden).length, 2);
});

test('shell_exec completion is visible when git reports the candidate is not a repository', () => {
  const entry = projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery',
    tool: 'shell_exec',
    content: 'fatal: not a git repository (or any of the parent directories): .git',
  }))[0];
  assert.equal(entry?.hidden, undefined);
  assert.match(entry?.detail ?? '', /不是 Git 仓库/);
});

test('recovery start does not show a source digest as timeline detail', () => {
  const started = projectTimelineEvent(event('recovery.started', {
    sourceDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }))[0];
  assert.equal(started?.title, 'Recovery started');
  assert.equal(started?.hidden, true);
  assert.equal(started?.detail, undefined);
  assert.doesNotMatch(JSON.stringify(started), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
});

test('persisted user view does not require the original pack at read time', () => {
  const timeline = projectPersistedTimeline([
    event('recovery.completed', { status: 'recovered' }),
    event('candidate.user_view_persisted', {
      turnIndex: 1,
      status: 'completed',
      observedAt: timestamp,
      assistantText: 'Visible reply from a missing pack.',
    }),
    event('run.outcome_created', {
      task: { status: 'apparently_completed', evidenceRefs: [] },
      termination: { kind: 'completed', code: 'completed.controller_done', initiatedBy: 'controller' },
      cleanup: { status: 'complete' },
    }),
  ]);
  assert.equal(timeline.some((entry) => entry.title === 'Recovery recovered'), true);
  assert.equal(timeline.some((entry) => entry.title === 'Visible response' && entry.detail === 'Visible reply from a missing pack.'), true);
  assert.equal(timeline.some((entry) => entry.title === 'Task · apparently_completed'), true);
  assert.equal(timeline.some((entry) => entry.title.startsWith('Termination · completed')), true);
  assert.equal(timeline.some((entry) => entry.title === 'Cleanup · complete'), true);
});
