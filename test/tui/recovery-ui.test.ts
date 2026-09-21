import test from 'node:test';
import assert from 'node:assert/strict';
import { renderConfirmation, renderTimeline } from '../../src/tui/pages/run.js';
import { renderFailure } from '../../src/tui/pages/result.js';
import { createTheme } from '../../src/tui/theme.js';
import { formatRecoveryFailureSummary } from '../../src/tui/i18n.js';
import { projectWorkbenchView } from '../../src/tui/view-projection.js';

test('Recovery agent failure copy separates upstream and credentials from invalid workspace recovery', () => {
  const transient = formatRecoveryFailureSummary('zh', 'agent_model_failed', { agentFailureKind: 'transient_upstream' });
  assert.match(transient, /恢复 Agent.*暂时失败.*重试/);
  const authentication = formatRecoveryFailureSummary('en', 'agent_model_failed', { agentFailureKind: 'authentication' });
  assert.match(authentication, /Recovery agent.*provider credentials/);
  assert.doesNotMatch(authentication, /Temporary failure/);
});

test('failed confirmation exposes user decision facts and keeps the candidate disabled', () => {
  const text = renderConfirmation(createTheme(120, false), 120, {
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: 'C:\\workspace',
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    locale: 'zh',
    experimentId: 'exp-decision',
    recovery: {
      status: 'failed',
      unresolved: [],
      changedPathCount: 0,
      failureSummary: '内部 warning 不应成为用户解释',
      failureCategory: 'transient',
      retryable: true,
      failureAction: 'retry',
      sourceUnchanged: true,
      candidateStarted: false,
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /发生了什么/);
  assert.match(text, /内部模型暂时失败/);
  assert.match(text, /影响/);
  assert.match(text, /候选未启动/);
  assert.match(text, /原始目录未被修改/);
  assert.match(text, /是否可重试/);
  assert.match(text, /可以重试/);
  assert.match(text, /下一步/);
  assert.match(text, /重试恢复/);
  assert.doesNotMatch(text, /内部 warning 不应成为用户解释/);
  assert.doesNotMatch(text, /启动隔离的 Codex 候选/);
});

test('source tripwire failure never claims that the original directory was unchanged', () => {
  const view = projectWorkbenchView({
    page: 'confirm',
    locale: 'en',
    modelConfig: { providerId: 'fixture', modelId: 'gpt-5', effort: 'high' },
    sourceRoot: 'C:\\workspace',
    recoveryView: {
      experimentRoot: 'C:\\data\\experiments\\exp-tripwire',
      experimentId: 'exp-tripwire',
      baseline: {
        mode: 'canonical',
        recovery: { status: 'failed', failureStage: 'source_tripwire_failed', unresolved: [] },
      },
      providerPreview: { changedPaths: [] },
      recovery: { status: 'failed', failure: { message: 'source changed' } },
      hasAccept: false,
    },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
    timeline: [],
    intakeLevel: 'projects',
    products: [],
    visibleProjects: [],
    activeProjectKey: '',
    visibleSessions: [],
    selected: 0,
    filterEligible: false,
    searchQuery: '',
    searchCursor: 0,
    searching: false,
  } as never);
  assert.equal(view.confirm?.recovery?.sourceUnchanged, false);
});

test('recovery canvas does not impersonate a candidate reply', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [],
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    runPhase: 'recovery',
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /恢复/);
  assert.match(text, /正在隔离工作区里恢复/);
  assert.doesNotMatch(text, /发给 Codex/);
  assert.doesNotMatch(text, /正在写回复/);
});

test('recovery prepare screen shows session and project instead of a preflight gate', async () => {
  const { renderPrepareSummary } = await import('../../src/tui/pages/recovery-summary.js');
  const theme = createTheme(120, false);
  const text = renderPrepareSummary(theme, 120, {
    entries: [],
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 },
    preparePhase: 'check',
    prepareDetail: 'Preparing recovery environment',
    taskTitle: 'Fix the failing test',
    workspaceProject: 'Reprise',
  }, 'en').join('\n');
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
  assert.match(text, /限制/);
  assert.match(text, /extra\.txt/);
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
    experimentId: 'exp-gate-fail',
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
  assert.match(text, /诊断已保存 · experiments\/exp-gate-fail\/recovery-diagnosis\.json/);
  assert.doesNotMatch(text, /工作区校验未通过/);
  assert.doesNotMatch(text, /对照会从/);
  // L1: failure reason appears before the Recovery field inside the panel.
  const titleAt = text.indexOf('无法启动隔离候选');
  const body = text.slice(titleAt);
  const failureAt = body.search(/没有观察到隔离工作区变更/);
  const recoveryFieldAt = body.search(/恢复/);
  assert.ok(failureAt >= 0 && recoveryFieldAt >= 0 && failureAt < recoveryFieldAt);
});

