import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmation, renderTimeline } from '../../src/tui/pages/run.js';
import { renderFailure } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';
import { formatRecoveryFailureSummary } from '../../src/tui/i18n.js';

test('Recovery agent failure copy separates upstream and credentials from invalid workspace recovery', () => {
  const transient = formatRecoveryFailureSummary('zh', 'agent_model_failed', { agentFailureKind: 'transient_upstream' });
  assert.match(transient, /恢复 Agent.*暂时失败.*重试/);
  const authentication = formatRecoveryFailureSummary('en', 'agent_model_failed', { agentFailureKind: 'authentication' });
  assert.match(authentication, /Recovery agent.*provider credentials/);
  assert.doesNotMatch(authentication, /Temporary failure/);
});

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
  assert.match(failed, /Cannot start isolated candidate/);
  assert.doesNotMatch(failed, /Start isolated Codex Candidate/);
  assert.doesNotMatch(failed, /prepared isolated state/);
  assert.doesNotMatch(failed, /对照会从/);
  assert.match(recovered, /Start isolated Codex Candidate/);
  assert.match(recovered, /Original directory stays unchanged/);
  assert.doesNotMatch(recovered, /Maximum requests|Network \/ billing|Changed paths/);
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
    recovery: { status: 'partial', unresolved: ['Workspace also changed extra.txt without a matching manifest action.'], changedPathCount: 16, skippedPaths: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }] },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'partial', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: ['Workspace also changed extra.txt without a matching manifest action.'], comparisonClass: 'recovered_partial' },
  } as never).join('\n');
  assert.match(text, /部分恢复/);
  assert.match(text, /不是任务开始/);
  assert.doesNotMatch(text, /变更路径/);
  assert.doesNotMatch(text, /跳过路径/);
  assert.doesNotMatch(text, /ppt_build\/node_modules/);
  assert.doesNotMatch(text, /未决/);
  assert.doesNotMatch(text, /extra\.txt/);
  assert.doesNotMatch(text, /无法启动隔离/);
  assert.match(text, /启动隔离的 Codex 候选/);
  assert.match(text, /原目录不变/);
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
      failureSummary: formatRecoveryFailureSummary('zh', 'provider_validation_failed', { changedPathCount: 0 }),
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /无法启动隔离候选/);
  assert.match(text, /没有观察到隔离工作区变更/);
  assert.match(text, /no_task_path_outcome/);
  assert.doesNotMatch(text, /工作区校验未通过/);
  assert.doesNotMatch(text, /对照会从/);
});

test('confirmation with workspace changes still reports validation failure', () => {
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
      changedPathCount: 3,
      failureSummary: formatRecoveryFailureSummary('zh', 'provider_validation_failed', { changedPathCount: 3 }),
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /无法启动隔离候选/);
  assert.match(text, /工作区校验未通过/);
  assert.doesNotMatch(text, /没有观察到隔离工作区变更/);
});

test('generic failure page does not misclassify every phase as recovery', () => {
  const theme = createTheme(120, false);
  const text = renderFailure(theme, 120, 'workspace.symlink_skipped').join('\n');
  assert.match(text, /Cannot continue/);
  assert.doesNotMatch(text, /Could not recover/);
});
