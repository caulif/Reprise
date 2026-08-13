import type { CodexExperimentPreflight } from '../../application/codex-experiment.js';
import type { CandidateRunState, CandidateSpec, RunPolicy } from '../../core/schema.js';
import { truncateFit, type TimelineFilter } from '../format.js';
import type { Theme } from '../theme.js';
import type { TimelineEntry } from '../timeline.js';
import { joinColumns, kv, panel, stateRail, wrapBodyLine } from '../widgets.js';

export type SourceModel = { readonly sourceRoot: string; readonly step: 1 | 2 | 3 };
export type PreflightModel = {
  readonly preflight: CodexExperimentPreflight;
  readonly candidate: CandidateSpec | undefined;
  readonly step: 1 | 2 | 3;
};
export type ConfirmModel = PreflightModel & {
  readonly sourceRoot: string;
  readonly effort: string;
  readonly harnessModel?: string;
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
};

export function renderStep(theme: Theme, step: 1 | 2 | 3, labels: readonly [string, string, string]): string {
  const g = theme.glyphs;
  const marks = [1, 2, 3].map((index) => {
    if (index < step) return g.ok;
    if (index === step) return g.dot;
    return g.empty;
  });
  return ` Step ${step} of 3 ${g.h} ${labels[step - 1]}      ${marks.join(`${g.h}${g.h}`)}`;
}

export function renderSource(theme: Theme, width: number, model: SourceModel): string[] {
  return [
    renderStep(theme, 1, ['Source root', 'Preflight', 'Confirm run']),
    '',
    ...panel(theme, 'Source root', [` ${model.sourceRoot || '▌'}`], width),
  ];
}

export function renderPreflight(theme: Theme, width: number, model: PreflightModel): string[] {
  const { preflight, candidate } = model;
  const comparison = preflight.comparisonClass ?? 'none';
  return [
    renderStep(theme, 2, ['Source root', 'Preflight', 'Confirm run']),
    '',
    ...panel(theme, 'Candidate preflight', [
      kv(theme, 'Candidate', `${candidate?.requestedModel ?? 'unavailable'} ${theme.glyphs.sep} runtime resolved ${preflight.resolved.resolvedModel}`, width - 2),
      kv(theme, 'Runtime', `${preflight.resolved.executable}${preflight.resolved.version ? ` ${theme.glyphs.sep} ${preflight.resolved.version}` : ''}`, width - 2),
      kv(theme, 'Baseline', `${preflight.sourceBaseline} ${theme.glyphs.sep} comparison ${comparison}`, width - 2),
      kv(theme, 'Limitations', preflight.limitations.length ? preflight.limitations.join(' | ') : 'none recorded', width - 2),
    ], width),
  ];
}

export function renderConfirmation(theme: Theme, width: number, model: ConfirmModel): string[] {
  const { preflight, candidate, sourceRoot, effort } = model;
  const fidelity = preflight.comparisonClass ?? 'observational';
  return [
    renderStep(theme, 3, ['Source root', 'Preflight', 'Confirm run']),
    '',
    ...panel(theme, 'Start isolated Codex Candidate?', [
      kv(theme, 'Candidate', `${candidate?.requestedModel ?? 'unavailable'} ${theme.glyphs.sep} ${candidate?.candidateId ?? 'isolated Codex runtime'}`, width - 2),
      kv(theme, 'Harness agents', `${model.harnessModel ?? 'persisted Pi model'} ${theme.glyphs.sep} ${effort} ${theme.glyphs.sep} Controller, Comparison`, width - 2),
      kv(theme, 'Fidelity', fidelity, width - 2),
      '',
      theme.style.warn(` ${theme.glyphs.warn}  This starts a Codex process and may call your configured provider, which can cost money.`),
      theme.style.ok(` ${theme.glyphs.ok}  Your original source, the historical session, and global Codex config are left unchanged.`),
      theme.style.ok(` ${theme.glyphs.ok}  The replay starts from the current state of ${sourceRoot || 'the selected directory'}, not the historical state.`),
    ], width),
  ];
}

export function runningChrome(theme: Theme, width: number, model: RunningModel): string[] {
  return [...stateRail(theme, model.currentState, width), ''];
}

export function runningListPanel(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const title = `Timeline ${theme.glyphs.sep} Filter: ${model.filter} ${model.following ? `${theme.glyphs.sep} live` : `${theme.glyphs.sep} browsing`}`;
  const entries = model.entries;
  const listBody = entries.length
    ? entries.map((entry, index) => timelineRow(theme, entry, index === model.selected, width - (theme.framed ? 4 : 3)))
    : [' Waiting for persisted events...'];
  if (height !== undefined && entries.length) {
    listBody.push(` ${model.selected + 1}/${entries.length}`);
  }
  return panel(theme, title, listBody, width);
}

export function runningDetailPanel(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const selected = model.entries[model.selected];
  const detailBody = selected
    ? detailLines(theme, selected, width - (theme.framed ? 4 : 3), height)
    : [' Select an event to inspect its detail.'];
  return panel(theme, 'Detail', detailBody, width);
}

