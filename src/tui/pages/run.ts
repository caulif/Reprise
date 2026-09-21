import type { ExperimentPreflight } from '../../application/experiment-preflight.js';
import type { CandidateRunState, CandidateSpec, RunPolicy } from '../../core/schema.js';
import { runningFooterHints } from '../action-model.js';
import { selectedIndexAfterFold } from '../fold-process.js';
import { projectTimelineView } from '../timeline-view.js';
import { formatBytes, truncateFit, type TimelineFilter } from '../format.js';
import { t, type Locale } from '../i18n.js';
import { activityDetailModel, renderActivityDetail, showsActivityDetailSidebar } from '../overlays.js';
import { matchesFilter, renderScrollback } from '../scrollback.js';
import { canvasHitIndices } from '../timeline-read.js';
import { caretAt } from '../text-edit.js';
import type { Theme } from '../theme.js';
import type { TimelineEntry } from '../timeline.js';
import { kv, pad, panel, stateRail, type PreparePhase } from '../widgets.js';
import { joinColumns } from '../widgets.js';
import type { CandidateRunPhase } from '../../application/candidate-run-phase.js';
import {
  activityRoleFromDiagnostics,
  countActiveParallel,
  deriveStaleHint,
  roleMessageKey,
  uiStageFrom,
  uiStageLabelKey,
  type ActivityRole,
  type PhaseClockBounds,
  type UiStage,
} from '../phase-state.js';

export type { CandidateRunPhase, ActivityRole, UiStage, PhaseClockBounds };

export type SourceModel = { readonly sourceRoot: string; readonly sourceCursor?: number; readonly step: 1 | 2 | 3; readonly locale?: Locale };
export type RecoveryPreviewModel = {
  readonly status: 'ready' | 'blocked' | 'recovered' | 'partial' | 'insufficient_evidence' | 'failed';
  readonly summary?: string;
  readonly reportText?: string;
  readonly unresolved: readonly string[];
  readonly changedPathCount: number;
  readonly skippedPaths?: readonly { readonly path: string; readonly reasonCode: string }[];
  readonly failureSummary?: string;
  readonly failureCategory?: string;
  readonly retryable?: boolean;
  readonly failureAction?: 'retry' | 'config' | 'refreeze' | 'diagnose' | 'return';
  readonly sourceUnchanged?: boolean;
  readonly candidateStarted?: boolean;
};
export type PreflightModel = {
  readonly preflight: ExperimentPreflight;
  readonly candidate: CandidateSpec | undefined;
  readonly step: 1 | 2 | 3;
  readonly recovery?: RecoveryPreviewModel;
  readonly locale?: Locale;
  readonly productLabel?: string;
};
export type ConfirmModel = PreflightModel & {
  readonly sourceRoot: string;
  readonly effort: string;
  readonly harnessModel?: string;
  readonly policy?: RunPolicy;
  readonly harnessAuthOk?: boolean;
  readonly sourceProductLabel?: string;
  readonly experimentId?: string;
  readonly taskTitle?: string;
};
export type RunningModel = {
  readonly entries: readonly TimelineEntry[];
  readonly selected: number;
  readonly filter: TimelineFilter;
  readonly following: boolean;
  readonly cancelUi?: 'idle' | 'requesting' | 'failed' | 'settled';
  readonly cancelling?: boolean;
  readonly currentState: CandidateRunState | undefined;
  readonly elapsed: string;
  readonly turns: { readonly used: number; readonly max?: number };
  readonly calls: { readonly used: number; readonly max?: number };
  readonly policy?: RunPolicy;
  readonly preparePhase?: PreparePhase;
  readonly prepareDetail?: string;
  readonly locale?: Locale;
  readonly taskTitle?: string;
  readonly workspaceProject?: string;
  readonly productLabel?: string;
  readonly candidateModel?: string;
  readonly finding?: boolean;
  readonly findQuery?: string;
  readonly findCursor?: number;
  readonly readingOffset?: number;
  readonly readingMode?: boolean;
  readonly tick?: number;
  readonly runPhase?: CandidateRunPhase;
  readonly lastRuntimeEventAt?: string;
  readonly lastObservedEventAt?: string;
  readonly lastVisibleActivityAt?: string;
  readonly lastRuntimeEventKind?: string;
  readonly modelOutputSeen?: boolean;
  readonly reconnectCount?: number;
  readonly reconnectTotal?: number;
  readonly runStartedAt?: number;
  readonly phaseClocks?: PhaseClockBounds;
  readonly activityRole?: ActivityRole;
  readonly uiStage?: UiStage;
  readonly activeParallel?: number;
  readonly comparisonAttemptId?: string;
  readonly expandedFolds?: readonly string[];
  readonly activityDetail?: TimelineEntry;
  readonly activityDetailOffset?: number;
  readonly candidateSessionId?: string;
  readonly sourceTimeline?: readonly TimelineEntry[];
  readonly timelineRevision?: number;
  readonly recoveryPhase?: TimelineEntry['recoveryPhase'];
  readonly recoveryAttemptNumber?: number;
  readonly recoveryRetry?: number;
  readonly recoveryFallback?: boolean;
  readonly recentVisibleActivity?: string;
  readonly recentVisibleActivityAt?: string;
};

