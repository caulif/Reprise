import type { CodexExperimentPreflight } from '../../application/experiment.js';
import type { CandidateRunState, CandidateSpec, RunPolicy } from '../../core/schema.js';
import { lastLiveVerb } from '../agent-activity.js';
import { foldProcessEntries, selectedIndexAfterFold } from '../fold-process.js';
import { formatBytes, truncateFit, type TimelineFilter } from '../format.js';
import { t, type Locale } from '../i18n.js';
import { matchesFilter, renderScrollback } from '../scrollback.js';
import { canvasHitIndices } from '../timeline-read.js';
import { caretAt } from '../text-edit.js';
import type { Theme } from '../theme.js';
import type { TimelineEntry } from '../timeline.js';
import { kv, pad, panel, type PreparePhase } from '../widgets.js';

export type SourceModel = { readonly sourceRoot: string; readonly sourceCursor?: number; readonly step: 1 | 2 | 3; readonly locale?: Locale };
export type RecoveryPreviewModel = {
  readonly status: 'recovered' | 'partial' | 'insufficient_evidence' | 'failed';
  readonly reportText?: string;
  readonly unresolved: readonly string[];
  readonly changedPathCount: number;
  readonly skippedPaths?: readonly { readonly path: string; readonly reasonCode: string }[];
  readonly failureSummary?: string;
};
export type PreflightModel = {
  readonly preflight: CodexExperimentPreflight;
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
};
export type CandidateRunPhase = 'recovery' | 'candidate_starting' | 'candidate_generating' | 'candidate_reconnecting';
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
  readonly detailExpanded: boolean;
  readonly policy?: RunPolicy;
  readonly preparePhase?: PreparePhase;
  readonly prepareDetail?: string;
  readonly locale?: Locale;
  readonly taskTitle?: string;
  readonly workspaceProject?: string;
  readonly productLabel?: string;
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
  readonly paneFocus?: 'left' | 'right';
  readonly expandedFolds?: readonly string[];
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
  const recoveryRunnable = model.preflight.comparisonClass !== 'observational' && recovery?.status !== 'failed';
  const cross = Boolean(model.sourceProductLabel && model.sourceProductLabel !== product);
  const startWarning = !canStart
    ? (model.harnessAuthOk === false
      ? t(locale, 'warningCannotStart', { product })
      : (recovery?.failureSummary ?? t(locale, 'warningCannotStartFailedRecovery', { product })))
    : t(locale, 'warningStartsProcess', { product });
  return [
    renderStep(theme, 3, [t(locale, 'sourceTitle'), t(locale, 'preflightStep'), t(locale, 'confirmStep')], locale),
    '',
    ...panel(theme, t(locale, recoveryRunnable ? 'confirmTitle' : 'confirmTitleBlocked', { product }), [
      kv(theme, t(locale, 'candidateLabel'), candidateSummary(model.candidate, product, model.preflight.resolved.resolvedModel, locale), width - 2),
      kv(theme, t(locale, 'recoveryField'), recoveryWord(model, locale), width - 2),
      ...(model.recovery?.status === 'partial' ? [theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'confirmPartialNotZero')}`)] : []),
      ...(cross ? [kv(theme, t(locale, 'sourceProductLabel'), `${model.sourceProductLabel}  →  ${product}`, width - 2)] : []),
      '',
      ...(cross ? [theme.style.muted(` ${t(locale, 'crossProductNote')}`)] : []),
      canStart ? theme.style.warn(` ${theme.glyphs.warn}  ${startWarning}`) : theme.style.danger(` ${theme.glyphs.warn}  ${startWarning}`),
      ...(canStart ? [theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'confirmCopySafe')}`)] : []),
    ], width),
  ];
}

export function confirmCanStart(model: ConfirmModel): boolean {
  if (model.harnessAuthOk === false) return false;
  if (model.preflight.comparisonClass === 'observational') return false;
  if (model.recovery?.status === 'failed') return false;
  if (model.recovery && !model.candidate) return false;
  return true;
}

function recoveryWord(model: ConfirmModel, locale: Locale): string {
  const status = model.recovery?.status;
  if (status === 'partial') return t(locale, 'userPartial');
  if (status === 'failed') return t(locale, 'userFailed');
  if (status === 'recovered') return t(locale, 'userRecovered');
  return userRecoveryHeadline(model.preflight.comparisonClass, locale);
}

export function runningChrome(theme: Theme, width: number, model: RunningModel): string[] {
  if (isPreparing(model)) return [];
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  const phase = phaseLine(model, locale, product);
  const wait = waitLine(model, locale);
  return [phase, ...(wait ? [theme.style.muted(` ${wait}`)] : [])].map((line) =>
    theme.style.fillCanvas(pad(line.startsWith(' ') ? line : ` ${line}`, width, theme.glyphs.ellipsis)),
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
    const verb = lastLiveVerb(model.entries);
    return verb ? `${t(locale, 'comparingTitle')} · ${verb}` : t(locale, 'comparingTitle');
  }
  if (model.runPhase === 'recovery') {
    const verb = lastLiveVerb(model.entries);
    return verb ? `${t(locale, 'recoveringTitle')} · ${verb}` : t(locale, 'recoveringTitle');
  }
  return t(locale, 'candidateGenerating', { product, n: Math.max(1, model.turns.used) });
}