export function renderTimeline(theme: Theme, width: number, model: RunningModel, height?: number): string[] {
  const dual = theme.density === 'wide';
  const stacked = !dual && model.detailExpanded;
  const listWidth = dual ? Math.max(40, Math.floor(width * 0.52)) : width;
  const detailWidth = dual ? width - listWidth - 1 : width;
  const chrome = runningChrome(theme, width, model);
  const list = runningListPanel(theme, listWidth, model, height);
  const detail = runningDetailPanel(theme, detailWidth, model, height);
  if (dual) return [...chrome, ...joinColumns(list, detail, listWidth, detailWidth, 1, theme)];
  if (stacked) return [...chrome, ...list, '', ...detail];
  return [...chrome, ...list];
}

export function sourceHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Preflight'], ['Backspace', 'Edit'], ['Esc', 'Home']];
}

export function preflightHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Review run confirmation'], ['b', 'Edit source root'], ['Esc', 'Home']];
}

export function confirmHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Start isolated Candidate'], ['b', 'Back'], ['Esc', 'Home']];
}

export function runningHints(filter: TimelineFilter, narrow: boolean): readonly (readonly [string, string])[] {
  const next = nextFilter(filter);
  const hints: Array<readonly [string, string]> = [
    ['↑↓', 'Select'], ['PgUp/PgDn', 'Page'], ['l', 'Follow latest'], ['f', `Filter ${filter}>${next}`],
    ['Ctrl+C', 'Request cancellation'], ['?', 'Keys'],
  ];
  if (narrow) hints.splice(3, 0, ['d', 'Detail']);
  return hints;
}

export function currentRunState(entries: readonly TimelineEntry[]): CandidateRunState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const match = /State: .* (?:→|->) ([a-z_]+)/.exec(entries[index]?.title ?? '');
    const state = match?.[1];
    if (state && isRunState(state)) return state;
  }
  return undefined;
}

export function elapsedFrom(entries: readonly TimelineEntry[]): string {
  const first = entries[0]?.occurredAt;
  const last = entries.at(-1)?.occurredAt;
  if (!first || !last) return '00:00';
  const ms = Date.parse(last) - Date.parse(first);
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function countTurns(entries: readonly TimelineEntry[]): number {
  return entries.filter((entry) => (
    entry.title.startsWith('Turn settled')
    || entry.title.startsWith('Input submitted')
    || entry.title.startsWith('Input to Target')
  )).length;
}

export function countCalls(entries: readonly TimelineEntry[]): number {
  return entries.filter((entry) => entry.title.startsWith('Decision:')).length;
}

function timelineRow(theme: Theme, entry: TimelineEntry, selected: boolean, width: number): string {
  const marker = selected ? theme.glyphs.cursor : ' ';
  const badge = sourceStyle(theme, entry.source)(entry.source.padEnd(11));
  const level = entry.level === 'error' ? theme.style.danger(` ${theme.glyphs.err}`) : entry.level === 'warning' ? theme.style.warn(` ${theme.glyphs.warn}`) : '';
  const time = theme.style.muted(entry.occurredAt.slice(11, 19) || entry.occurredAt);
  const title = displayTitle(theme, entry.title);
  const extra = extraLines(entry.detail);
  const extraMark = extra > 1 ? ` +${extra}` : '';
  return truncateFit(` ${marker} ${time}   ${badge}  ${title}${extraMark}${level}`, Math.max(8, width), theme.glyphs.ellipsis);
}

function displayTitle(theme: Theme, title: string): string {
  const named = title.startsWith('State: ? ') ? `State: created ${title.slice('State: ? '.length)}` : title;
  return theme.framed ? named : named.replaceAll('→', '->').replaceAll('⇄', '<>');
}

function extraLines(detail: string | undefined): number {
  if (!detail) return 0;
  return detail.split(/\r?\n/).length;
}

function detailLines(theme: Theme, entry: TimelineEntry, width: number, height?: number): string[] {
  const head = [
    ` ${sourceStyle(theme, entry.source)(entry.source)} ${theme.glyphs.sep} ${entry.occurredAt} ${theme.glyphs.sep} seq ${entry.sequence}`,
    ` ${displayTitle(theme, entry.title)}`,
    '',
  ];
  const detail = entry.detail ? wrapBodyLine(entry.detail, Math.max(1, width)) : [' (no detail)'];
  const lines = [...head, ...detail];
  if (height === undefined) return lines;
  const inner = Math.max(1, height - 6);
  if (lines.length <= inner) return lines;
  return [...lines.slice(0, inner), ` ${lines.length} ${theme.glyphs.ellipsis}`];
}

function sourceStyle(theme: Theme, source: TimelineEntry['source']) {
  if (source === 'HARNESS') return theme.style.harness;
  if (source === 'CONTROLLER') return theme.style.controller;
  return theme.style.target;
}

function nextFilter(filter: TimelineFilter): TimelineFilter {
  const order: readonly TimelineFilter[] = ['ALL', 'TARGET', 'CONTROLLER', 'HARNESS'];
  return order[(order.indexOf(filter) + 1) % order.length] ?? 'ALL';
}

function isRunState(value: string): value is CandidateRunState {
  return value === 'created' || value === 'preparing' || value === 'launching'
    || value === 'awaiting_target' || value === 'awaiting_controller'
    || value === 'finalizing' || value === 'finished';
}