function renderStep(theme: Theme, step: 1 | 2 | 3, labels: readonly [string, string, string], locale: Locale): string {
  const g = theme.glyphs;
  const marks = [1, 2, 3].map((index) => {
    if (index < step) return g.ok;
    if (index === step) return g.dot;
    return g.empty;
  });
  return ` ${t(locale, 'stepOf3', { step })} ${g.h} ${labels[step - 1]}      ${marks.join(`${g.h}${g.h}`)}`;
}

export function renderSource(theme: Theme, width: number, model: SourceModel): string[] {
  const locale = model.locale ?? 'en';
  return panel(theme, t(locale, 'sourceTitle'), [
    ` ${caretAt(model.sourceRoot, model.sourceCursor ?? model.sourceRoot.length)}`,
    '',
    ` ${t(locale, 'sourceMissing')}`,
  ], width);
}

export function renderPreflight(theme: Theme, width: number, model: PreflightModel): string[] {
  const locale = model.locale ?? 'en';
  const { preflight, candidate } = model;
  const comparison = localizedComparison(preflight.comparisonClass, locale);
  return [
    renderStep(theme, 2, [t(locale, 'sourceTitle'), t(locale, 'preflightStep'), t(locale, 'confirmStep')], locale),
    '',
    ...panel(theme, t(locale, 'preflightTitle'), [
      kv(theme, t(locale, 'candidateLabel'), `${candidate?.requestedModel ?? t(locale, 'unavailableValue')} ${theme.glyphs.sep} ${t(locale, 'runtimeResolved')} ${preflight.resolved.resolvedModel}`, width - 2),
      kv(theme, t(locale, 'runtimeLabel'), `${preflight.resolved.executable}${preflight.resolved.version ? ` ${theme.glyphs.sep} ${preflight.resolved.version}` : ''}`, width - 2),
      kv(theme, t(locale, 'baselineLabel'), `${preflight.sourceBaseline === 'available' ? t(locale, 'availableValue') : preflight.sourceBaseline} ${theme.glyphs.sep} ${t(locale, 'comparisonLabel')} ${comparison}`, width - 2),
      ...(preflight.workspace ? [
        kv(theme, t(locale, 'filesLabel'), preflight.workspace.fileCount.toLocaleString(), width - 2),
        kv(theme, t(locale, 'sourceSizeLabel'), formatBytes(preflight.workspace.totalBytes), width - 2),
        kv(theme, t(locale, 'largestFileLabel'), formatBytes(preflight.workspace.largestFileBytes), width - 2),
      ] : []),
      kv(theme, t(locale, 'statusLabel'), preflight.workspace?.blockedReasons.length ? `${t(locale, 'blockedValue')} ${dash(theme)} ${preflight.workspace.blockedReasons.join(' | ')}` : t(locale, 'runnableValue'), width - 2),
      kv(theme, t(locale, 'limitationsLabel'), preflight.limitations.length ? preflight.limitations.join(' | ') : t(locale, 'noneRecorded'), width - 2),
      ...(preflight.contamination ? [
        kv(theme, t(locale, 'preparationLabel'), t(locale, 'recoveryPrepared'), width - 2),
      ] : []),
    ], width),
  ];
}

