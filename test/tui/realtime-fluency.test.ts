import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { IntakeTui_visibleTimeline } from '../../src/tui/intake-tui-nav.js';
import type { IntakeTui } from '../../src/tui/intake-tui.js';
import { foldProcessEntries, resetFoldProcessCache } from '../../src/tui/fold-process.js';
import { layoutScrollback, resetScrollbackLayoutCache } from '../../src/tui/scrollback.js';
import { createTheme } from '../../src/tui/theme.js';
import type { TimelineRevisionState } from '../../src/tui/timeline-revision.js';
import { appendTimelineEntries, projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';

function event(type: string, payload: unknown, sequence = 1) {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    occurredAt: '2026-08-11T00:00:00.000Z',
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

function sampleEntries(): TimelineEntry[] {
  return [
    {
      sequence: 1,
      occurredAt: '2026-08-11T00:00:00.000Z',
      source: 'CONTROLLER',
      title: 'Prompt · Fix the failing test',
      kind: 'narrate',
      detail: 'Fix the failing test',
    },
    {
      sequence: 2,
      occurredAt: '2026-08-11T00:00:01.000Z',
      source: 'TARGET',
      title: 'Visible response',
      kind: 'narrate',
      detail: 'public response line 1',
    },
    {
      sequence: 3,
      occurredAt: '2026-08-11T00:00:02.000Z',
      source: 'TARGET',
      title: 'Candidate · working',
      kind: 'live',
      itemId: 'now:candidate',
      placeholder: true,
    },
  ];
}

function mockVisibleHost(timeline: TimelineEntry[], revision: TimelineRevisionState): IntakeTui {
  return {
    timeline,
    timelineRevision: revision.timelineRevision,
    timelineFilterIndex: 0,
    page: 'running',
    preparePhase: undefined,
    runPhase: 'recovery',
    expandedFolds: [],
    visibleTimelineCache: undefined,
  } as unknown as IntakeTui;
}

describe('realtime fluency caches', () => {
  beforeEach(() => {
    resetScrollbackLayoutCache();
    resetFoldProcessCache();
  });

  it('appendTimelineEntries bumps timeline revision', () => {
    const revision: TimelineRevisionState = { timelineRevision: 0 };
    appendTimelineEntries([], projectTimelineEvent(event('recovery.started', {})), revision);
    assert.equal(revision.timelineRevision, 1);
  });

  it('visibleTimeline cache invalidates when mid-list rows collapse', () => {
    const timeline: TimelineEntry[] = [];
    const revision: TimelineRevisionState = { timelineRevision: 0 };
    const failure = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
    appendTimelineEntries(timeline, projectTimelineEvent(event('recovery.started', {})), revision);
    for (let index = 0; index < 3; index += 1) {
      appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
        role: 'recovery',
        tool: 'shell_exec',
        message: failure,
      }, index + 2)), revision);
    }
    const host = mockVisibleHost(timeline, revision);
    const before = IntakeTui_visibleTimeline.call(host);
    const detailBefore = before.find((entry) => entry.level === 'error')?.detail ?? '';

    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'recovery',
      tool: 'shell_exec',
      message: failure,
    }, 10)), revision);
    host.timelineRevision = revision.timelineRevision;

    const after = IntakeTui_visibleTimeline.call(host);
    const detailAfter = after.find((entry) => entry.level === 'error')?.detail ?? '';
    assert.notEqual(detailBefore, detailAfter);
    assert.match(detailAfter, /×4/);
  });

  it('reuses folded timeline output across tick-only renders', () => {
    const entries = sampleEntries();
    const expanded = new Set<string>();
    const first = foldProcessEntries(entries, expanded, 1);
    const second = foldProcessEntries(entries, expanded, 1);
    assert.equal(first, second);
    const third = foldProcessEntries(entries, expanded, 2);
    assert.notEqual(first, third);
  });

  it('reuses scrollback body across tick and elapsed chrome updates', () => {
    const theme = createTheme(80);
    const entries = sampleEntries();
    const atZero = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true, 1);
    const later = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 900, 0, '00:15', true, 1);
    assert.notEqual(atZero.lines.at(-1), later.lines.at(-1));
    assert.deepEqual(atZero.lines.slice(0, -1), later.lines.slice(0, -1));
  });

  it('invalidates scrollback body cache when timeline revision advances', () => {
    const theme = createTheme(80);
    const entries = sampleEntries();
    const before = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true, 1);
    entries[1] = { ...entries[1]!, detail: 'public response line 1\npublic response line 2' };
    const after = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true, 2);
    assert.notDeepEqual(before.lines.slice(0, -1), after.lines.slice(0, -1));
  });

  it('fold cache invalidates when entry content changes without a revision bump', () => {
    const expanded = new Set<string>();
    const first = foldProcessEntries(sampleEntries(), expanded, 5);
    const replaced: TimelineEntry[] = [
      { ...sampleEntries()[0]!, title: 'Prompt · Different task', detail: 'Different task' },
      ...sampleEntries().slice(1),
    ];
    const next = foldProcessEntries(replaced, expanded, 5);
    assert.notEqual(next, first);
    assert.equal(next[0]?.title, 'Prompt · Different task');
    const again = foldProcessEntries(replaced, expanded, 5);
    assert.equal(again, next);
  });

  it('invalidates scrollback body when folded entries change without a revision bump', () => {
    const theme = createTheme(80);
    const collapsed = sampleEntries();
    const first = layoutScrollback(theme, 80, collapsed, 1, 'en', 'Codex', 8, 0, 0, '00:01', true, 1);
    const expandedView: TimelineEntry[] = [
      collapsed[0]!,
      {
        sequence: 2,
        occurredAt: '2026-08-11T00:00:01.000Z',
        source: 'TARGET',
        title: 'Visible response',
        kind: 'narrate',
        detail: 'public response line 1',
      },
      {
        sequence: 4,
        occurredAt: '2026-08-11T00:00:01.500Z',
        source: 'TARGET',
        title: 'Visible response continued',
        kind: 'narrate',
        detail: 'public response line 2 after expand',
      },
      collapsed[2]!,
    ];
    const afterExpand = layoutScrollback(theme, 80, expandedView, 1, 'en', 'Codex', 8, 0, 0, '00:01', true, 1);
    assert.notDeepEqual(first.lines.slice(0, -1), afterExpand.lines.slice(0, -1));
  });
});

