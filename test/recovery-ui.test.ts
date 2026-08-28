import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmation, renderTimeline } from '../src/tui/pages/run.js';
import { renderFailure } from '../src/tui/pages/result.js';
import { createTheme } from '../src/tui/theme.js';

test('recovery prepare screen shows session and project instead of a preflight gate', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: undefined, elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
    preparePhase: 'check',
    prepareDetail: 'Preparing recovery environment',
    taskTitle: 'Fix the failing test',
    workspaceProject: 'Reprise',
  }).join('\n');
  assert.match(text, /Recovering session/);
  assert.match(text, /Fix the failing test/);
  assert.match(text, /Reprise/);
  assert.match(text, /Preparing recovery environment/);
  assert.doesNotMatch(text, /Candidate preflight|Cannot continue/);
});

test('confirmation headline uses Recovered, Partial recovery, or Could not recover', () => {
  const theme = createTheme(120, false);
  const base = {
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3 as const,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
  };
  const recovered = renderConfirmation(theme, 120, {
    ...base,
    preflight: { sourceBaseline: 'available', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'recovered' },
  } as never).join('\n');
  const partial = renderConfirmation(theme, 120, {
    ...base,
    preflight: { sourceBaseline: 'partial', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'recovered_partial' },
  } as never).join('\n');
  const failed = renderConfirmation(theme, 120, {
    ...base,
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(recovered, /Recovered/);
  assert.match(partial, /Partial recovery/);
  assert.match(failed, /Could not recover/);
  assert.doesNotMatch(recovered, /recovered_partial/);
});

test('failure page uses the user-facing could-not-recover title', () => {
  const theme = createTheme(120, false);
  const text = renderFailure(theme, 120, 'workspace.symlink_skipped').join('\n');
  assert.match(text, /Could not recover/);
  assert.doesNotMatch(text, /Cannot continue/);
});