export function renderConfirmation(theme: Theme, width: number, model: ConfirmModel): string[] {
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  const recovery = model.recovery;
  const canStart = confirmCanStart(model);
  const recoveryRunnable = model.preflight.comparisonClass !== 'observational' && recovery?.status !== 'failed' && recovery?.status !== 'blocked';
  const blockedRecovery = recovery?.status === 'blocked';
  const failedRecovery = recovery?.status === 'failed';
  const cross = Boolean(model.sourceProductLabel && model.sourceProductLabel !== product);
  const startWarning = !canStart
    ? (model.harnessAuthOk === false
      ? t(locale, 'warningCannotStart', { product })
      : blockedRecovery
        ? (recovery?.summary ?? t(locale, 'warningCannotStartBlockedRecovery', { product }))
        : failureWarning(recovery, locale, product))
    : t(locale, 'warningStartsProcess', { product });
  const warningLine = canStart || blockedRecovery
    ? theme.style.warn(` ${theme.glyphs.warn}  ${startWarning}`)
    : theme.style.danger(` ${theme.glyphs.warn}  ${startWarning}`);
  const diagnosisHint = failedRecovery && model.experimentId
    ? theme.style.muted(` ${t(locale, 'diagnosisSavedHint', { experimentId: model.experimentId })}`)
    : undefined;
  const requested = model.candidate?.requestedModel;
  const resolved = model.preflight.resolved.resolvedModel;
  const effectiveCategory = recovery ? failureCategoryOf(recovery) : undefined;
  const fields = [
    ...(blockedRecovery ? [
      kv(theme, t(locale, 'recoveryWhatHappened'), recovery?.summary ?? t(locale, 'warningCannotStartBlockedRecovery', { product }), width - 2),
      kv(theme, t(locale, 'recoveryImpact'), t(locale, 'recoveryBlockedImpact'), width - 2),
      kv(theme, t(locale, 'recoveryNextStep'), t(locale, 'recoveryBlockedNextStep'), width - 2),
    ] : []),
    ...(failedRecovery && recovery?.failureSummary ? [
      kv(theme, t(locale, 'recoveryWhatHappened'), truncateFit(failureHappenedLabel(effectiveCategory, locale), Math.max(24, width - 18), theme.glyphs.ellipsis), width - 2),
      kv(theme, t(locale, 'recoveryFailureType'), failureCategoryLabel(effectiveCategory, locale), width - 2),
      kv(theme, t(locale, 'recoveryRetryability'), t(locale, recovery.retryable ?? (effectiveCategory === 'transient' || effectiveCategory === 'protocol') ? 'recoveryRetryable' : 'recoveryNotRetryable'), width - 2),
      kv(theme, t(locale, 'recoveryImpact'), `${t(locale, 'recoveryCandidateNotStarted')} ${recovery.sourceUnchanged ? t(locale, 'recoverySourceSafe') : ''}`.trim(), width - 2),
      kv(theme, t(locale, 'recoveryNextStep'), recoveryActionLabel(recovery.failureAction ?? (effectiveCategory === 'transient' ? 'retry' : effectiveCategory === 'authentication' ? 'config' : 'diagnose'), locale), width - 2),
    ] : []),
    ...(model.taskTitle ? [kv(theme, t(locale, 'taskLabel'), truncateFit(model.taskTitle, Math.max(24, width - 18), theme.glyphs.ellipsis), width - 2)] : []),
    ...(model.sourceProductLabel ? [kv(theme, t(locale, 'sourceProductLabel'), model.sourceProductLabel, width - 2)] : []),
    kv(theme, t(locale, 'candidateLabel'), product, width - 2),
    kv(theme, t(locale, 'requestedModelLabel'), requested ?? t(locale, 'unavailableValue'), width - 2),
    kv(theme, t(locale, 'resolvedModelLabel'), resolved || t(locale, 'unavailableValue'), width - 2),
    kv(theme, t(locale, 'recoveryField'), recoveryWord(model, locale), width - 2),
    ...(model.recovery?.summary ? [kv(theme, t(locale, 'recoverySummaryField'), truncateFit(model.recovery.summary, Math.max(24, width - 18), theme.glyphs.ellipsis), width - 2)] : []),
    kv(theme, t(locale, 'limitationsLabel'), model.preflight.limitations.length ? model.preflight.limitations.join(' | ') : t(locale, 'noneRecorded'), width - 2),
    ...(model.recovery?.status === 'partial' ? [theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'confirmPartialNotZero')}`)] : []),
    ...(cross ? [theme.style.muted(` ${t(locale, 'crossProductNote')}`)] : []),
  ];
  const startOk = canStart ? [theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'confirmCopySafe')}`)] : [];
  // Failed confirm: human failure reason is L1 — before candidate/recovery fields so the fold above cannot outrank it.
  const body = failedRecovery && !canStart
    ? [warningLine, ...(diagnosisHint ? [diagnosisHint] : []), '', ...fields, ...startOk]
    : [...fields, '', warningLine, ...startOk];
  return [
    renderStep(theme, 3, [t(locale, 'sourceTitle'), t(locale, 'preflightStep'), t(locale, 'confirmStep')], locale),
    '',
    ...panel(theme, t(locale, recoveryRunnable ? 'confirmTitle' : 'confirmTitleBlocked', { product }), body, width),
  ];
}