describe('R08 stale wait ladder (fake clock)', () => {
  it('keeps role and only changes status text across 10/60/120s idle', async () => {
    const { waitLine } = await import('../../src/tui/pages/run.js');
    const { runningChrome } = await import('../../src/tui/pages/run.js');
    const { createTheme } = await import('../../src/tui/theme.js');
    const theme = createTheme(100, false);
    const start = Date.parse('2026-08-28T00:00:00.000Z');
    const model = {
      entries: [],
      selected: 0,
      filter: 'ALL' as const,
      following: true,
      cancelling: false,
      currentState: 'awaiting_target' as const,
      elapsed: '00:00',
      turns: { used: 1 },
      calls: { used: 0 },
      runPhase: 'candidate_generating' as const,
      activityRole: 'candidate' as const,
      uiStage: 'awaiting_candidate' as const,
      lastVisibleActivityAt: '2026-08-28T00:00:00.000Z',
      runStartedAt: start,
      locale: 'zh' as const,
      productLabel: 'Codex',
    };
    const at10 = waitLine({ ...model, tick: start + 10_000 }, 'zh');
    const at60 = waitLine({ ...model, tick: start + 60_000 }, 'zh');
    const at120 = waitLine({ ...model, tick: start + 120_000 }, 'zh');
    assert.match(at10 ?? '', /候选/);
    assert.match(at60 ?? '', /可取消/);
    assert.match(at120 ?? '', /2 分钟没有新的可见活动/);
    const chrome = runningChrome(theme, 100, { ...model, tick: start + 120_000, elapsed: '02:00' }).join('\n');
    assert.match(chrome, /等待候选|候选/);
    assert.doesNotMatch(chrome, /候选 Runtime 无响应/);
    assert.match(chrome, /Ctrl\+C/);
  });
});