function waitLine(model: RunningModel, locale: Locale): string | undefined {
  const now = model.tick ?? Date.now();
  const last = model.lastRuntimeEventAt ? Date.parse(model.lastRuntimeEventAt) : (model.runStartedAt ?? 0);
  const idle = Number.isFinite(last) && last > 0 ? now - last : now - (model.runStartedAt ?? 0);
  if (idle >= 120_000) return t(locale, 'runStaleHint');
  const sinceStart = now - (model.runStartedAt ?? now);
  if (sinceStart >= 30_000) {
    return t(locale, model.runPhase === 'recovery' ? 'runStillRecovering' : 'runStillWaiting');
  }
  return undefined;
}

export function isRecoveryChrome(model: RunningModel): boolean {
  return model.runPhase === 'recovery' || model.preparePhase === 'check';
}

export function renderTimeline(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  if (isPreparing(model)) return renderPrepare(theme, width, model, locale, product);
  const visible = model.entries.filter((entry) => matchesFilter(entry, model.filter));
  const selected = Math.max(0, visible.findIndex((entry) => entry === model.entries[model.selected]));
  const recovering = model.runPhase === 'recovery';
  const dimIn = model.filter === 'PRODUCT';
  const dimOut = model.filter === 'INPUT';
  const inMark = dimIn ? theme.style.muted(theme.glyphs.dot) : theme.style.controller(theme.glyphs.dot);
  const outMark = dimOut ? theme.style.muted(theme.glyphs.dot) : theme.style.target(theme.glyphs.dot);
  const inLabel = dimIn ? theme.style.muted(t(locale, 'legendIn', { product })) : t(locale, 'legendIn', { product });
  const outLabel = dimOut ? theme.style.muted(t(locale, 'legendOut', { product })) : t(locale, 'legendOut', { product });
  const comparing = model.preparePhase === 'compare';
  const legend = recovering
    ? ` ${theme.style.harness(theme.glyphs.dot)} ${t(locale, 'recoveryLegend')}`
    : comparing
      ? ` ${theme.style.ok(theme.glyphs.dot)} ${t(locale, 'comparisonTitle')}`
      : ` ${inMark} ${inLabel}   ${outMark} ${outLabel}   ${theme.style.controller(theme.glyphs.dot)} ${t(locale, 'controllerLegend')}`;
  const task = model.taskTitle ? ` ${t(locale, 'taskLabel')}  ${theme.style.strong(truncateFit(model.taskTitle, Math.max(8, width - 8), theme.glyphs.ellipsis))}` : undefined;
  const hits = canvasHitIndices(visible, model.findQuery ?? '');
  const hitAt = hits.indexOf(selected < 0 ? -1 : selected);
  const findBar = model.finding ? renderFindBar(model, locale, hits.length, hitAt < 0 ? 0 : hitAt) : [];
  const header = [legend, ...(task ? [task] : []), ...findBar, ''];
  const bodyHeight = height === undefined ? undefined : Math.max(4, height - header.length);
  const expanded = new Set(model.expandedFolds ?? []);
  const folded = foldProcessEntries(visible, expanded);
  const selectedFolded = selectedIndexAfterFold(visible, folded, visible[selected] ?? model.entries[model.selected]);
  const empty = model.finding && (model.findQuery ?? '').trim() && !visible.length
    ? [theme.style.muted(` ${t(locale, 'findNone')}`)]
    : recovering && !visible.length
      ? [theme.style.muted(` ${t(locale, 'recoveryEmpty')}`)]
      : renderScrollback(theme, width, folded, selectedFolded, locale, product, bodyHeight, model.tick ?? 0, model.readingOffset ?? 0);
  return [
    ...header.map((line) => theme.style.fillCanvas(pad(line, width, theme.glyphs.ellipsis))),
    ...empty.map((line) => pad(line, width, theme.glyphs.ellipsis)),
  ];
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
  return [['b', t(locale, 'hintEditSource')], ['Esc', t(locale, 'hintHome')]];
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
  return [stop, ['/', t(locale, 'hintTimelineFind')], ['v', t(locale, 'hintReadingMode')], ['?', t(locale, 'hintKeys')]];
}

export function renderCompareGate(theme: Theme, width: number, locale: Locale = 'en'): string[] {
  return panel(theme, t(locale, 'compareGateTitle'), [
    ` ${t(locale, 'compareGateBody')}`,
    '',
    theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'compareGateEnter')}`),
    theme.style.muted(` s  ${t(locale, 'compareGateSkip')}`),
  ], width);
}

export function compareGateHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', t(locale, 'hintRunComparison')], ['s', t(locale, 'hintSkipComparison')], ['Ctrl+C', t(locale, 'hintStop')]];
}

export function currentRunState(entries: readonly TimelineEntry[]): CandidateRunState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const match = /State: .* (?:→|->) ([a-z_]+)/.exec(entries[index]?.title ?? '');
    const state = match?.[1];
    if (state && isRunState(state)) return state;
  }
  return undefined;
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
  return entries.filter((entry) => entry.title.startsWith('Decision:')).length;
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

function isRunState(value: string): value is CandidateRunState {
  return value === 'created' || value === 'preparing' || value === 'launching'
    || value === 'awaiting_target' || value === 'awaiting_controller'
    || value === 'finalizing' || value === 'finished';
}