export function confirmCanStart(model: ConfirmModel): boolean {
  if (model.harnessAuthOk === false) return false;
  if (model.preflight.comparisonClass === 'observational') return false;
  if (model.recovery?.status === 'failed' || model.recovery?.status === 'blocked') return false;
  if (model.recovery && !model.candidate) return false;
  return true;
}

function recoveryWord(model: ConfirmModel, locale: Locale): string {
  const status = model.recovery?.status;
  if (status === 'partial') return t(locale, 'userPartial');
  if (status === 'blocked') return t(locale, 'userBlocked');
  if (status === 'ready') return t(locale, 'userRecovered');
  if (status === 'failed') return t(locale, 'userFailed');
  if (status === 'recovered') return t(locale, 'userRecovered');
  return userRecoveryHeadline(model.preflight.comparisonClass, locale);
}

export function runningChrome(theme: Theme, width: number, model: RunningModel): string[] {
  if (isPreparing(model)) return [];
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  const agent = model.candidateModel ? `${product} · ${model.candidateModel}` : product;
  const wait = waitLine(model, locale);
  const stage = model.uiStage ?? uiStageFrom(model);
  const role = model.activityRole ?? activityRoleFromDiagnostics(model);
  const parallel = model.activeParallel ?? countActiveParallel(model.entries);
  const stageLine = stage
    ? theme.style.muted(` ${t(locale, uiStageLabelKey(stage))}${parallel > 1 ? ` · ×${parallel}` : ''}`)
    : undefined;
  if (model.runPhase === 'recovery' || stage === 'recovery_processing') {
    const rows = [
      ...(stageLine ? [stageLine] : []),
      ...(model.recoveryPhase ? [theme.style.muted(` ${t(locale, 'recoveryPhaseLabel', { phase: recoveryPhaseLabel(model.recoveryPhase, locale) })}${model.recoveryAttemptNumber ? ` · ${t(locale, 'recoveryAttemptLabel', { attempt: model.recoveryAttemptNumber })}` : ''}`)] : []),
      ...(model.recoveryRetry ? [theme.style.warn(` ${t(locale, 'recoveryRetryLabel', { attempt: model.recoveryRetry })}`)] : []),
      ...(model.recoveryFallback ? [theme.style.warn(` ${t(locale, 'recoveryFallbackLabel')}`)] : []),
      ...(model.recentVisibleActivity ? [theme.style.muted(` ${t(locale, 'recoveryRecentActivity', { activity: model.recentVisibleActivity, seconds: visibleAgeSeconds(model.recentVisibleActivityAt, model.tick) })}`)] : []),
      ...(wait ? [theme.style.muted(` ${wait}`), theme.style.muted(` ${t(locale, 'recoveryWaitingHost')}`)] : []),
    ];
    return rows.map((row) => theme.style.fillCanvas(pad(row, width, theme.glyphs.ellipsis)));
  }
  const comparing = model.preparePhase === 'compare' || stage === 'comparison_processing';
  const special = model.runPhase === 'candidate_reconnecting'
    || model.runPhase === 'candidate_starting'
    || comparing
    || stage === 'controller_opening'
    || stage === 'awaiting_controller'
    || stage === 'finalizing';
  const task = model.taskTitle
    ? truncateFit(model.taskTitle, Math.max(8, width - agent.length - 10), theme.glyphs.ellipsis)
    : '';
  const line = special
    ? phaseLine(model, locale, agent, stage, role)
    : (task ? `${task} · ${agent} · ${model.elapsed}` : `${agent} · ${model.elapsed}`);
  const rail = model.currentState && width >= 78 && !comparing
    ? stateRail(theme, model.currentState, width).slice(0, 1)
    : [];
  return [
    ...rail,
    ...(stageLine ? [stageLine] : []),
    line,
    ...(wait ? [theme.style.muted(` ${wait}`)] : []),
  ].map((row) =>
    theme.style.fillCanvas(pad(row.startsWith(' ') ? row : ` ${row}`, width, theme.glyphs.ellipsis)),
  );
}

