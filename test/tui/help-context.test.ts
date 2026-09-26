import test from 'node:test';
import assert from 'node:assert/strict';
import { listActions } from '../../src/tui/action-model.js';
import { helpLines } from '../../src/tui/overlays.js';
import { renderWorkbench } from '../../src/tui/workbench.js';

test('long-page help names PageUp and PageDown without adding a page action', () => {
  for (const page of ['history-detail', 'recovery-review', 'confirm', 'result']) {
    const text = helpLines(page, 'en', listActions({ page, locale: 'en' })).join('\n');
    assert.match(text, /PgUp \/ PgDn\s+Scroll page/, page);
  }
});

test('result process help describes timeline keys rather than result actions', () => {
  const actions = listActions({ page: 'result', locale: 'en', mode: { processExpanded: true } });
  const overlay = helpLines('result', 'en', actions).join('\n');
  assert.match(overlay, /Enter\s+Expand/);
  assert.match(overlay, /\/\s+Find/);
  assert.doesNotMatch(overlay, /Enter\s+Activate|Open report/);

  const inline = renderWorkbench({
    page: 'result', cwd: '', hasApiConfig: true, hasTaskCase: true, message: '', inlineHelp: true,
    processExpanded: true, result: {} as never,
    running: {
      entries: [{ sequence: 1, occurredAt: '2026-09-26T00:00:00.000Z', source: 'TARGET', title: 'Wrote output', detail: 'detail' }],
      selected: 0, filter: 'ALL', following: false, currentState: 'finished', elapsed: '00:10',
      turns: { used: 1 }, calls: { used: 1 },
    },
  }, 120).join('\n');
  assert.match(inline, /Enter\s+Expand/);
  assert.match(inline, /\/\s+Find/);
  assert.doesNotMatch(inline, /Enter\s+Activate/);
});
