import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../src/core/schema.js';
import { matchesFilter } from '../src/tui/scrollback.js';
import { renderActors } from '../src/tui/pages/actors.js';
import { renderTimeline, runningChrome } from '../src/tui/pages/run.js';
import { createTheme } from '../src/tui/theme.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../src/tui/timeline.js';

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

test('consecutive recovery inspect tools merge and omit file bodies', () => {
  const timeline = collect([
    event('agent.tool_completed', { role: 'recovery', tool: 'read', params: { path: 'investigation.md' }, content: 'SECRET_BODY' }),
    event('agent.tool_completed', { role: 'recovery', tool: 'ls', params: { path: '.' } }),
    event('agent.tool_completed', { role: 'recovery', tool: 'read', params: { path: 'sessions.jsonl' }, content: 'MORE_SECRET' }),
  ]);
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0]?.title ?? '', /Recovery · inspect/);
  assert.match(visible[0]?.detail ?? '', /×3/);
  assert.doesNotMatch(JSON.stringify(visible), /SECRET_BODY|MORE_SECRET/);
});

test('controller read_observation is a controller voice and not a product voice', () => {
  const [entry] = projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read_observation',
    params: { source: 'transcript' },
  }));
  assert.equal(entry?.source, 'CONTROLLER');
  assert.equal(entry?.lane, 'controller');
  assert.ok(entry);
  assert.equal(matchesFilter(entry, 'ALL'), true);
  assert.equal(matchesFilter(entry, 'PRODUCT'), false);
  assert.equal(matchesFilter(entry, 'INPUT'), false);
});

test('controller decision stays separate from the delivered input', () => {
  const rows = projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
  }));
  assert.ok(rows[0] && rows[1]);
  assert.equal(matchesFilter(rows[0], 'ALL'), true);
  assert.equal(rows[0].title, 'Decision: SEND');
  assert.equal(rows[1].title, 'Input to Target');
  assert.equal(matchesFilter(rows[1], 'INPUT'), true);
  assert.equal(matchesFilter(rows[0], 'PRODUCT'), false);
});

test('comparison write report.html is visible on the summary lane', () => {
  const [entry] = projectTimelineEvent(event('agent.tool_called', {
    role: 'comparison',
    tool: 'write',
    params: { path: 'report.html' },
  }));
  assert.ok(entry);
  assert.match(entry.title, /Comparison · write/);
  assert.match(entry.detail ?? '', /report.html/);
  assert.equal(matchesFilter(entry, 'ALL'), true);
  assert.equal(matchesFilter(entry, 'PRODUCT'), false);
});

test('context compact folds into one compact row', () => {
  const timeline = collect([
    event('agent.context_compacted', { role: 'recovery', replaced: [{ toolName: 'read' }, { toolName: 'ls' }] }),
    event('agent.context_compacted', { role: 'recovery', replaced: [{ toolName: 'grep' }] }),
  ]);
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.equal(visible.length, 1);
  assert.match(visible[0]?.title ?? '', /compact/);
  assert.match(visible[0]?.detail ?? '', /×3/);
});

test('recovery canvas shows inspect activity instead of a candidate reply', () => {
  const theme = createTheme(120, false);
  const entries = collect([
    event('agent.tool_completed', { role: 'recovery', tool: 'ls', params: { path: '.' } }),
    event('agent.tool_called', { role: 'recovery', tool: 'powershell', params: { command: "Remove-Item -LiteralPath '.\\out.html'" } }),
  ]);
  const text = renderTimeline(theme, 120, {
    entries,
    selected: entries.length - 1, filter: 'ALL', following: true, cancelling: false,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
    runPhase: 'recovery',
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /恢复活动/);
  assert.match(text, /inspect|powershell|Remove-Item/);
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
    selected: 0, filter: 'ALL' as const, following: true, cancelling: false,
    currentState: 'finished' as const, elapsed: '07:08', turns: { used: 4 }, calls: { used: 2 }, detailExpanded: false,
    preparePhase: 'compare' as const,
    productLabel: 'Codex',
    locale: 'zh' as const,
  };
  const chrome = runningChrome(theme, 120, model).join('\n');
  const text = renderTimeline(theme, 120, model).join('\n');
  assert.match(chrome, /正在写对照报告/);
  assert.match(text, /report.html/);
  assert.match(text, /对照结论/);
});

test('actors overlay shows the current controller verb', () => {
  const theme = createTheme(80, false);
  const entries = collect([
    event('agent.tool_called', { role: 'controller', tool: 'read_observation', params: { source: 'run_events' } }),
  ]);
  const text = renderActors(theme, 56, {
    entries,
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_controller', elapsed: '00:12', turns: { used: 1 }, calls: { used: 1, max: 3 }, detailExpanded: false,
  }, 'zh').join('\n');
  assert.match(text, /read_observation|run_events/);
});