function failureCategoryLabel(category: string | undefined, locale: Locale): string {
  const key = category === 'transient' ? 'recoveryFailureTransient'
    : category === 'authentication' ? 'recoveryFailureAuthentication'
      : category === 'source_changed' ? 'recoveryFailureSourceChanged'
        : category === 'staging_invalid' ? 'recoveryFailureStaging'
          : category === 'protocol' ? 'recoveryFailureProtocol' : 'recoveryFailureOther';
  return t(locale, key);
}

function failureWarning(recovery: RecoveryPreviewModel | undefined, locale: Locale, product: string): string {
  if (!recovery) return t(locale, 'warningCannotStartFailedRecovery', { product });
  // Host validation copy is already a user-facing explanation; model/provider details use the safer category copy.
  const category = failureCategoryOf(recovery);
  if (category === 'staging_invalid' && recovery.failureSummary) return recovery.failureSummary;
  return failureHappenedLabel(category, locale);
}

function failureCategoryOf(recovery: RecoveryPreviewModel): string | undefined {
  if (recovery.failureCategory) return recovery.failureCategory;
  const summary = recovery.failureSummary ?? '';
  if (/暂时失败|temporary|upstream|timeout|rate.?limit/i.test(summary)) return 'transient';
  if (/credentials|凭据|认证|authentication/i.test(summary)) return 'authentication';
  if (/工作副本|工作区变更|validation|校验|no_task_path/i.test(summary)) return 'staging_invalid';
  if (/protocol|协议|invalid output|无法验证/i.test(summary)) return 'protocol';
  return undefined;
}

function failureHappenedLabel(category: string | undefined, locale: Locale): string {
  const key = category === 'transient' ? 'recoveryHappenedTransient'
    : category === 'authentication' ? 'recoveryHappenedAuthentication'
      : category === 'source_changed' ? 'recoveryHappenedSourceChanged'
        : category === 'staging_invalid' ? 'recoveryHappenedStaging'
          : category === 'protocol' ? 'recoveryHappenedProtocol' : 'recoveryHappenedOther';
  return t(locale, key);
}

