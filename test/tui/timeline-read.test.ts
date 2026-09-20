import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { coveringFoldIds, foldProcessEntries, selectedIndexAfterFold } from '../../src/tui/fold-process.js';
import {
  applyFindRestore,
  canvasHitIndices,
  captureFindRestore,
  corpusMatchesQuery,
  matchesCanvasQuery,
  nextHitIndex,
  publicSearchCorpus,
  publicSearchCorpusKey,
  restoreTimelineSelection,
  syncTimelineSelection,
  timelineIdentity,
} from '../../src/tui/timeline-read.js';
import {
  DISABLE_MOUSE_REPORTING,
  installTerminalRestoreGuard,
  mouseReportingSequence,
} from '../../src/tui/terminal-guard.js';
import type { TimelineEntry } from '../../src/tui/timeline.js';

function entry(sequence: number, title: string, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return { sequence, occurredAt: '2026-09-08T00:00:00.000Z', source: 'TARGET', title, ...extra };
}

test('recovery narration stays visible while consecutive tools fold', () => {
  const first = entry(1, 'First finding', { source: 'HARNESS', lane: 'recovery', kind: 'narrate' });
  const tool = entry(2, 'Read file', { source: 'HARNESS', lane: 'recovery', kind: 'investigate' });
  const tool2 = entry(3, 'Read more', { source: 'HARNESS', lane: 'recovery', kind: 'investigate' });
  const second = entry(4, 'Second finding', { source: 'HARNESS', lane: 'recovery', kind: 'narrate' });
  const folded = foldProcessEntries([first, tool, tool2, second], new Set());
  assert.equal(folded.some((row) => row.sequence === 1 && row.kind === 'narrate'), true);
  assert.equal(folded.some((row) => row.kind === 'fold' && row.lane === 'recovery'), true);
});

test('timeline selection stays on identity when rows are appended ahead', () => {
  const first = entry(1, 'Visible response', { detail: 'alpha' });
  const second = entry(2, 'Visible response', { detail: 'beta' });
  const state = {
    timelineFollowing: false,
    timelineSelected: 0,
    timelineAnchor: timelineIdentity(first),
    timelineReadOffset: 3,
    visibleTimeline: () => [first, second],
  };
  syncTimelineSelection(state);
  assert.equal(state.timelineSelected, 0);
  assert.equal(state.timelineFollowing, false);
  assert.equal(state.timelineReadOffset, 3);
});

test('restoreTimelineSelection follows last only when the anchor is last', () => {
  const rows = [entry(1, 'A'), entry(2, 'B')];
  assert.deepEqual(restoreTimelineSelection(rows, timelineIdentity(rows[1]!)), { selected: 1, following: true });
  assert.deepEqual(restoreTimelineSelection(rows, timelineIdentity(rows[0]!)), { selected: 0, following: false });
});

test('missing seq anchor selects nearest still-visible predecessor, not live bottom', () => {
  const rows = [entry(1, 'A'), entry(3, 'C'), entry(5, 'E')];
  assert.deepEqual(restoreTimelineSelection(rows, 'seq:4'), { selected: 1, following: false });
  assert.deepEqual(restoreTimelineSelection(rows, 'seq:10'), { selected: 2, following: true });
  assert.deepEqual(restoreTimelineSelection(rows, 'seq:0', 2), { selected: 0, following: false });
});

test('missing id anchor keeps previous selection instead of snapping to end', () => {
  const rows = [entry(1, 'A'), entry(2, 'B'), entry(3, 'C')];
  assert.deepEqual(restoreTimelineSelection(rows, 'id:gone', 1), { selected: 1, following: false });
});

test('missing id anchor uses stable source order after filtering', () => {
  const first = entry(1, 'A', { itemId: 'a' });
  const anchored = entry(2, 'B', { itemId: 'b' });
  const last = entry(3, 'C', { itemId: 'c' });
  const state = {
    timelineFollowing: false,
    timelineSelected: 1,
    timelineAnchor: 'id:b',
    timelineReadOffset: 2,
    timeline: [first, anchored, last],
    visibleTimeline: () => [first, last],
  };
  syncTimelineSelection(state);
  assert.equal(state.timelineSelected, 0);
  assert.equal(state.timelineFollowing, false);
  assert.equal(state.timelineReadOffset, 0);
});

test('paused selection remains paused when filtering leaves it at the end', () => {
  const rows = [entry(1, 'A'), entry(2, 'B')];
  const state = {
    timelineFollowing: false,
    timelineSelected: 1,
    timelineAnchor: timelineIdentity(rows[0]!),
    timelineReadOffset: 0,
    visibleTimeline: () => [rows[1]!],
  };
  syncTimelineSelection(state);
  assert.equal(state.timelineSelected, 0);
  assert.equal(state.timelineFollowing, false);
});

