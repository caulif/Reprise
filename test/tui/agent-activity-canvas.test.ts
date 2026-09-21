import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import { matchesFilter } from '../../src/tui/scrollback.js';
import { lastLiveVerb } from '../../src/tui/agent-activity.js';
import { renderTimeline, runningChrome } from '../../src/tui/pages/run.js';
import { createTheme } from '../../src/tui/theme.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';

const timestamp = '2026-09-01T11:00:00.000Z';

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

function collect(events: readonly EventEnvelope[]): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  for (const item of events) appendTimelineEntries(timeline, projectTimelineEvent(item));
  return timeline;
}

test('consecutive recovery inspect tools stay off the settled column', () => {
  const timeline = collect([
    event('agent.tool_completed', { role: 'recovery', tool: 'read', params: { path: 'investigation.md' }, content: 'SECRET_BODY' }),
    event('agent.tool_completed', { role: 'recovery', tool: 'ls', params: { path: '.' } }),
    event('agent.tool_completed', { role: 'recovery', tool: 'read', params: { path: 'sessions.jsonl' }, content: 'MORE_SECRET' }),
  ]);
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.filter((entry) => entry.kind === 'investigate').length, 0);
  assert.ok(visible.some((entry) => entry.kind === 'live'));
  assert.doesNotMatch(JSON.stringify(visible), /SECRET_BODY|MORE_SECRET/);
});

test('controller read is a controller voice and not a product voice', () => {
  const [entry] = projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    params: { path: 'history/initial-input.txt' },
  }));
  assert.equal(entry?.source, 'CONTROLLER');
  assert.equal(entry?.lane, 'controller');
  assert.ok(entry);
  assert.equal(matchesFilter(entry, 'ALL'), true);
  assert.equal(matchesFilter(entry, 'PRODUCT'), false);
  assert.equal(matchesFilter(entry, 'INPUT'), false);
});

test('controller decision is the delivered input', () => {
  const rows = projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
  })).filter((entry) => !entry.hidden);
  assert.ok(rows[0]);
  assert.equal(matchesFilter(rows[0], 'ALL'), true);
  assert.match(rows[0].title, /Input to Target/);
  assert.equal(matchesFilter(rows[0], 'INPUT'), true);
  assert.equal(matchesFilter(rows[0], 'PRODUCT'), false);
});

test('comparison write report.html is visible on the summary lane', () => {
  const [entry] = projectTimelineEvent(event('agent.tool_called', {
    role: 'comparison',
    tool: 'write',
    params: { path: 'report.html' },
  }));
  assert.ok(entry);
  assert.match(entry.title, /写入/);
  assert.match(entry.detail ?? '', /report.html/);
  assert.equal(matchesFilter(entry, 'ALL'), true);
  assert.equal(matchesFilter(entry, 'PRODUCT'), false);
});

test('context compact stays off the main column', () => {
  const timeline = collect([
    event('agent.context_compacted', { role: 'recovery', summary: 'a', tokensBefore: 1000, retainedCount: 2 }),
    event('agent.context_compacted', { role: 'recovery', summary: 'b', tokensBefore: 2000, retainedCount: 1 }),
  ]);
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 0);
});

test('recovery canvas shows inspect activity instead of a candidate reply', () => {
  const theme = createTheme(120, false);
  const entries = collect([
    event('agent.tool_completed', { role: 'recovery', tool: 'ls', params: { path: '.' } }),
    event('agent.tool_called', { role: 'recovery', tool: 'shell_exec', params: { command: "Remove-Item -LiteralPath '.\\out.html'" } }),
  ]);
  const text = renderTimeline(theme, 120, {
    entries,
    selected: entries.length - 1, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    runPhase: 'recovery',
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /恢复/);
  assert.doesNotMatch(text, /调查 →/);
  assert.doesNotMatch(text, /发给 Codex/);
  assert.doesNotMatch(text, /正在写回复/);
});

test('comparison header does not keep the candidate turn chrome', () => {
  const theme = createTheme(120, false);
  const entries = collect([
    event('agent.tool_called', { role: 'comparison', tool: 'write', params: { path: 'report.html' } }),
  ]);
  const model = {
    entries,
    selected: 0, filter: 'ALL' as const, following: true, cancelUi: 'idle' as const,
    currentState: 'finished' as const, elapsed: '07:08', turns: { used: 4 }, calls: { used: 2 },
    preparePhase: 'compare' as const,
    productLabel: 'Codex',
    locale: 'zh' as const,
  };
  const chrome = runningChrome(theme, 120, model).join('\n');
  const text = renderTimeline(theme, 120, model).join('\n');
  assert.match(chrome, /正在写对照报告/);
  assert.match(text, /report.html/);
  assert.doesNotMatch(chrome, /第 4 轮/);
});

test('controller inspect live verb is readable from the activity canvas', () => {
  const entries = collect([
    event('agent.tool_called', { role: 'controller', tool: 'read', params: { path: 'history/outline.tsv' } }),
  ]);
  assert.match(lastLiveVerb(entries) ?? '', /阅读|read|outline/);
});