function recoveryActionLabel(action: RecoveryPreviewModel['failureAction'], locale: Locale): string {
  if (action === 'retry') return t(locale, 'recoveryActionRetry');
  if (action === 'config') return t(locale, 'recoveryActionConfig');
  if (action === 'refreeze') return t(locale, 'recoveryActionRefreeze');
  return t(locale, 'recoveryActionDiagnose');
}

function recoveryPhaseLabel(phase: NonNullable<RunningModel['recoveryPhase']>, locale: Locale): string {
  return t(locale, phase === 'staging' ? 'recoveryPhaseStaging' : phase === 'forensics' ? 'recoveryPhaseForensics' : phase === 'model' ? 'recoveryPhaseModel' : 'recoveryPhaseValidated');
}

function visibleAgeSeconds(occurredAt: string | undefined, now: number | undefined): number {
  if (!occurredAt) return 0;
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.floor(((now ?? Date.now()) - at) / 1000));
}

function phaseLine(
  model: RunningModel,
  locale: Locale,
  product: string,
  stage: UiStage | undefined,
  role: ActivityRole | undefined,
): string {
  if (model.runPhase === 'candidate_reconnecting' || stage === 'candidate_reconnecting') {
    return t(locale, 'candidateReconnecting', {
      product,
      current: model.reconnectCount ?? 0,
      total: model.reconnectTotal || 5,
    });
  }
  if (model.runPhase === 'candidate_starting' || stage === 'candidate_starting') {
    return t(locale, 'candidateStarting', { product });
  }
  if (model.preparePhase === 'compare' || stage === 'comparison_processing') {
    return `${t(locale, 'comparingTitle')} · ${model.elapsed}`;
  }
  if (stage === 'controller_opening' || stage === 'awaiting_controller' || stage === 'finalizing') {
    const label = stage ? t(locale, uiStageLabelKey(stage)) : t(locale, roleMessageKey(role));
    return `${label} · ${model.elapsed}`;
  }
  return t(locale, 'candidateRunningTitle', { product });
}

export function waitLine(model: RunningModel, locale: Locale): string | undefined {
  const now = model.tick ?? Date.now();
  const visibleAt = model.lastVisibleActivityAt ?? model.lastObservedEventAt ?? model.lastRuntimeEventAt;
  const parsedVisible = visibleAt ? Date.parse(visibleAt) : Number.NaN;
  const anchor = Number.isFinite(parsedVisible) && parsedVisible > 0
    ? parsedVisible
    : (model.runStartedAt && model.runStartedAt > 0 ? model.runStartedAt : undefined);
  if (anchor === undefined) return undefined;
  const idle = now - anchor;
  const role = model.activityRole ?? activityRoleFromDiagnostics(model);
  const hint = deriveStaleHint({
    idleMs: idle,
    roleLabel: t(locale, roleMessageKey(role)),
  });
  if (!hint) return undefined;
  return t(locale, hint.key, hint.vars);
}

export function isRecoveryChrome(model: RunningModel): boolean {
  return model.runPhase === 'recovery' || model.preparePhase === 'check';
}