test('failed confirm keeps failureSummary visible and does not select the evidence fold', async () => {
  const { renderWorkbench } = await import('../../src/tui/workbench.js');
  const failureSummary = formatRecoveryFailureSummary('zh', 'agent_model_failed', { agentFailureKind: 'transient_upstream' });
  const foldTitle = '▸ 阅读证据 · 54';
  const theme = createTheme(120, true);
  const foldEntry = {
    sequence: 1,
    occurredAt: '2026-09-08T00:00:00.000Z',
    source: 'HARNESS' as const,
    title: foldTitle,
    lane: 'recovery' as const,
    kind: 'fold' as const,
    itemId: 'fold:1',
  };
  const selectedFold = renderTimeline(theme, 120, {
    entries: [foldEntry],
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:48', turns: { used: 0 }, calls: { used: 0 },
  }).join('\n');
  const noHighlight = renderTimeline(theme, 120, {
    entries: [foldEntry],
    selected: -1, filter: 'ALL', following: false, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:48', turns: { used: 0 }, calls: { used: 0 },
  }).join('\n');
  // Selected paint uses fillLive (30;38;42); selected:-1 uses canvas fill and must not invent ▼ 新 N.
  assert.match(selectedFold, /48;2;30;38;42/);
  assert.doesNotMatch(noHighlight, /48;2;30;38;42/);
  assert.match(noHighlight, /阅读证据 · 54/);
  assert.doesNotMatch(noHighlight, /新 \d+| \d+ new/);

  const rendered = renderWorkbench({
    page: 'confirm',
    cwd: 'C:\\workspace',
    hasApiConfig: true,
    hasTaskCase: true,
    message: '',
    productLabel: 'Codex',
    locale: 'zh',
    confirm: {
      candidate: undefined,
      step: 3,
      sourceRoot: 'C:\\workspace',
      effort: 'high',
      harnessModel: 'gpt-5',
      harnessAuthOk: true,
      productLabel: 'Codex',
      locale: 'zh',
      experimentId: 'exp-r1b',
      recovery: {
        status: 'failed',
        unresolved: [],
        changedPathCount: 0,
        failureSummary,
      },
      preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
    } as never,
    running: {
      entries: [
        { sequence: 1, occurredAt: '2026-09-08T00:00:00.000Z', source: 'HARNESS', title: 'I will start by reading the task text.', lane: 'recovery', kind: 'narrate' },
        { sequence: 2, occurredAt: '2026-09-08T00:00:01.000Z', source: 'HARNESS', title: foldTitle, lane: 'recovery', kind: 'fold', itemId: 'fold:1' },
      ],
      selected: -1, filter: 'ALL', following: false, cancelUi: 'idle' as const,
      currentState: undefined, elapsed: '00:48', turns: { used: 0 }, calls: { used: 0 },
    },
  }, 120).join('\n');

  assert.match(rendered, /无法启动隔离候选/);
  assert.match(rendered, /恢复 Agent.*暂时失败|暂时失败/);
  assert.match(rendered, /诊断已保存 · experiments\/exp-r1b\/recovery-diagnosis\.json/);
  // T08: confirm leads with the confirmation panel — recovery process is folded, not a full timeline dump.
  assert.match(rendered, /查看恢复过程|View recovery process/);
  assert.doesNotMatch(rendered, /阅读证据 · 54/);
  assert.doesNotMatch(rendered, /48;2;30;38;42/);
  assert.doesNotMatch(rendered, /新 \d+| \d+ new/);

  const expanded = renderWorkbench({
    page: 'confirm',
    cwd: 'C:\\workspace',
    hasApiConfig: true,
    hasTaskCase: true,
    message: '',
    productLabel: 'Codex',
    locale: 'zh',
    processExpanded: true,
    surfaceScope: 'recovery',
    confirm: {
      candidate: undefined,
      step: 3,
      sourceRoot: 'C:\\workspace',
      effort: 'high',
      harnessModel: 'gpt-5',
      harnessAuthOk: true,
      productLabel: 'Codex',
      locale: 'zh',
      experimentId: 'exp-r1b',
      recovery: {
        status: 'failed',
        unresolved: [],
        changedPathCount: 0,
        failureSummary,
      },
      preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
    } as never,
    running: {
      entries: [
        { sequence: 1, occurredAt: '2026-09-08T00:00:00.000Z', source: 'HARNESS', title: 'I will start by reading the task text.', lane: 'recovery', kind: 'narrate' },
        { sequence: 2, occurredAt: '2026-09-08T00:00:01.000Z', source: 'HARNESS', title: foldTitle, lane: 'recovery', kind: 'fold', itemId: 'fold:1' },
      ],
      selected: -1, filter: 'ALL', following: false, cancelling: false,
      currentState: undefined, elapsed: '00:48', turns: { used: 0 }, calls: { used: 0 },
    },
  }, 120).join('\n');
  assert.match(expanded, /阅读证据 · 54/);
});

