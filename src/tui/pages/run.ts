import type { ExperimentPreflight } from '../../application/experiment-preflight.js';
import type { CandidateRunState, CandidateSpec, RunPolicy } from '../../core/schema.js';
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
import { joinColumns, kv, pad, panel, type PreparePhase } from '../widgets.js';
import type { CandidateRunPhase } from '../../application/candidate-run-phase.js';

export type { CandidateRunPhase };

export type SourceModel = { readonly sourceRoot: string; readonly sourceCursor?: number; readonly step: 1 | 2 | 3; readonly locale?: Locale };
export type RecoveryPreviewModel = {
  readonly status: 'ready' | 'blocked' | 'recovered' | 'partial' | 'insufficient_evidence' | 'failed';
  readonly summary?: string;
  readonly reportText?: string;
  readonly unresolved: readonly string[];
  readonly changedPathCount: number;
  readonly skippedPaths?: readonly { readonly path: string; readonly reasonCode: string }[];
  readonly failureSummary?: string;
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
};
export type RunningModel = {
  readonly entries: readonly TimelineEntry[];
  readonly selected: number;
  readonly filter: TimelineFilter;
  readonly following: boolean;
  readonly cancelling: boolean;
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
  readonly lastRuntimeEventKind?: string;
  readonly modelOutputSeen?: boolean;
  readonly reconnectCount?: number;
  readonly reconnectTotal?: number;
  readonly runStartedAt?: number;
  readonly expandedFolds?: readonly string[];
  readonly activityDetail?: TimelineEntry;
  readonly candidateSessionId?: string;
  readonly sourceTimeline?: readonly TimelineEntry[];
  readonly timelineRevision?: number;
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
        : (recovery?.failureSummary ?? t(locale, 'warningCannotStartFailedRecovery', { product })))
    : t(locale, 'warningStartsProcess', { product });
  const warningLine = canStart || blockedRecovery
    ? theme.style.warn(` ${theme.glyphs.warn}  ${startWarning}`)
    : theme.style.danger(` ${theme.glyphs.warn}  ${startWarning}`);
  const diagnosisHint = failedRecovery && model.experimentId
    ? theme.style.muted(` ${t(locale, 'diagnosisSavedHint', { experimentId: model.experimentId })}`)
    : undefined;
  const fields = [
    kv(theme, t(locale, 'candidateLabel'), candidateSummary(model.candidate, product, model.preflight.resolved.resolvedModel, locale), width - 2),
    kv(theme, t(locale, 'recoveryField'), recoveryWord(model, locale), width - 2),
    ...(model.recovery?.summary ? [kv(theme, t(locale, 'recoverySummaryField'), truncateFit(model.recovery.summary, Math.max(24, width - 18), theme.glyphs.ellipsis), width - 2)] : []),
    ...(model.recovery?.status === 'partial' ? [theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'confirmPartialNotZero')}`)] : []),
    ...(cross ? [kv(theme, t(locale, 'sourceProductLabel'), `${model.sourceProductLabel}  →  ${product}`, width - 2)] : []),
  ];
  const crossNote = cross ? [theme.style.muted(` ${t(locale, 'crossProductNote')}`)] : [];
  const startOk = canStart ? [theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'confirmCopySafe')}`)] : [];
  // Failed confirm: human failure reason is L1 — before candidate/recovery fields so the fold above cannot outrank it.
  const body = failedRecovery && !canStart
    ? [warningLine, ...(diagnosisHint ? [diagnosisHint] : []), '', ...fields, ...crossNote, ...startOk]
    : [...fields, '', ...crossNote, warningLine, ...startOk];
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
  if (model.runPhase === 'recovery') {
    return wait
      ? [theme.style.fillCanvas(pad(theme.style.muted(` ${wait}`), width, theme.glyphs.ellipsis))]
      : [];
  }
  const special = model.runPhase === 'candidate_reconnecting'
    || model.runPhase === 'candidate_starting'
    || model.preparePhase === 'compare';
  const task = model.taskTitle
    ? truncateFit(model.taskTitle, Math.max(8, width - agent.length - 10), theme.glyphs.ellipsis)
    : '';
  const line = special
    ? phaseLine(model, locale, agent)
    : (task ? `${task} · ${agent} · ${model.elapsed}` : `${agent} · ${model.elapsed}`);
  return [line, ...(wait ? [theme.style.muted(` ${wait}`)] : [])].map((row) =>
    theme.style.fillCanvas(pad(row.startsWith(' ') ? row : ` ${row}`, width, theme.glyphs.ellipsis)),
  );
}

function phaseLine(model: RunningModel, locale: Locale, product: string): string {
  if (model.runPhase === 'candidate_reconnecting') {
    return t(locale, 'candidateReconnecting', {
      product,
      current: model.reconnectCount ?? 0,
      total: model.reconnectTotal || 5,
    });
  }
  if (model.runPhase === 'candidate_starting') return t(locale, 'candidateStarting', { product });
  if (model.preparePhase === 'compare') {
    return t(locale, 'comparingTitle');
  }
  return t(locale, 'candidateRunningTitle', { product });
}

