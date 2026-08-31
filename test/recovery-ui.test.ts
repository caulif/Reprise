import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmation, renderTimeline } from '../src/tui/pages/run.js';
import { renderFailure } from '../src/tui/pages/result.js';
import { createTheme } from '../src/tui/theme.js';
import { formatRecoveryFailureSummary } from '../src/tui/i18n.js';

test('recovery canvas does not impersonate a candidate reply', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
    runPhase: 'recovery',
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /恢复活动/);
  assert.match(text, /正在隔离工作区里恢复/);
  assert.doesNotMatch(text, /发给 Codex/);
  assert.doesNotMatch(text, /正在写回复/);
});

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
  assert.doesNotMatch(text, /candidate model|用候选模型重做/);
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
  assert.match(failed, /Enter will not start Codex/);
  assert.doesNotMatch(recovered, /Enter will not start/);
  assert.match(failed, /Cannot start isolated Codex Candidate/);
  assert.doesNotMatch(failed, /Start isolated Codex Candidate/);
  assert.doesNotMatch(failed, /prepared isolated state/);
  assert.doesNotMatch(failed, /对照会从/);
  assert.match(recovered, /Start isolated Codex Candidate/);
  assert.match(recovered, /prepared isolated state/);
});

test('confirmation with accept stays partial and startable', () => {
  const theme = createTheme(120, false);
  const text = renderConfirmation(theme, 120, {
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    locale: 'zh',
    recovery: { status: 'partial', unresolved: ['Workspace also changed extra.txt without a matching manifest action.'], changedPathCount: 16 },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'partial', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: ['Workspace also changed extra.txt without a matching manifest action.'], comparisonClass: 'recovered_partial' },
  } as never).join('\n');
  assert.match(text, /部分恢复/);
  assert.doesNotMatch(text, /无法启动隔离/);
  assert.match(text, /启动隔离的 Codex 候选/);
});

test('confirmation without accept explains validation failure in Chinese', () => {
  const theme = createTheme(120, false);
  const text = renderConfirmation(theme, 120, {
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    locale: 'zh',
    recovery: {
      status: 'failed',
      unresolved: [],
      changedPathCount: 0,
      failureSummary: formatRecoveryFailureSummary('zh', 'provider_validation_failed'),
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /无法启动隔离的 Codex 候选/);
  assert.match(text, /工作区校验未通过/);
  assert.match(text, /provider_validation_failed/);
  assert.doesNotMatch(text, /对照会从/);
  const diagnostic = [...text.matchAll(/恢复诊断.*/g)].map((row) => row[0]).join('\n');
  assert.doesNotMatch(diagnostic, /^恢复诊断\s+provider_validation_failed$/);
});

test('failure page uses the user-facing could-not-recover title', () => {
  const theme = createTheme(120, false);
  const text = renderFailure(theme, 120, 'workspace.symlink_skipped').join('\n');
  assert.match(text, /Could not recover/);
  assert.doesNotMatch(text, /Cannot continue/);
});
