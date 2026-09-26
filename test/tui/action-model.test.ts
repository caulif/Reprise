import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactsFromResult,
  footerHintPairs,
  isActionEnabled,
  listActions,
  matchActionKey,
  resultFooterHints,
  runningFooterHints,
} from '../../src/tui/action-model.js';
import { dispatchResultKeys } from '../../src/tui/page-input.js';

test('running footer keeps primary actions and leaves reading tools in help', () => {
  const hints = runningFooterHints('en', { preparing: false });
  assert.equal(hints[0]?.[0], 'Ctrl+C');
  assert.deepEqual(hints.map(([key]) => key), ['Ctrl+C', '?']);
  const actions = listActions({ page: 'running', locale: 'en', mode: { preparing: false } });
  assert.ok(actions.some((action) => action.id === 'start-find'));
  assert.ok(actions.some((action) => action.id === 'follow'));
  assert.ok(actions.some((action) => action.id === 'toggle-fold'));
  assert.ok(hints.length <= 4);
});

test('result footer hides missing artifacts and keeps compare when pending', () => {
  const without = resultFooterHints('en', {
    comparePending: false,
    artifacts: { report: false, historyFinal: false, candidateFinal: false },
  });
  assert.deepEqual(without, [
    ['Enter', 'Activate'],
    ['Esc', 'Finish reviewing'],
    ['d', 'Technical details'],
    ['?', 'Help'],
  ]);

  const withCompare = resultFooterHints('en', {
    comparePending: true,
    artifacts: { report: true },
  });
  assert.equal(withCompare[0]?.[0], 'Enter');
  assert.ok(withCompare.some(([key]) => key === 'Esc'));
  assert.ok(withCompare.some(([key]) => key === 'c'));
  assert.ok(withCompare.length <= 4);
  assert.ok(withCompare.some(([key]) => key === 'o'));
  assert.ok(!withCompare.some(([key]) => key === 'h' || key === 'f'));
});

test('failed comparison labels the report action as a diagnostic', () => {
  const actions = listActions({ page: 'result', locale: 'zh', artifacts: { report: true, diagnostic: true } });
  assert.equal(actions.find((item) => item.id === 'open-report')?.labelKey, 'hintOpenDiagnostic');
});

test('reading footer describes terminal selection without claiming a copy completed', () => {
  for (const [locale, expected] of [['en', 'Select and copy in terminal'], ['zh', '终端拖选复制']] as const) {
    const hints = runningFooterHints(locale, { preparing: false, reading: true });
    assert.ok(hints.some(([key, label]) => key === 'Drag' && label === expected));
    assert.ok(hints.some(([key]) => key === 'v'));
  }
});

test('disabled open-report key matches but stays disabled', () => {
  const actions = listActions({
    page: 'result',
    locale: 'en',
    artifacts: { report: false },
  });
  const matched = matchActionKey(actions, 'o', { includeDisabled: true });
  assert.equal(matched?.id, 'open-report');
  assert.equal(matched?.enabled, false);
  assert.equal(isActionEnabled(actions, 'open-report'), false);
});

test('dispatchResultKeys uses shared availability and activate-primary on Enter', () => {
  assert.equal(dispatchResultKeys('c')?.action, undefined);
  assert.equal(dispatchResultKeys('c', { comparePending: true })?.action, 'compare');
  assert.equal(dispatchResultKeys('\r', { comparePending: true })?.action, 'activate-primary');
  assert.equal(dispatchResultKeys('o', { artifacts: { report: false } })?.enabled, false);
  assert.equal(dispatchResultKeys('o', { artifacts: { report: true } })?.enabled, true);
  assert.equal(dispatchResultKeys('\x1b', { comparePending: true })?.action, 'home');
});

test('artifactsFromResult mirrors pathLinks presence', () => {
  const artifacts = artifactsFromResult({
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks: {
      report: 'C:\\exp\\report.html',
      historyFinal: 'C:\\exp\\history.html',
      trace: 'C:\\exp\\runs\\r1',
    },
    record: { attempt: { runId: 'r1' }, outcome: { task: { status: 'incomplete' }, termination: { kind: 'completed', code: 'ok' } } },
    comparison: { result: { status: 'completed' } },
  } as never);
  assert.equal(artifacts.report, true);
  assert.equal(artifacts.historyFinal, true);
  assert.equal(artifacts.candidateFinal, false);
  assert.equal(artifacts.trace, true);
});

test('footerHintPairs ranks primary running actions without filling unused slots', () => {
  const pairs = footerHintPairs(listActions({
    page: 'running',
    locale: 'en',
    mode: { preparing: false, findAllowed: true },
  }), 'en', 4);
  assert.deepEqual(pairs.map(([key]) => key), ['Ctrl+C', '?']);
});

test('navigation pages share back and help actions', () => {
  for (const page of ['home', 'source', 'preflight', 'candidate-product', 'candidate-model', 'config', 'sessions', 'inspection', 'history', 'history-detail']) {
    const ids = listActions({ page, locale: 'en' }).map((item) => item.id);
    assert.ok(ids.includes('show-help'), page);
    if (page !== 'home') assert.ok(ids.includes('back'), page);
  }
});

test('confirm action returns to model selection on Escape', () => {
  const actions = listActions({ page: 'confirm', locale: 'en', mode: { canStartConfirm: true } });
  const escape = actions.find((item) => item.keys.includes('escape'));
  assert.equal(escape?.id, 'change-model');
  assert.equal(escape?.kind, 'navigate');
});
