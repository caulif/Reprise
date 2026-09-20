import test from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactsFromResult,
  footerHintPairs,
  isActionEnabled,
  listActions,
  matchActionKey,
} from '../../src/tui/action-model.js';
import { dispatchConfirmInput, dispatchResultKeys, dispatchRunningKeys } from '../../src/tui/page-input.js';

test('running footer always includes cancel and discoverable find when idle', () => {
  const hints = footerHintPairs(listActions({
    page: 'running',
    locale: 'en',
    mode: { preparing: false, findAllowed: true },
  }), 'en');
  assert.equal(hints[0]?.[0], 'Ctrl+C');
  assert.ok(hints.some(([key]) => key === '/'));
  assert.ok(hints.length <= 4);
});

test('result footer hides missing artifacts and keeps compare when pending', () => {
  const without = footerHintPairs(listActions({
    page: 'result',
    locale: 'en',
    mode: { comparePending: false },
    artifacts: { report: false, historyFinal: false, candidateFinal: false },
  }), 'en');
  assert.deepEqual(without, [
    ['Esc', 'Home'],
    ['?', 'Help'],
  ]);

  const withCompare = footerHintPairs(listActions({
    page: 'result',
    locale: 'en',
    mode: { comparePending: true },
    artifacts: { report: true },
  }), 'en');
  assert.equal(withCompare[0]?.[0], 'c');
  assert.ok(withCompare.some(([key]) => key === 'o'));
  assert.ok(!withCompare.some(([key]) => key === 'h' || key === 'f'));
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

test('dispatchResultKeys uses shared availability and Enter activates compare when pending', () => {
  assert.equal(dispatchResultKeys('c')?.action, undefined);
  assert.equal(dispatchResultKeys('c', { comparePending: true })?.action, 'compare');
  assert.equal(dispatchResultKeys('\r', { comparePending: true })?.action, 'compare');
  assert.equal(dispatchResultKeys('o', { artifacts: { report: false } })?.enabled, false);
  assert.equal(dispatchResultKeys('o', { artifacts: { report: true } })?.enabled, true);
  assert.equal(dispatchResultKeys('o', { artifacts: { report: false } })?.disabledReasonKey, 'noReport');
  assert.equal(dispatchResultKeys('\x1b', { comparePending: true })?.action, 'home');
});

test('confirm and running keys resolve through the shared action list', () => {
  assert.equal(dispatchConfirmInput('\r')?.action, 'run');
  assert.equal(dispatchConfirmInput('\r', { canStart: false })?.enabled, false);
  assert.equal(dispatchConfirmInput('b')?.action, 'models');
  assert.equal(dispatchConfirmInput('\x1b')?.action, 'home');
  assert.equal(dispatchRunningKeys('\t')?.action, 'cycle-fold');
  assert.equal(dispatchRunningKeys('\x1b')?.action, 'active-message');
  assert.equal(dispatchRunningKeys('v')?.action, 'enter-reading');
  assert.equal(dispatchRunningKeys('v', { reading: true })?.action, 'leave-reading');
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

test('footerHintPairs ranks by priority and caps at four', () => {
  const pairs = footerHintPairs(listActions({
    page: 'running',
    locale: 'en',
    mode: { preparing: false, findAllowed: true },
  }), 'en', 4);
  assert.equal(pairs.length, 4);
  assert.equal(pairs[0]?.[0], 'Ctrl+C');
});