test('canvas find locates hits without dropping surrounding rows', () => {
  const rows = [
    entry(1, 'Visible response', { detail: 'alpha' }),
    entry(2, 'Visible response', { detail: 'needle here' }),
    entry(3, 'Visible response', { detail: 'omega' }),
  ];
  assert.deepEqual(canvasHitIndices(rows, 'needle'), [1]);
  assert.equal(nextHitIndex([1], 0, 1), 1);
  assert.equal(nextHitIndex([1], 1, 1), 1);
  assert.equal(nextHitIndex([0, 2], 0, 1), 2);
  assert.equal(nextHitIndex([0, 2], 2, -1), 0);
});

test('canvas find matches full public detail, not original dumps', () => {
  const product = entry(2, 'Visible response', {
    detail: 'public response line 1\npublic response line 2',
    original: 'SECRET_TOOL_DUMP',
  });
  assert.equal(matchesCanvasQuery(product, 'line 2'), true);
  assert.equal(matchesCanvasQuery(product, 'SECRET_TOOL_DUMP'), false);
  const command = entry(3, 'Running · pwsh', {
    detail: '$ Get-ChildItem\nlong body still public',
    original: 'UNIQUE_ORIGINAL_TOKEN',
  });
  assert.equal(matchesCanvasQuery(command, 'long body still public'), true);
  assert.equal(matchesCanvasQuery(command, 'UNIQUE_ORIGINAL_TOKEN'), false);
  assert.deepEqual(publicSearchCorpus(product), [
    'Visible response',
    'public response line 1\npublic response line 2',
  ]);
  const unread = ['Turn title on later page'];
  assert.equal(corpusMatchesQuery([...unread], 'later page'), true);
  assert.equal(corpusMatchesQuery(['only original'], 'SECRET_TOOL_DUMP'), false);
});

test('public search corpus key changes with revision, not tick alone', () => {
  const rows = [entry(1, 'A'), entry(2, 'B')];
  const a = publicSearchCorpusKey(rows, 1);
  const b = publicSearchCorpusKey(rows, 1);
  const c = publicSearchCorpusKey(rows, 2);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('find restore snapshot returns to pre-find anchor and offset', () => {
  const first = entry(1, 'Visible response', { detail: 'alpha' });
  const second = entry(2, 'Visible response', { detail: 'beta' });
  const state = {
    timelineFollowing: false,
    timelineSelected: 0,
    timelineAnchor: timelineIdentity(first),
    timelineReadOffset: 4,
    visibleTimeline: () => [first, second],
  };
  const snapshot = captureFindRestore(state);
  state.timelineSelected = 1;
  state.timelineAnchor = timelineIdentity(second);
  state.timelineFollowing = true;
  state.timelineReadOffset = 0;
  applyFindRestore(state, snapshot);
  assert.equal(state.timelineSelected, 0);
  assert.equal(state.timelineFollowing, false);
  assert.equal(state.timelineAnchor, timelineIdentity(first));
  assert.equal(state.timelineReadOffset, 4);
});

test('find hit covering a folded turn returns the fold id', () => {
  const hidden = entry(1, 'Input to Target', { detail: 'hidden send', source: 'CONTROLLER' });
  const later = entry(10, 'Input to Target', { detail: 'second send', source: 'CONTROLLER', lane: 'controller' });
  const current = entry(11, 'Input to Target', { detail: 'now', source: 'CONTROLLER', lane: 'controller' });
  const unfolded = [hidden, later, current];
  const folded = foldProcessEntries(unfolded, new Set());
  const fold = folded.find((row) => row.itemId?.startsWith('fold:turn:'));
  assert.ok(fold);
  assert.ok(coveringFoldIds(unfolded, hidden).includes(fold.itemId!));
  assert.equal(selectedIndexAfterFold(unfolded, folded, hidden), folded.indexOf(fold));
});

test('terminal restore guard stops once on uncaughtException', () => {
  const host = new EventEmitter();
  let stops = 0;
  const uninstall = installTerminalRestoreGuard(() => {
    stops += 1;
  }, host);
  host.emit('uncaughtException', new Error('boom'));
  host.emit('exit');
  assert.equal(stops, 1);
  uninstall();
  assert.equal(mouseReportingSequence(false), DISABLE_MOUSE_REPORTING);
  assert.match(mouseReportingSequence(true), /\x1b\[\?1000h/);
});
