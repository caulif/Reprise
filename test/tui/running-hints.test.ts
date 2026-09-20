import test from 'node:test';
import assert from 'node:assert/strict';
import { runningHints } from '../../src/tui/pages/run.js';
import { createTheme } from '../../src/tui/theme.js';
import { keyHints } from '../../src/tui/widgets.js';

function footer(preparing = false, locale: 'en' | 'zh' = 'en', finding = false, reading = false, cancelUi: 'idle' | 'requesting' | 'failed' | 'settled' = 'idle'): string {
  return keyHints(createTheme(80, false), runningHints('ALL', false, preparing, locale, finding, reading, cancelUi), 80);
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

test('requesting cancel footer says leave UI without claiming cleanup is done', () => {
  const en = footer(false, 'en', false, false, 'requesting');
  assert.match(en, /Exit after cleanup|Leave UI \(cleanup unconfirmed\)/);
  const zh = footer(false, 'zh', false, false, 'requesting');
  assert.match(zh, /清理后退出|退出界面（清理未确认）/);
});

test('failed cancel footer keeps a retry cancel action', () => {
  assert.match(footer(false, 'en', false, false, 'failed'), /Retry cancellation/);
  assert.match(footer(false, 'zh', false, false, 'failed'), /重试取消/);
});
