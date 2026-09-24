import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchCanvasInput,
  dispatchCandidatePickerInput,
  dispatchConfirmInput,
  dispatchErrorKeys,
  dispatchGlobalInput,
  dispatchHistoryDetailInput,
  dispatchHomeComposer,
  dispatchInspectionInput,
  isSgrMouseInput,
  dispatchListPointer,
  dispatchPreflightInput,
  dispatchResultKeys,
  dispatchRunningKeys,
  dispatchSearchField,
  dispatchSessionsInput,
  dispatchSourceField,
  historyDetailKind,
  submittedHomeCommand,
} from '../../src/tui/page-input.js';

test('home composer unwraps bracketed paste before treating the payload as typed text', () => {
  const pasted = `\u001b[200~/intake\u001b[201~`;
  const result = dispatchHomeComposer({ composer: '', cursor: 0, showSuggestions: false }, pasted);
  assert.deepEqual(result, {
    state: { composer: '/intake', cursor: 7, showSuggestions: true },
    consume: true,
  });
});

test('source field unwraps bracketed paste of an absolute path', () => {
  const pasted = `\u001b[200~C:\\\\Users\\\\task\u001b[201~`;
  const result = dispatchSourceField({ value: '', cursor: 0 }, pasted);
  assert.ok(result);
  assert.equal(result.state.value, 'C:\\\\Users\\\\task');
  assert.equal(result.action, undefined);
});

test('sessions search unwraps bracketed paste before editing the query', () => {
  const pasted = `\u001b[200~codex\u001b[201~`;
  const result = dispatchSessionsInput({ query: '', cursor: 0, searching: true, canLeaveProject: false }, pasted);
  assert.ok(result);
  assert.equal(result.state.query, 'codex');
  assert.equal(result.action, 'edit-search');
});

test('canvas find unwraps bracketed paste before treating the payload as the query', () => {
  const pasted = `\u001b[200~tool.call\u001b[201~`;
  const result = dispatchCanvasInput({ finding: true, query: '', cursor: 0 }, pasted, false);
  assert.ok(result);
  assert.equal(result.state.query, 'tool.call');
  assert.equal(result.action, 'edit-find');
});

test('search field starts from a slash and leaves other keys to the page', () => {
  const start = dispatchSearchField({ query: '', cursor: 0, searching: false }, '/');
  assert.deepEqual(start, {
    state: { query: '', cursor: 0, searching: true },
    action: 'start-search',
    consume: true,
  });
  assert.equal(dispatchSearchField({ query: '', cursor: 0, searching: false }, 'f'), undefined);
});

test('submitted home command classifies a unique prefix', () => {
  assert.equal(submittedHomeCommand('/in'), 'intake');
  assert.equal(submittedHomeCommand('/run'), 'unknown');
  assert.equal(submittedHomeCommand('/find'), 'unknown');
  assert.equal(submittedHomeCommand('/lang'), 'lang');
});

test('global input routes ctrl+c and overlay escapes before page keys', () => {
  assert.equal(dispatchGlobalInput({ page: 'running', editingText: false, helpOpen: false }, '\u0003')?.action, 'cancel');
  assert.equal(dispatchGlobalInput({ page: 'confirm', editingText: false, helpOpen: false, startupActive: true }, '\u0003')?.action, 'cancel');
  assert.equal(dispatchGlobalInput({ page: 'home', editingText: false, helpOpen: false }, '\u0003')?.action, 'close');
  assert.equal(dispatchGlobalInput({ page: 'home', editingText: false, helpOpen: true }, '\x1b')?.action, 'hide-help');
  assert.equal(dispatchGlobalInput({ page: 'home', editingText: false, helpOpen: false }, '?')?.action, 'show-help');
  assert.equal(dispatchGlobalInput({ page: 'home', editingText: true, helpOpen: false }, '?'), undefined);
});

test('inspection, preflight, confirm, running, result, and error dispatch the operator keys', () => {
  assert.equal(dispatchResultKeys('\x1b')?.action, 'home');
  assert.equal(dispatchInspectionInput('t', true), undefined);
  assert.equal(dispatchInspectionInput('\r', true)?.action, 'freeze');
  assert.equal(dispatchInspectionInput('\r', false), undefined);
  assert.equal(dispatchPreflightInput('2'), undefined);
  assert.equal(dispatchPreflightInput('\r'), undefined);
  assert.equal(dispatchPreflightInput('b')?.action, 'home');
  assert.equal(dispatchConfirmInput('\r')?.action, 'run');
  assert.equal(dispatchConfirmInput('b')?.action, 'models');
  assert.equal(dispatchConfirmInput('\x1b')?.action, 'models');
  assert.equal(dispatchConfirmInput('r', { recoveryFailureAction: 'retry' })?.action, 'retry-recovery');
  assert.equal(dispatchConfirmInput('d', { recoveryFailureAction: 'diagnose' })?.action, 'open-diagnostics');
  assert.equal(dispatchConfirmInput('f', { recoveryFailureAction: 'refreeze' })?.action, 'refreeze-session');
  assert.equal(dispatchConfirmInput('c', { recoveryFailureAction: 'config' })?.action, 'open-recovery-config');
  assert.equal(dispatchCandidatePickerInput('b')?.action, 'back');
  assert.equal(dispatchCandidatePickerInput('\r')?.action, 'enter');
  assert.equal(dispatchRunningKeys('\t')?.action, 'cycle-fold');
  assert.equal(dispatchRunningKeys('\x1b')?.action, 'active-message');
  assert.equal(dispatchResultKeys('c', { comparePending: true })?.action, 'compare');
  assert.equal(dispatchResultKeys('\r', { comparePending: true })?.action, 'activate-primary');
  assert.equal(dispatchResultKeys('o', { artifacts: { report: true } })?.action, 'open-report');
  assert.equal(dispatchResultKeys('h', { artifacts: { historyFinal: true } })?.action, 'open-history-final');
  assert.equal(dispatchResultKeys('f', { artifacts: { candidateFinal: true } })?.action, 'open-candidate-final');
  assert.equal(dispatchResultKeys('t', { artifacts: { trace: true } })?.action, 'open-trace');
  assert.equal(dispatchResultKeys('w', { artifacts: { replica: true } })?.action, 'open-replica');
  assert.equal(dispatchResultKeys('p', { processAvailable: true })?.action, 'view-process');
  assert.equal(dispatchResultKeys('p', { processAvailable: false }), undefined);
  assert.equal(dispatchResultKeys('o', { artifacts: { report: false } })?.enabled, false);
  assert.equal(dispatchErrorKeys('b')?.action, 'return');
  assert.equal(dispatchErrorKeys('\x1b')?.action, 'return');
});

