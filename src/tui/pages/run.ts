import type { CodexExperimentPreflight } from '../../application/experiment.js';
import type { CandidateRunState, CandidateSpec, RunPolicy } from '../../core/schema.js';
import { formatBytes, truncateFit, type TimelineFilter } from '../format.js';
import { t, type Locale } from '../i18n.js';
import { matchesCanvasQuery, matchesFilter, renderScrollback } from '../scrollback.js';
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
  readonly detailExpanded: boolean;
  readonly policy?: RunPolicy;
  readonly preparePhase?: PreparePhase;
  readonly prepareDetail?: string;
  readonly locale?: Locale;
  readonly taskTitle?: string;
  readonly productLabel?: string;
  readonly finding?: boolean;
  readonly findQuery?: string;
  readonly findCursor?: number;
  readonly tick?: number;
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
  const { preflight, candidate, sourceRoot, effort } = model;
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  const fidelity = localizedComparison(preflight.comparisonClass, locale);
  const recovery = model.recovery;
  return [
    renderStep(theme, 3, [t(locale, 'sourceTitle'), t(locale, 'preflightStep'), t(locale, 'confirmStep')], locale),
    '',
    ...panel(theme, t(locale, 'confirmTitle', { product }), [
      kv(theme, t(locale, 'candidateLabel'), candidateLine(candidate, product, locale), width - 2),
      kv(theme, t(locale, 'harnessAgentsLabel'), `${model.harnessModel ?? t(locale, 'persistedPiModel')} ${theme.glyphs.sep} ${effort} ${theme.glyphs.sep} ${t(locale, 'controllerLabel')}, ${t(locale, 'comparisonActorLabel')}`, width - 2),
      kv(theme, t(locale, 'fidelityLabel'), fidelity, width - 2),
      ...(recovery ? [
        kv(theme, t(locale, 'environmentLabel'), recovery.unresolved.length ? t(locale, 'preparedWithLimitations') : t(locale, 'preparedValue'), width - 2),
      ] : []),
      kv(theme, t(locale, 'maximumRequestsLabel'), `${t(locale, 'candidateLabel')} ${model.policy?.maxTargetTurns ?? t(locale, 'unavailableValue')} ${theme.glyphs.sep} ${t(locale, 'controllerLabel')} ${model.policy?.maxModelCalls ?? t(locale, 'unavailableValue')} ${theme.glyphs.sep} ${t(locale, 'comparisonActorLabel')} 1`, width - 2),
      kv(theme, t(locale, 'networkBillingLabel'), model.harnessAuthOk === false ? `${t(locale, 'blockedValue')} ${dash(theme)} ${t(locale, 'credentialMissing')}` : t(locale, 'providerDependent'), width - 2),
      '',
      model.harnessAuthOk === false
        ? theme.style.danger(` ${theme.glyphs.warn}  ${t(locale, 'warningCannotStart', { product })}`)
        : theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'warningStartsProcess', { product })}`),
      theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'sourceUnchanged')}`),
      theme.style.ok(` ${theme.glyphs.ok}  ${t(locale, 'isolatedState', { source: sourceRoot || t(locale, 'selectedDirectory') })}`),
      theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'copyNotSanitized')}`),
      theme.style.warn(` ${theme.glyphs.warn}  ${t(locale, 'candidateReadsSource')}`),
    ], width),
  ];
}

export function runningChrome(_theme: Theme, _width: number, model: RunningModel): string[] {
  if (isPreparing(model)) return [];
  return [];
}

export function renderTimeline(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const locale = model.locale ?? 'en';
  const product = model.productLabel ?? t(locale, 'unknownAgent');
  if (isPreparing(model)) return renderPrepare(theme, width, model, locale, product);
  const visible = model.entries.filter((entry) => matchesFilter(entry, model.filter) && matchesCanvasQuery(entry, model.findQuery ?? ''));
  const selected = Math.max(0, visible.findIndex((entry) => entry === model.entries[model.selected]));
  const dimIn = model.filter === 'PRODUCT';
  const dimOut = model.filter === 'INPUT';
  const inMark = dimIn ? theme.style.muted(theme.glyphs.dot) : theme.style.controller(theme.glyphs.dot);
  const outMark = dimOut ? theme.style.muted(theme.glyphs.dot) : theme.style.target(theme.glyphs.dot);
  const inLabel = dimIn ? theme.style.muted(t(locale, 'legendIn', { product })) : t(locale, 'legendIn', { product });
  const outLabel = dimOut ? theme.style.muted(t(locale, 'legendOut', { product })) : t(locale, 'legendOut', { product });
  const legend = ` ${inMark} ${inLabel}   ${outMark} ${outLabel}`;
  const task = model.taskTitle ? ` ${t(locale, 'taskLabel')}  ${theme.style.strong(truncateFit(model.taskTitle, Math.max(8, width - 8), theme.glyphs.ellipsis))}` : undefined;
  const findBar = model.finding ? renderFindBar(model, locale, visible.length, selected < 0 ? 0 : selected) : [];
  const header = [legend, ...(task ? [task] : []), ...findBar, ''];
  const bodyHeight = height === undefined ? undefined : Math.max(4, height - header.length);
  const empty = model.finding && (model.findQuery ?? '').trim() && !visible.length
    ? [theme.style.muted(` ${t(locale, 'findNone')}`)]
    : renderScrollback(theme, width, visible, selected < 0 ? 0 : selected, locale, product, bodyHeight, model.tick ?? 0);
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
  const step = model.preparePhase === 'copy' ? 2 : 1;
  const detail = model.prepareDetail ? ` · ${model.prepareDetail}` : '';
  const barWidth = Math.max(12, Math.min(36, width - 8));
  const filled = Math.max(1, Math.round((step / 4) * barWidth));
  const shift = Math.floor((model.tick ?? 0) / 400) % Math.max(1, filled);
  const fill = theme.framed ? '█' : '#';
  const glow = theme.framed ? '▓' : '#';
  const rest = theme.framed ? '░' : '-';
  const wave = Array.from({ length: filled }, (_, index) => (index === shift ? glow : fill)).join('');
  const bar = theme.style.target(`[${wave}${rest.repeat(Math.max(0, barWidth - filled))}]`);
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
    ` ${bar}`,
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
  return [['Enter', canStart ? t(locale, 'hintStartCandidate') : t(locale, 'hintTryBlocked')], ['b', t(locale, 'hintBack')], ['Esc', t(locale, 'hintHome')]];
}

export function runningHints(_filter: TimelineFilter, narrow: boolean, preparing = false, locale: Locale = 'en', finding = false): readonly (readonly [string, string])[] {
  if (preparing) return [['Ctrl+C', t(locale, 'hintCancel')], ['?', t(locale, 'hintKeys')]];
  if (finding) {
    return [
      ['Esc', t(locale, 'hintClearFind')],
      [narrow ? 'Up/Dn' : '↑↓', t(locale, 'hintSelect')],
      ['Enter', t(locale, 'hintExpand')],
    ];
  }
  return [
    [narrow ? 'Up/Dn' : '↑↓', t(locale, 'hintSelect')],
    ['f', t(locale, 'hintFilter')],
    ['Ctrl+C', t(locale, 'hintStop')],
    ['Enter', t(locale, 'hintExpand')],
    ['o', t(locale, 'hintFull')],
    ...(narrow ? [] : [['/', t(locale, 'hintFind')] as const, ['l', t(locale, 'hintLatest')] as const, ['?', t(locale, 'hintKeys')] as const]),
  ];
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

function candidateLine(candidate: CandidateSpec | undefined, product: string, locale: Locale): string {
  const model = candidate?.requestedModel ?? t(locale, 'unavailableValue');
  const effort = candidate?.candidateId?.match(/-(minimal|low|medium|high|xhigh|max)$/)?.[1];
  return effort ? `${model} · ${effort} · ${t(locale, 'isolatedProduct', { product })}` : `${model} · ${t(locale, 'isolatedProduct', { product })}`;
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
