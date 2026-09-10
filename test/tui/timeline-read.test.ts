import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setCapabilities, resetCapabilitiesCache } from '@earendil-works/pi-tui';
import { coveringFoldIds, foldProcessEntries, selectedIndexAfterFold } from '../../src/tui/fold-process.js';
import { fileLink } from '../../src/tui/format.js';
import {
  canvasHitIndices,
  corpusMatchesQuery,
  matchesCanvasQuery,
  nextHitIndex,
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
    visibleTimeline: () => [first, second],
  };
  syncTimelineSelection(state);
  assert.equal(state.timelineSelected, 0);
  assert.equal(state.timelineFollowing, false);
});

test('restoreTimelineSelection follows last only when the anchor is last', () => {
  const rows = [entry(1, 'A'), entry(2, 'B')];
  assert.deepEqual(restoreTimelineSelection(rows, timelineIdentity(rows[1]!)), { selected: 1, following: true });
  assert.deepEqual(restoreTimelineSelection(rows, timelineIdentity(rows[0]!)), { selected: 0, following: false });
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

test('canvas find matches visible titles and messages, not original dumps', () => {
  const product = entry(2, 'Visible response', { detail: 'public response line 1', original: 'SECRET_TOOL_DUMP' });
  assert.equal(matchesCanvasQuery(product, 'public response'), true);
  assert.equal(matchesCanvasQuery(product, 'SECRET_TOOL_DUMP'), false);
  const command = entry(3, 'Running · pwsh', { detail: '$ Get-ChildItem\nlong body', original: 'UNIQUE_ORIGINAL_TOKEN' });
  assert.equal(matchesCanvasQuery(command, 'Get-ChildItem'), true);
  assert.equal(matchesCanvasQuery(command, 'UNIQUE_ORIGINAL_TOKEN'), false);
  const unread = ['Turn title on later page'];
  assert.equal(corpusMatchesQuery([...unread], 'later page'), true);
  assert.equal(corpusMatchesQuery(['only original'], 'SECRET_TOOL_DUMP'), false);
});

test('find hit covering a folded turn returns the fold id', () => {
  const hidden = entry(1, 'Input to Target', { detail: 'hidden send', source: 'CONTROLLER' });
  const later = entry(10, 'Decision: SEND next', { source: 'CONTROLLER', lane: 'controller', kind: 'narrate' });
  const current = entry(11, 'Visible response', { detail: 'now' });
  const unfolded = [hidden, later, current];
  const folded = foldProcessEntries(unfolded, new Set());
  assert.ok(folded.some((row) => row.itemId === 'fold:turn:1'));
  assert.ok(coveringFoldIds(unfolded, hidden).includes('fold:turn:1'));
  assert.equal(selectedIndexAfterFold(unfolded, folded, hidden), folded.findIndex((row) => row.itemId === 'fold:turn:1'));
});

test('fileLink uses OSC 8 only when capabilities allow it and strips controls', () => {
  const abs = process.platform === 'win32' ? 'C:\\data\\报告.html' : '/data/报告.html';
  try {
    setCapabilities({ images: null, trueColor: false, hyperlinks: true });
    const linked = fileLink(`\u001b[31mopen\u001b]8;;evil\u0007`, abs);
    assert.equal(linked.includes('\u001b]8;;evil'), false);
    assert.match(linked, /\u001b]8;;/);
    assert.equal(linked.includes(pathToFileURL(abs).href), true);
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const plain = fileLink('open', abs);
    assert.equal(plain.includes('\u001b]8;;'), false);
    assert.equal(plain, abs);
  } finally {
    resetCapabilitiesCache();
  }
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