export function renderTimeline(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  // Prepare/check/copy belongs on the recovery summary surface — not mixed into the activity stream.
  if (isPreparing(model)) return [];
  // visibleTimeline already applies ALL filtering; keep the branch for non-ALL replay surfaces.
  const visible = model.filter === 'ALL'
    ? model.entries
    : model.entries.filter((entry) => matchesFilter(entry, model.filter));
  // selected < 0 means no highlight (failed confirm stack); do not clamp to 0.
  const noHighlight = model.selected < 0;
  const selected = noHighlight
    ? -1
    : model.filter === 'ALL'
      ? Math.max(0, Math.min(model.selected, Math.max(0, visible.length - 1)))
      : Math.max(0, visible.findIndex((entry) => entry === model.entries[model.selected]));
  const recovering = model.runPhase === 'recovery';
  const hits = canvasHitIndices(visible, model.findQuery ?? '');
  const hitAt = hits.indexOf(selected < 0 ? -1 : selected);
  const findBar = model.finding ? renderFindBar(model, locale, hits.length, hitAt < 0 ? 0 : hitAt) : [];
  const header = [...findBar, ...(findBar.length ? [''] : [])];
  // Honor the shared body budget exactly — a floor above it over-emits and outer clipLines drops live status.
  const bodyHeight = height === undefined ? undefined : Math.max(0, height - header.length);
  const expanded = new Set(model.expandedFolds ?? []);
  const timelineRevision = model.timelineRevision ?? -1;
  const folded = projectTimelineView(model.sourceTimeline ?? model.entries, visible, expanded, timelineRevision);
  const selectedFolded = noHighlight
    ? -1
    : selectedIndexAfterFold(visible, folded, visible[selected] ?? model.entries[model.selected]);
  // selected < 0 would otherwise count every row as "behind" and paint a false ▼ 新 N.
  const following = noHighlight || model.following;
  const empty = model.finding && (model.findQuery ?? '').trim() && !visible.length
    ? [theme.style.muted(` ${t(locale, 'findNone')}`)]
    : recovering && !visible.length
      ? [
          theme.style.muted(` ${t(locale, 'recoveryEmpty')}`),
          pad(` ${theme.glyphs.dot} working`, width, theme.glyphs.ellipsis),
        ]
      : renderScrollback(theme, width, folded, selectedFolded, locale, product, bodyHeight, model.tick ?? 0, model.readingOffset ?? 0, model.elapsed, following, timelineRevision, expanded);
  const body = [
    ...header.map((line) => theme.style.fillCanvas(pad(line, width, theme.glyphs.ellipsis))),
    ...empty.map((line) => pad(line, width, theme.glyphs.ellipsis)),
  ];
  if (model.activityDetail && showsActivityDetailSidebar(theme) && height !== undefined) {
    const detailWidth = Math.max(28, Math.floor(width * 0.4));
    const mainWidth = Math.max(32, width - detailWidth - 1);
    const main = [
      ...header.map((line) => theme.style.fillCanvas(pad(line, mainWidth, theme.glyphs.ellipsis))),
      ...renderScrollback(theme, mainWidth, folded, selectedFolded, locale, product, bodyHeight, model.tick ?? 0, model.readingOffset ?? 0, model.elapsed, following, timelineRevision, expanded)
        .map((line) => pad(line, mainWidth, theme.glyphs.ellipsis)),
    ];
    const detail = renderActivityDetail(
      theme,
      detailWidth,
      activityDetailModel(model.activityDetail, product, locale),
      locale,
      Math.max(4, (height ?? 16) - 8),
    );
    return joinColumns(main, detail, mainWidth, detailWidth, 1, theme);
  }
  return body;
}

function renderFindBar(model: RunningModel, locale: Locale, total: number, selected: number): string[] {
  const query = model.findQuery ?? '';
  const value = caretAt(query, model.findCursor ?? query.length);
  const count = query.trim() && total === 0 ? t(locale, 'findNone') : t(locale, 'findCount', { current: total ? selected + 1 : 0, total });
  return [` ${t(locale, 'findLabel')} ${value}  ${count}`];
}

function isPreparing(model: RunningModel): boolean {
  return model.preparePhase === 'check' || model.preparePhase === 'copy';
}

export function sourceHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', t(locale, 'hintStartRun')], ['Backspace', t(locale, 'hintEdit')], ['Esc', t(locale, 'hintHome')]];
}

export function preflightHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Esc', t(locale, 'hintHome')]];
}

export function confirmHints(canStart = true, locale: Locale = 'en', recoveryDiagnosis = false): readonly (readonly [string, string])[] {
  if (recoveryDiagnosis) {
    return [['Enter', t(locale, 'hintTryBlocked')], ['Esc', t(locale, 'hintHome')]];
  }
  if (!canStart) {
    return [
      ['Enter', t(locale, 'hintTryBlocked')],
      ['b', t(locale, 'hintChangeModel')],
      ['Esc', t(locale, 'hintChangeModel')],
    ];
  }
  return [
    ['Enter', t(locale, 'hintStartCandidate')],
    ['b', t(locale, 'hintChangeModel')],
    ['Esc', t(locale, 'hintChangeModel')],
  ];
}

