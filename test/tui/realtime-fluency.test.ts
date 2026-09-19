import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { foldProcessEntries, resetFoldProcessCache } from '../../src/tui/fold-process.js';
import { layoutScrollback, resetScrollbackLayoutCache } from '../../src/tui/scrollback.js';
import { createTheme } from '../../src/tui/theme.js';
import type { TimelineEntry } from '../../src/tui/timeline.js';

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

describe('realtime fluency caches', () => {
  beforeEach(() => {
    resetScrollbackLayoutCache();
    resetFoldProcessCache();
  });

  it('reuses folded timeline output across tick-only renders', () => {
    const entries = sampleEntries();
    const expanded = new Set<string>();
    const first = foldProcessEntries(entries, expanded);
    const second = foldProcessEntries(entries, expanded);
    assert.equal(first, second);
  });

  it('reuses scrollback body across tick and elapsed chrome updates', () => {
    const theme = createTheme(80);
    const entries = sampleEntries();
    const atZero = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true);
    const later = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 900, 0, '00:15', true);
    assert.notEqual(atZero.lines.at(-1), later.lines.at(-1));
    assert.deepEqual(atZero.lines.slice(0, -1), later.lines.slice(0, -1));
  });

  it('invalidates scrollback body cache when streaming tail changes', () => {
    const theme = createTheme(80);
    const entries = sampleEntries();
    const before = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true);
    entries[1] = { ...entries[1]!, detail: 'public response line 1\npublic response line 2' };
    const after = layoutScrollback(theme, 80, entries, 1, 'en', 'Codex', 8, 0, 0, '00:01', true);
    assert.notDeepEqual(before.lines.slice(0, -1), after.lines.slice(0, -1));
  });
});