test('observational confirm without failed status does not claim diagnostics saved', () => {
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
    experimentId: 'exp-obs',
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /无法启动隔离候选/);
  assert.match(text, /Could not recover|无法恢复/);
  assert.doesNotMatch(text, /诊断已保存/);
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
  assert.match(text, /恢复后的工作副本未通过 Host 校验/);
  assert.doesNotMatch(text, /没有观察到隔离工作区变更/);
});

test("confirmation for blocked recovery shows the Agent summary without crash copy", () => {
  const theme = createTheme(120, false);
  const text = renderConfirmation(theme, 120, {
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    locale: 'en',
    recovery: {
      status: 'blocked',
      summary: 'The original spreadsheet is missing from source.',
      unresolved: ['workbook.xlsx'],
      changedPathCount: 0,
    },
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    preflight: { sourceBaseline: 'unavailable', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'observational' },
  } as never).join('\n');
  assert.match(text, /Missing a required input; retry after it is supplied/);
  assert.match(text, /The original spreadsheet is missing from source\./);
  assert.doesNotMatch(text, /Could not recover/);
  assert.doesNotMatch(text, /provider_validation_failed/);
});

test('generic failure page does not misclassify every phase as recovery', () => {
  const theme = createTheme(120, false);
  const text = renderFailure(theme, 120, 'workspace.symlink_skipped').join('\n');
  assert.match(text, /Cannot continue/);
  assert.doesNotMatch(text, /Could not recover/);
});

test('workbench folds recovery process above confirmation until expanded', async () => {
  const { renderWorkbench } = await import('../../src/tui/workbench.js');
  const base = {
    page: 'confirm' as const,
    cwd: 'C:\\workspace',
    hasApiConfig: true,
    hasTaskCase: true,
    message: '',
    productLabel: 'Codex',
    confirm: {
      candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
      step: 3,
      sourceRoot: 'C:\\workspace',
      effort: 'high',
      harnessModel: 'gpt-5',
      harnessAuthOk: true,
      productLabel: 'Codex',
      preflight: { sourceBaseline: 'available', resolved: { executable: 'codex', resolvedModel: 'gpt-5' }, limitations: [], comparisonClass: 'recovered' },
    } as never,
    running: {
      entries: [
        { sequence: 1, occurredAt: '2026-09-08T00:00:00.000Z', source: 'HARNESS', title: 'Read package.json', detail: 'Read package.json', lane: 'recovery', kind: 'narrate' },
      ],
      selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
      currentState: undefined, elapsed: '00:05', turns: { used: 0 }, calls: { used: 0 },
    },
  };
  const folded = renderWorkbench(base as never, 120).join('\n');
  assert.doesNotMatch(folded, /Read package\.json/);
  assert.match(folded, /Recovered/);
  assert.match(folded, /Start isolated Codex Candidate/);
  assert.match(folded, /View recovery process|查看恢复过程/);

  const expanded = renderWorkbench({ ...base, processExpanded: true, surfaceScope: 'recovery' } as never, 120).join('\n');
  assert.match(expanded, /Read package\.json/);
  assert.match(expanded, /Recovered/);
});