export function runningHints(_filter: TimelineFilter, _narrow: boolean, preparing = false, locale: Locale = 'en', finding = false, reading = false, cancelUi: 'idle' | 'requesting' | 'failed' | 'settled' = 'idle'): readonly (readonly [string, string])[] {
  const hints = runningFooterHints(locale, {
    preparing,
    finding,
    reading,
    findAllowed: !preparing,
    narrow: _narrow,
  });
  if (cancelUi === 'requesting' || cancelUi === 'failed') {
    const label = cancelUi === 'requesting' ? t(locale, 'hintExitUiCleanupPending') : t(locale, 'hintRetryCancel');
    return hints.map(([key, value]) => key === 'Ctrl+C' ? [key, label] as const : [key, value] as const);
  }
  return hints;
}

export function elapsedFrom(
  entries: readonly TimelineEntry[],
  now = Date.now(),
  startedAt?: number,
  endedAt?: number,
): string {
  if (startedAt && startedAt > 0) {
    const end = endedAt && endedAt > 0 ? endedAt : now;
    return formatElapsed(end - startedAt);
  }
  const first = entries[0]?.occurredAt;
  const last = entries.at(-1)?.occurredAt;
  if (!first || !last) return '00:00';
  const ms = Date.parse(last) - Date.parse(first);
  return formatElapsed(ms);
}

/** Prefer scoped phase clocks; unknown start boundary stays unrecorded instead of wall-clock open time. */
export function elapsedForRunning(
  model: Pick<RunningModel, 'entries' | 'phaseClocks' | 'preparePhase' | 'runPhase' | 'comparisonAttemptId' | 'runStartedAt'>,
  now: number,
  locale: Locale,
): string {
  const clocks = model.phaseClocks ?? {};
  const scope =
    model.preparePhase === 'compare' || model.comparisonAttemptId
      ? 'comparison' as const
      : model.runPhase === 'recovery' || model.preparePhase === 'check'
        ? 'recovery' as const
        : 'candidate' as const;
  const started =
    scope === 'recovery' ? clocks.recoveryStartedAt
      : scope === 'comparison' ? clocks.comparisonStartedAt
        : clocks.candidateStartedAt;
  const ended =
    scope === 'recovery' ? clocks.recoveryEndedAt
      : scope === 'comparison' ? clocks.comparisonEndedAt
        : clocks.candidateEndedAt;
  if (started && started > 0) {
    return formatElapsed((ended && ended > 0 ? ended : now) - started);
  }
  if (model.runStartedAt && model.runStartedAt > 0 && !ended) {
    return elapsedFrom(model.entries, now, model.runStartedAt);
  }
  if (!model.entries.length) return t(locale, 'unrecordedBoundary');
  return elapsedFrom(model.entries, now);
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function countTurns(entries: readonly TimelineEntry[]): number {
  return entries.filter((entry) => entry.title.startsWith('Turn settled')).length;
}

export function countCalls(entries: readonly TimelineEntry[]): number {
  return entries.filter((entry) => entry.title.startsWith('Input to Target') || entry.title.startsWith('DONE ·')).length;
}

function dash(theme: Theme): string {
  return theme.framed ? '—' : '-';
}

function userRecoveryHeadline(value: string, locale: Locale): string {
  if (value === 'recovered') return t(locale, 'userRecovered');
  if (value === 'recovered_partial') return t(locale, 'userPartial');
  return t(locale, 'userFailed');
}

function localizedComparison(value: string, locale: Locale): string {
  const key = value === 'observational' ? 'observationalValue' : value === 'recovered' ? 'recoveredValue' : value === 'recovered_partial' ? 'recoveredPartialValue' : undefined;
  return key ? t(locale, key) : value;
}
