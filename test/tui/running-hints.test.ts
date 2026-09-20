import test from 'node:test';
import assert from 'node:assert/strict';
import { runningHints } from '../../src/tui/pages/run.js';
import { createTheme } from '../../src/tui/theme.js';
import { keyHints } from '../../src/tui/widgets.js';

function footer(preparing = false, locale: 'en' | 'zh' = 'en', finding = false, reading = false): string {
  return keyHints(createTheme(80, false), runningHints('ALL', false, preparing, locale, finding, reading), 80);
}

function assertCancelVisible(line: string): void {
  assert.match(line, /Ctrl\+C/);
}

test('preparing running hints keep cancel and hide reading shortcuts', () => {
  for (const locale of ['en', 'zh'] as const) {
    const line = footer(true, locale);
    assertCancelVisible(line);
    assert.doesNotMatch(line, /Expand|Find|查找|展开|\[\/\]|\[Enter\]/);
  }
});

test('candidate idle running hints expose cancel and discoverable reading actions', () => {
  const en = footer(false, 'en');
  assertCancelVisible(en);
  assert.match(en, /Find/);
  assert.match(en, /Follow live|Expand|Help/);
  assert.doesNotMatch(en, /Generate comparison/);

  const zh = footer(false, 'zh');
  assertCancelVisible(zh);
  assert.match(zh, /查找|跟随|展开|帮助/);
});

test('finding running hints keep find-mode keys only', () => {
  const line = footer(false, 'en', true, false);
  assertCancelVisible(line);
  assert.match(line, /Next match/);
  assert.match(line, /Previous match|Clear find/);
  assert.doesNotMatch(line, /Expand|Select|Follow live/);
});

test('reading running hints keep reading-mode keys only', () => {
  const line = footer(false, 'en', false, true);
  assertCancelVisible(line);
  assert.match(line, /Resume view/);
  assert.doesNotMatch(line, /Expand|Find/);
});
