import test from 'node:test';
import assert from 'node:assert/strict';
import {
  comparisonPresentation,
  displayLiveCaption,
  displayOperatorTitle,
  displayTaskStatus,
  resultHeaderStatus,
  terminationTone,
} from '../../src/tui/display-copy.js';
import { t } from '../../src/tui/i18n.js';
import { resultHints, renderResult } from '../../src/tui/pages/result.js';
import { runningHints } from '../../src/tui/pages/run.js';
import { createTheme, resolveColorModeForTest, resolveDensity, FORBIDDEN_COMPACT } from '../../src/tui/theme.js';
import { keyHints } from '../../src/tui/widgets.js';

test('R15 density breakpoints stay at 32/78/110', () => {
  assert.equal(resolveDensity(31), 'minimum');
  assert.equal(resolveDensity(32), 'compact');
  assert.equal(resolveDensity(77), 'compact');
  assert.equal(resolveDensity(78), 'regular');
  assert.equal(resolveDensity(109), 'regular');
  assert.equal(resolveDensity(110), 'wide');
});

test('R15 NO_COLOR and ASCII do not rely on color or unicode gutters', () => {
  assert.equal(resolveColorModeForTest({ NO_COLOR: '1' }, true), 'off');
  assert.equal(resolveColorModeForTest({ TERM: 'dumb' }, true), 'off');
  const compact = createTheme(60, false);
  assert.equal(compact.colorMode, 'off');
  assert.equal(compact.framed, false);
  assert.doesNotMatch(Object.values(compact.glyphs).join(''), FORBIDDEN_COMPACT);
  assert.equal(compact.style.danger('x'), 'x');
  assert.equal(compact.style.ok('y'), 'y');
  const wide = createTheme(120, false);
  assert.equal(wide.framed, true);
  assert.match(wide.glyphs.ok, /[✓+]/);
});

test('R15 zh/en action availability stays the same shape', () => {
  for (const locale of ['en', 'zh'] as const) {
    const running = runningHints('ALL', false, false, locale);
    const finding = runningHints('ALL', false, false, locale, true);
    const result = resultHints(locale, true);
    assert.equal(running[0]?.[0], 'Ctrl+C');
    assert.equal(finding[0]?.[0], 'Ctrl+C');
    assert.deepEqual(result.map(([key]) => key), ['c', 'o', 'h', 'f', 'Esc']);
    assert.equal(running.length, finding.length === 4 ? 1 : running.length);
  }
  const narrow = keyHints(createTheme(40, false), runningHints('ALL', true, false, 'zh', true), 40);
  assert.match(narrow, /Ctrl\+C/);
});

test('operator titles localize without changing fold identity tokens', () => {
  assert.equal(displayOperatorTitle('working', 'zh'), '正在处理');
  assert.equal(displayOperatorTitle('working', 'en'), 'Processing');
  assert.equal(displayOperatorTitle('阅读', 'en'), 'Reading evidence');
  assert.equal(displayLiveCaption('working', 'ignored.txt', 'zh'), '正在处理');
  assert.equal(displayTaskStatus('apparently_completed', 'zh'), '控制 Agent 判断已完成');
  assert.equal(displayTaskStatus('apparently_completed', 'en'), 'Control agent judged complete');
  assert.equal(terminationTone('cancelled'), 'warn');
  assert.equal(terminationTone('failed'), 'danger');
});

test('comparison cancelled and insufficient evidence stay non-success', () => {
  const cancelled = comparisonPresentation({ status: 'cancelled' }, 'zh');
  assert.match(cancelled.word, /已取消/);
  assert.equal(cancelled.tone, 'warn');
  assert.match(cancelled.diagnostic, /诊断/);
  const insufficient = comparisonPresentation({ status: 'completed', value: { status: 'insufficient_evidence' } }, 'en');
  assert.equal(insufficient.tone, 'warn');
  assert.match(insufficient.word, /Insufficient evidence/);
  const header = resultHeaderStatus({
    record: { outcome: { termination: { kind: 'completed' } } },
    comparison: { result: { status: 'cancelled' } },
  }, 'zh');
  assert.equal(header.tone, 'warn');
  assert.match(header.label, /已取消/);
});

test('result page shows apparently_completed as controller judgment and cancel neutrally', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\comparison-failure.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        task: { status: 'apparently_completed' },
        termination: { kind: 'cancelled', code: 'cancelled.user' },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'cancelled' },
    comparison: { result: { status: 'cancelled' } },
  } as never, 'zh').join('\n');
  assert.match(text, /控制 Agent 判断已完成/);
  assert.match(text, /已取消/);
  assert.match(text, /对照诊断（已取消）/);
  assert.doesNotMatch(text, /\bapparently_completed\b/);
  assert.doesNotMatch(text, /对照已完成|对照完成(?!（)/);
});

test('glossary home label is 首页 not 封面', () => {
  assert.equal(t('zh', 'hintHome'), '首页');
  assert.match(t('zh', 'backAtHome'), /首页/);
  assert.match(t('zh', 'helpGlobalLine'), /首页/);
  assert.equal(t('zh', 'recoveryRole'), '恢复 Agent');
  assert.equal(t('zh', 'controllerLegend'), '控制 Agent');
  assert.equal(t('zh', 'comparisonLegend'), '对照 Agent');
});
