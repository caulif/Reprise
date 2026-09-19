import test from 'node:test';
import assert from 'node:assert/strict';
import { runningHints } from '../../src/tui/pages/run.js';
import { createTheme } from '../../src/tui/theme.js';
import { keyHints } from '../../src/tui/widgets.js';

function footer(preparing = false, locale: 'en' | 'zh' = 'en', finding = false, reading = false): string {
  return keyHints(createTheme(80, false), runningHints('ALL', false, preparing, locale, finding, reading), 80);
}

function assertWatchOnly(line: string): void {
  assert.match(line, /Ctrl\+C/);
  assert.doesNotMatch(line, /Expand|Select|Find|\[\/\]|\[Enter\]|\[v\]/);
}

test('preparing running hints are watch-only', () => {
  assertWatchOnly(footer(true, 'en'));
  assertWatchOnly(footer(true, 'zh'));
});

test('recovery running hints are watch-only', () => {
  assertWatchOnly(footer(true, 'en'));
  assertWatchOnly(footer(true, 'zh'));
});

test('candidate idle running hints are watch-only', () => {
  assertWatchOnly(footer(false, 'en'));
  assertWatchOnly(footer(false, 'zh'));
});

test('finding running hints keep find-mode keys only', () => {
  const line = footer(false, 'en', true, false);
  assert.match(line, /Ctrl\+C/);
  assert.match(line, /Next match/);
  assert.match(line, /Previous match/);
  assert.match(line, /Clear find/);
  assert.doesNotMatch(line, /Expand|Select/);
});

test('reading running hints keep reading-mode keys only', () => {
  const line = footer(false, 'en', false, true);
  assert.match(line, /Ctrl\+C/);
  assert.match(line, /Resume view/);
  assert.doesNotMatch(line, /Expand|Find/);
});