test('history detail distinguishes a frozen case from an experiment', () => {
  assert.equal(historyDetailKind({ taskCase: {} }), 'case');
  assert.equal(historyDetailKind({ path: 'x' }), 'experiment');
  assert.equal(dispatchHistoryDetailInput('o', 'experiment')?.action, 'open-report');
  assert.equal(dispatchHistoryDetailInput('o', 'case'), undefined);
  assert.equal(dispatchHistoryDetailInput('\r', 'case')?.action, 'use-case');
});

test('sessions page leaves a project on escape or backspace when that is allowed', () => {
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, '\x1b')?.action, 'leave-project');
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: false }, '\x1b')?.action, 'home');
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, '\b')?.action, 'leave-project');
});

test('home letters stay in the composer instead of acting as shortcuts', () => {
  const typed = dispatchHomeComposer({ composer: '', cursor: 0, showSuggestions: false }, 'r');
  assert.equal(typed?.state.composer, 'r');
  assert.equal(typed?.action, undefined);
});

test('home up and down cycle matching slash commands', () => {
  const started = dispatchHomeComposer({ composer: '', cursor: 0, showSuggestions: false }, '/');
  const next = dispatchHomeComposer(started?.state ?? { composer: '/', cursor: 1, showSuggestions: true }, '\x1b[B');
  assert.ok(next?.state.composer.startsWith('/'));
  assert.notEqual(next?.state.composer, '/');
});

test('session list letters filter instead of paging, with Ctrl chords for catalog actions', () => {
  const typed = dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, 'f');
  assert.equal(typed?.action, 'edit-search');
  assert.equal(typed?.state.query, 'f');
  assert.equal(typed?.state.searching, true);
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, '\x06')?.action, 'toggle-filter');
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, '\x0e')?.action, 'more');
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: true }, '\x12')?.action, 'refresh');
});

test('canvas find uses Enter and Shift+Enter for hits; Home is not a Home-page command', () => {
  const finding = { finding: true, query: 'tool', cursor: 4 };
  assert.equal(dispatchCanvasInput(finding, '\r', false)?.action, 'next-hit');
  assert.equal(dispatchCanvasInput(finding, '\x1b[13;2u', false)?.action, 'prev-hit');
  assert.equal(dispatchCanvasInput({ finding: false, query: '', cursor: 0 }, '\x1b[H', false)?.action, 'home');
  assert.equal(dispatchCanvasInput(finding, 'v', false)?.action, 'edit-find');
});

test('SGR wheel moves the canvas selection; click reports a row; running o does not open overlay', () => {
  const idle = { finding: false, query: '', cursor: 0 };
  assert.equal(dispatchCanvasInput(idle, '\x1b[<64;1;2M', false)?.action, 'move');
  assert.equal(dispatchCanvasInput(idle, '\x1b[<64;1;2M', false)?.amount, -1);
  assert.equal(dispatchCanvasInput(idle, '\x1b[<65;1;2M', false)?.action, 'move');
  assert.equal(dispatchCanvasInput(idle, '\x1b[<65;1;2M', false)?.amount, 1);
  const click = dispatchCanvasInput(idle, '\x1b[<0;4;8M', false);
  assert.equal(click?.action, 'click');
  assert.equal(click?.row, 8);
  assert.equal(click?.col, 4);
  assert.equal(dispatchRunningKeys('o'), undefined);
  assert.equal(dispatchRunningKeys('\r')?.action, 'toggle-fold');
});

test('recognizes SGR pointer input so selection mode can yield it to the terminal', () => {
  assert.equal(isSgrMouseInput('\x1b[<64;1;2M'), true);
  assert.equal(isSgrMouseInput('\x1b[<0;4;8M'), true);
  assert.equal(isSgrMouseInput('\x1b[A'), false);
});

test('list pages consume SGR wheel as up and down', () => {
  assert.equal(dispatchListPointer('\x1b[<64;1;2M')?.action, 'up');
  assert.equal(dispatchListPointer('\x1b[<65;1;2M')?.action, 'down');
  assert.equal(dispatchSessionsInput({ query: '', cursor: 0, searching: false, canLeaveProject: false }, '\x1b[<65;1;2M')?.action, 'down');
  assert.equal(dispatchCandidatePickerInput('\x1b[<64;1;2M')?.action, 'up');
  assert.equal(dispatchCandidatePickerInput('\x1b[<0;2;3M')?.action, 'consume');
});

