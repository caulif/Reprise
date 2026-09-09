import test from 'node:test';
import assert from 'node:assert/strict';
import { isStructuredEnvelope, visibleAssistantText } from '../src/infrastructure/agent/assistant-visible.js';
import { matchesFilter, renderScrollback } from '../src/tui/scrollback.js';
import { renderTimeline } from '../src/tui/pages/run.js';
import { createTheme } from '../src/tui/theme.js';
import { paneOf, projectAssistantVisible, splitRunEntries } from '../src/tui/fold-process.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../src/tui/timeline.js';
import type { EventEnvelope } from '../src/core/schema.js';

const timestamp = '2026-09-02T12:00:00.000Z';

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

test('visible assistant text drops JSON envelopes and thinking-only content', () => {
  assert.equal(visibleAssistantText([{ type: 'text', text: '{"status":"recovered"}' }]), '');
  assert.equal(isStructuredEnvelope('{"type":"send","message":"hi"}'), true);
  assert.equal(visibleAssistantText([{ type: 'thinking', text: 'secret' }]), '');
  assert.match(visibleAssistantText([{ type: 'text', text: '先看隔离副本是不是仓库。' }]) ?? '', /隔离副本/);
  assert.equal(visibleAssistantText([{ type: 'text', text: '<think>hidden</think>{"type":"done","reason":"satisfied"}' }]), '');
});

test('assistant_visible is projected and Host does not invent narration', () => {
  const [row] = projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery',
    text: '先看隔离副本是不是仓库。',
    turn: 1,
  }));
  assert.equal(row?.kind, 'narrate');
  assert.match(row?.title ?? '', /隔离副本/);
  assert.equal(projectTimelineEvent(event('agent.message_appended', { role: 'recovery', byteLength: 12 })).length, 0);
});

test('right pane is product session, not Controller tools, and user text is input voice', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    params: { path: 'history/outline.tsv' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: 'Run the focused test.' },
  })));
  const { left, right } = splitRunEntries(timeline);
  assert.ok(left.some((entry) => entry.lane === 'controller' || entry.title.startsWith('Decision:')));
  assert.equal(right.some((entry) => entry.title.includes('outline') && entry.lane === 'controller' || entry.lane === 'controller' && entry.title.startsWith('Controller') && !entry.title.startsWith('Decision')), false);
  const input = right.find((entry) => entry.title.startsWith('Input to Target'))
    ?? left.find((entry) => entry.title.startsWith('Input to Target'));
  assert.ok(input);
  assert.equal(matchesFilter(input, 'INPUT'), true);
  assert.equal(matchesFilter(input, 'PRODUCT'), false);
  assert.equal(paneOf(input), 'both');
});

test('candidate canvas keeps Controller tools and delivered input on one column', () => {
  const theme = createTheme(120, false);
  const entries: TimelineEntry[] = [];
  appendTimelineEntries(entries, projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    params: { path: 'history/outline.tsv' },
  })));
  appendTimelineEntries(entries, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: 'Please run the tests.' },
  })));
  const text = renderTimeline(theme, 120, {
    entries,
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_controller', elapsed: '00:12', turns: { used: 1 }, calls: { used: 1 }, detailExpanded: false,
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /Please run the tests|请/);
  const projected = projectAssistantVisible({ role: 'controller', text: '先看候选有没有跑测试。' });
  assert.equal(projected.extra.lane, 'controller');
});

test('scrollback does not reprint the same delivered sentence', () => {
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  const theme = createTheme(80, false);
  const painted = renderScrollback(theme, 80, [
    { sequence: 1, occurredAt: timestamp, source: 'CONTROLLER', title: 'Input to Target', detail: message },
    { sequence: 2, occurredAt: timestamp, source: 'TARGET', title: `Prompt · ${message}`, detail: message },
  ], 0, 'zh', 'Claude Code').join('\n');
  assert.equal(painted.split(message).length - 1, 1);
});