function waitLine(model: RunningModel, locale: Locale): string | undefined {
  const now = model.tick ?? Date.now();
  const last = model.lastRuntimeEventAt ? Date.parse(model.lastRuntimeEventAt) : (model.runStartedAt ?? 0);
  const idle = Number.isFinite(last) && last > 0 ? now - last : now - (model.runStartedAt ?? 0);
  if (idle >= 120_000) return t(locale, 'runStaleHint');
  return undefined;
}

export function isRecoveryChrome(model: RunningModel): boolean {
  return model.runPhase === 'recovery' || model.preparePhase === 'check';
}

export function renderTimeline(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  if (isPreparing(model)) return renderPrepare(theme, width, model, locale, product);
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
  const bodyHeight = height === undefined ? undefined : Math.max(4, height - header.length);
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

function renderPrepare(theme: Theme, width: number, model: RunningModel, locale: Locale, product: string): string[] {
  if (model.preparePhase === 'check') {
    const detail = model.prepareDetail ? model.prepareDetail : t(locale, 'recoveryStagePrepare');
    const project = model.workspaceProject ?? t(locale, 'projectlessSessions');
    const session = model.taskTitle ?? t(locale, 'noTaskSummary');
    return [
      ` ${t(locale, 'recoveringTitle')}`,
      '',
      kv(theme, t(locale, 'fieldSession'), session, width),
      kv(theme, t(locale, 'fieldProject'), project, width),
      kv(theme, t(locale, 'statusLabel'), detail, width),
      '',
      ` ${theme.style.muted(t(locale, 'recoveringPrepare'))}`,
    ].map((line) => theme.style.fillCanvas(pad(line, width, theme.glyphs.ellipsis)));
  }
  const step = model.preparePhase === 'copy' ? 2 : 1;
  const detail = model.prepareDetail ? ` · ${model.prepareDetail}` : '';
  const barLabel = t(locale, step === 2 ? 'preparingBar' : 'checkingBar', { step, detail });
  const marks = [
    stepLine(theme, 1, step, t(locale, 'stepRestore'), locale),
    stepLine(theme, 2, step, t(locale, 'stepCopy'), locale),
    stepLine(theme, 3, step, t(locale, 'stepConfig'), locale),
    stepLine(theme, 4, step, t(locale, 'stepStart', { product }), locale),
  ];
  return [
    model.taskTitle ? ` ${t(locale, 'taskLabel')}  ${theme.style.strong(truncateFit(model.taskTitle, Math.max(8, width - 8), theme.glyphs.ellipsis))}` : '',
    ` ${t(locale, 'preparingIn', { product })}`,
    '',
    ` ${theme.style.muted(barLabel)}`,
    '',
    ...marks,
  ].filter((line, index) => line || index > 0).map((line) => theme.style.fillCanvas(pad(line, width, theme.glyphs.ellipsis)));
}

function stepLine(theme: Theme, index: number, current: number, label: string, locale: Locale): string {
  if (index < current) return ` ${theme.style.ok(theme.glyphs.ok)}  ${label}  ${theme.style.ok(t(locale, 'done'))}`;
  if (index === current) return ` ${theme.style.target(theme.glyphs.dot)}  ${label}  ${theme.style.target(t(locale, 'inProgress'))}`;
  return theme.style.muted(` ${theme.glyphs.empty}  ${label}  ${t(locale, 'waiting')}`);
}

export function sourceHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', t(locale, 'hintStartRun')], ['Backspace', t(locale, 'hintEdit')], ['Esc', t(locale, 'hintHome')]];
}

export function preflightHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Esc', t(locale, 'hintHome')]];
}

export function confirmHints(canStart = true, locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', canStart ? t(locale, 'hintStartCandidate') : t(locale, 'hintTryBlocked')], ['b', t(locale, 'hintChangeModel')], ['Esc', t(locale, 'hintHome')]];
}

export function runningHints(_filter: TimelineFilter, _narrow: boolean, preparing = false, locale: Locale = 'en', finding = false, reading = false): readonly (readonly [string, string])[] {
  const stop = ['Ctrl+C', preparing ? t(locale, 'hintCancel') : t(locale, 'hintStop')] as const;
  if (reading) return [['v', t(locale, 'hintLeaveReading')], ['Esc', t(locale, 'hintLeaveReading')], stop];
  if (finding) {
    return [['Enter', t(locale, 'hintNextHit')], ['S-Enter', t(locale, 'hintPrevHit')], ['Esc', t(locale, 'hintClearFind')], stop];
  }
  return [stop];
}

export function elapsedFrom(entries: readonly TimelineEntry[], now = Date.now(), startedAt?: number): string {
  if (startedAt && startedAt > 0) return formatElapsed(now - startedAt);
  const first = entries[0]?.occurredAt;
  const last = entries.at(-1)?.occurredAt;
  if (!first || !last) return '00:00';
  const ms = Date.parse(last) - Date.parse(first);
  return formatElapsed(ms);
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

function candidateSummary(candidate: CandidateSpec | undefined, product: string, resolvedModel: string | undefined, locale: Locale): string {
  if (!candidate) return t(locale, 'unavailableValue');
  const model = candidate.requestedModel;
  return resolvedModel && resolvedModel !== model ? `${product}  ·  ${resolvedModel} (${model})` : `${product}  ·  ${model}`;
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
