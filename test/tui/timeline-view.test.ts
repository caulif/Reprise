import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import { createTheme } from '../../src/tui/theme.js';
import { renderTimeline } from '../../src/tui/pages/run.js';
import { matchesFilter } from '../../src/tui/scrollback.js';
import { projectTimelineView } from '../../src/tui/timeline-view.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';

const timestamp = '2026-09-19T12:00:00.000Z';

function event(type: string, payload: unknown, sequence = 1): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    occurredAt: timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

function visibleOf(timeline: readonly TimelineEntry[]): TimelineEntry[] {
  return timeline.filter((entry) => !entry.hidden && matchesFilter(entry, 'ALL'));
}

test('candidate live probe is tip-only: latest tip plus one fold count', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: '在吗' }, 1)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_started', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
    live: { schemaVersion: 1, verb: 'read', leaf: 'a.md' },
  }, 2)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_finished', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
  }, 3)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_started', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
    live: { schemaVersion: 1, verb: 'read', leaf: 'b.md' },
  }, 4)));

  const visible = visibleOf(timeline);
  const projected = projectTimelineView(timeline, visible, new Set());
  const thinking = projected.filter((entry) => entry.kind === 'thinking');
  assert.equal(thinking.length, 1);
  assert.deepEqual(thinking.map((entry) => entry.detail), ['b.md']);
  assert.ok(thinking.every((entry) => matchesFilter(entry, 'ALL')));
  assert.ok(projected.some((entry) => entry.kind === 'fold' && entry.title === '▸ 阅读证据 · 2'));
  assert.equal(projected.some((entry) => entry.itemId === 'now:target'), true);

  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: visible,
    sourceTimeline: timeline,
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:12', turns: { used: 1 }, calls: { used: 1 },
    productLabel: 'Claude Code',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /b\.md/);
  assert.match(painted, /▸ 阅读证据 · 2/);
  assert.equal((painted.match(/阅读 a\.md/g) ?? []).length, 0);
});

test('candidate thinking chain collapses after the turn settles', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: '在吗' }, 1)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_started', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
    live: { schemaVersion: 1, verb: 'read', leaf: 'a.md' },
  }, 2)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_finished', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
  }, 3)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_started', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
    live: { schemaVersion: 1, verb: 'read', leaf: 'b.md' },
  }, 4)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 0, status: 'completed', observedAt: timestamp, assistantText: '看过了。',
  }, 5)));

  const visible = visibleOf(timeline);
  const projected = projectTimelineView(timeline, visible, new Set());
  assert.equal(projected.some((entry) => entry.kind === 'thinking'), false);
  assert.ok(projected.some((entry) => entry.kind === 'fold' && entry.title === '▸ 阅读证据 · 2'));
  assert.equal(projected.some((entry) => entry.itemId === 'now:target' && !entry.hidden), false);
});

test('recovery probe chain is tip-only while live and folds after the next sentence', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '先看索引。',
  }, 1)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'INDEX.md' },
  }, 2)));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'session.json' },
  }, 3)));

  const visible = visibleOf(timeline);
  const projected = projectTimelineView(timeline, visible, new Set());
  const thinking = projected.filter((entry) => entry.kind === 'thinking');
  assert.deepEqual(thinking.map((entry) => entry.detail), ['session.json']);
  assert.equal(thinking.length, 1);
  assert.ok(thinking.every((entry) => matchesFilter(entry, 'ALL')));
  assert.ok(projected.some((entry) => entry.kind === 'fold' && entry.title === '▸ 阅读证据 · 2'));

  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: visible,
    sourceTimeline: timeline,
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    runPhase: 'recovery',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /session\.json/);
  assert.match(painted, /▸ 阅读证据 · 2/);
  assert.equal((painted.match(/阅读 INDEX\.md/g) ?? []).length, 0);

  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '接着写报告。',
  }, 4)));
  const endedVisible = visibleOf(timeline);
  const ended = projectTimelineView(timeline, endedVisible, new Set());
  assert.equal(ended.some((entry) => entry.kind === 'thinking'), false);
  assert.ok(ended.some((entry) => entry.kind === 'fold' && entry.title === '▸ 阅读证据 · 2'));
});

test('recovery historical tool spam is not painted as peer L2 rows', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: 'I will start by reading the task text.',
  }, 1)));
  const leaves = [
    'initial-input.txt', 'playbook.md', 'INDEX.md', 'source-summary.json',
    'tool-14.json', 'history-0-9d3563dcf314e314.json', 'history-3-b9e634df.json',
  ];
  for (const [index, leaf] of leaves.entries()) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
      role: 'recovery', tool: 'read', params: { path: leaf },
    }, index + 2)));
  }

  const visible = visibleOf(timeline);
  const projected = projectTimelineView(timeline, visible, new Set());
  const thinking = projected.filter((entry) => entry.kind === 'thinking');
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.detail, 'history-3-b9e634df.json');
  assert.equal(projected.filter((entry) => entry.kind === 'fold' && entry.itemId?.startsWith('live-fold:')).length, 1);
  assert.equal(projected.find((entry) => entry.itemId?.startsWith('live-fold:'))?.title, `▸ 阅读证据 · ${leaves.length}`);

  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: visible,
    sourceTimeline: timeline,
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: undefined, elapsed: '00:48', turns: { used: 0 }, calls: { used: 0 },
    runPhase: 'recovery',
    locale: 'zh',
  }).join('\n');
  for (const leaf of leaves.slice(0, -1)) {
    assert.equal((painted.match(new RegExp(`阅读 ${leaf.replace(/\./g, '\\.')}`, 'g')) ?? []).length, 0, leaf);
  }
  assert.match(painted, /阅读 history-3-b9e634df\.json/);
  assert.match(painted, new RegExp(`▸ 阅读证据 · ${leaves.length}`));
});
