import { resolve, normalize } from 'node:path';
import { asPosixPath, relativeInside } from '../../core/paths.js';
import type { ExperimentResult } from '../../application/experiment.js';
import { resolveResultPathLinks, type ResultPathLinks } from '../../application/result-paths.js';
import { type ActionArtifacts, resultFooterHints } from '../action-model.js';
import { localPathFromFileUrl } from '../open-report.js';
import { hitFileLink } from '../format.js';
import { formatHarnessFailure, t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import type { WorkbenchSurfaceScope } from '../workbench-layout.js';
import { kv, kvLinkBlock, panel, panelWithHits, wrapBodyLine } from '../widgets.js';
import type { ResultAction } from '../page-input.js';
import { candidateModelLabel, comparisonPresentation, displayCleanupStatus, displayTaskStatus, displayTerminationKind } from '../display-copy.js';
import type { PhaseClockBounds } from '../phase-state.js';
import { artifactsFromResult, listActions } from '../action-model.js';
import { visibleWidth } from '@earendil-works/pi-tui';

export type { ActionArtifacts };

export type ResultPointerHit = { readonly action: ResultAction; readonly x0: number; readonly x1: number };
export type ResultRender = { readonly lines: readonly string[]; readonly rowHits: ReadonlyMap<number, readonly ResultPointerHit[]> };
export type ResultRenderOptions = {
  readonly surfaceScope?: WorkbenchSurfaceScope;
  readonly processExpanded?: boolean;
  readonly phaseClocks?: PhaseClockBounds;
  readonly selectedAction?: ResultAction;
  readonly detailsExpanded?: boolean;
  readonly processAvailable?: boolean;
};

export function renderResult(
  theme: Theme,
  width: number,
  result: ExperimentResult,
  locale: Locale = 'en',
  productLabel?: string,
  comparePending = false,
  options?: ResultRenderOptions,
): string[] {
  return [...renderResultWithHits(theme, width, result, locale, productLabel, comparePending, options).lines];
}

export function renderResultWithHits(
  theme: Theme,
  width: number,
  result: ExperimentResult,
  locale: Locale = 'en',
  productLabel?: string,
  comparePending = false,
  options?: ResultRenderOptions,
): ResultRender {
  const kind = result.record.outcome.termination.kind;
  const vacant = t(locale, 'resultMissingArtifact');
  const comparison = result.comparison.result;
  const experimentRoot = result.experimentRoot ?? (result.reportPath ? parentPath(result.reportPath) : undefined);
  const paths = resolveResultPathLinks(result);
  const runId = result.record.attempt?.runId;
  const inner = Math.max(20, width - 4);
  const body: string[] = [];
  const bodyHits = new Map<number, readonly ResultPointerHit[]>();
  const push = (line: string) => { body.push(line); };
  const pushAction = (action: ResultAction, label: string, path?: string) => {
    const marker = options?.selectedAction === action ? theme.glyphs.cursor : ' ';
    const value = path ? shortLabel(path, experimentRoot, vacant) : '';
    const block = path ? kvLinkBlock(theme, `${marker} ${label}`, value, path, width) : undefined;
    for (const line of block?.lines ?? [` ${marker} ${label}`]) {
      bodyHits.set(body.length, [{ action, x0: 1, x1: Math.max(1, visibleWidth(line)) }]);
      body.push(line);
    }
  };

  // Normal technical completion stays in details; failures remain on the first screen.
  if (kind !== 'completed') {
    push(theme.style.danger(` ${theme.glyphs.warn} ${terminationWord(kind, locale)}`));
  }
  push(kv(theme, t(locale, 'resultTask'), taskAssessmentWord(result.record.outcome.task.status, locale), width - 2));
  if (kind !== 'completed') push(kv(theme, t(locale, 'resultTermination'), terminationWord(kind, locale), width - 2));
  if (result.record.outcome.cleanup?.status !== 'complete') {
    push(kv(theme, t(locale, 'resultCleanup'), cleanupWord(result.record.outcome.cleanup?.status, vacant, locale), width - 2));
  }
  push(kv(theme, t(locale, 'resultComparison'), comparisonWord(comparison, locale), width - 2));


  const candidateLabel = candidateDisplayLabel(result, productLabel);
  if (candidateLabel) push(kv(theme, t(locale, 'candidateLabel'), candidateLabel, width - 2));

  const metrics = metricsRows(theme, result, locale, options?.phaseClocks, width);
  if (metrics[0]) push(metrics[0]);
  push('');
  const actions = listActions({
    page: 'result', locale,
    mode: { comparePending, processAvailable: Boolean(options?.processAvailable) },
    artifacts: artifactsFromResult(result),
  });
  for (const action of actions) {
    if (!action.enabled || action.id === 'activate-primary' || action.id === 'show-help') continue;
    const id = action.id as ResultAction;
    const path = id === 'open-candidate-final' ? paths.candidateFinal
      : id === 'open-report' ? paths.report
        : id === 'open-history-final' ? paths.historyFinal
          : id === 'open-trace' ? paths.trace
            : id === 'open-replica' ? paths.replica : undefined;
    pushAction(id, t(locale, action.labelKey), path);
  }
  if (options?.detailsExpanded) {
    push('');
    push(kv(theme, t(locale, 'resultTermination'), `${terminationWord(kind, locale)} · ${result.record.outcome.termination.code}`, width - 2));
    push(kv(theme, t(locale, 'resultCleanup'), cleanupWord(result.record.outcome.cleanup?.status, vacant, locale), width - 2));
    for (const row of metrics.slice(1)) push(row);
    if (runId) push(kv(theme, 'Run ID', runId, width - 2));
  }

  const headline = comparison.status === 'skipped' ? undefined : envelopeHeadline(result);
  const summary = explainOutcome(result, inner, productLabel ?? t(locale, 'unknownAgent'), locale);
  const comparisonFailure = comparison.status === 'failed'
    ? t(locale, comparison.failure?.code === 'host_zone_modified' ? 'comparisonHostZoneFailure' : 'comparisonUnpublished')
    : undefined;
  if (headline || summary || comparisonFailure) {
    push('');
    if (headline) for (const line of wrapBodyLine(headline, inner)) push(` ${line}`);
    if (summary) for (const line of summary) push(` ${line}`);
    if (comparisonFailure) for (const line of wrapBodyLine(comparisonFailure, inner)) push(` ${line}`);
  }

  return panelWithHits(theme, t(locale, 'resultTitle'), body, width, bodyHits);
}

export function resultHints(
  locale: Locale = 'en',
  comparePending = false,
  artifacts?: ActionArtifacts,
): readonly (readonly [string, string])[] {
  return resultFooterHints(locale, {
    comparePending,
    ...(artifacts !== undefined ? { artifacts } : {}),
  });
}

export function resultPointerAction(
  lines: readonly string[],
  row: number,
  col: number,
  _locale: Locale = 'en',
  paths?: ResultPathLinks,
  rowHits?: ReadonlyMap<number, readonly ResultPointerHit[]>,
): ResultAction | undefined {
  const line = lines[row];
  if (!line) return undefined;
  const hits = rowHits?.get(row);
  if (hits) {
    const match = hits.find((hit) => col >= hit.x0 && col <= hit.x1);
    if (match) return match.action;
  }
  const href = hitFileLink(line, col);
  if (href && paths) {
    const action = resolveResultLinkAction(href, paths);
    if (action) return action;
  }
  return undefined;
}

export function resolveResultLinkAction(href: string, paths: ResultPathLinks): ResultAction | undefined {
  const target = normalizeLinkTarget(href);
  const candidates: readonly [ResultAction, string | undefined][] = [
    ['open-report', paths.report],
    ['open-history-final', paths.historyFinal],
    ['open-candidate-final', paths.candidateFinal],
    ['open-trace', paths.trace],
    ['open-replica', paths.replica],
  ];
  for (const [action, path] of candidates) {
    const normalized = normalizeStoredPath(path);
    if (normalized && normalized === target) return action;
  }
  return undefined;
}

function normalizeLinkTarget(href: string): string {
  return normalizeStoredPath(pointerHrefPath(href)) ?? pointerHrefPath(href).replaceAll('\\', '/').toLowerCase();
}

function normalizeStoredPath(path: string | undefined): string | undefined {
  if (!path?.trim()) return undefined;
  return normalize(resolve(path.trim())).replaceAll('\\', '/').toLowerCase();
}

function pointerHrefPath(href: string): string {
  if (/^file:/i.test(href)) {
    try {
      return localPathFromFileUrl(href).replaceAll('\\', '/');
    } catch {
      return href.replaceAll('\\', '/');
    }
  }
  return href.replaceAll('\\', '/');
}

function candidateDisplayLabel(result: ExperimentResult, productLabel: string | undefined): string | undefined {
  const candidate = result.record.attempt?.candidate;
  if (!candidate) return undefined;
  const product = productLabel ?? candidate.productId;
  const model = candidateModelLabel(candidate.requestedModel, result.record.manifest?.resolvedModel.resolved);
  if (!model) return product;
  return `${product} · ${model}`;
}

export function renderFailure(theme: Theme, width: number, message: string, locale: Locale = 'en'): string[] {
  const inner = Math.max(20, width - 4);
  return panel(theme, t(locale, 'cannotContinue'), [
    ...wrapBodyLine(message, inner).map((line) => ` ${line}`),
    '',
    ` ${t(locale, 'errorReturnHint')}`,
  ], width);
}

export function failureHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['Enter', t(locale, 'hintBack')], ['b', t(locale, 'hintBack')], ['Esc', t(locale, 'hintHome')]];
}

function taskAssessmentWord(status: string, locale: Locale): string {
  return displayTaskStatus(status, locale);
}

function terminationWord(kind: string, locale: Locale): string {
  return displayTerminationKind(kind, locale);
}

function cleanupWord(status: string | undefined, vacant: string, locale: Locale): string {
  if (!status) return vacant;
  return displayCleanupStatus(status, locale);
}

function comparisonWord(comparison: ExperimentResult['comparison']['result'], locale: Locale): string {
  return comparisonPresentation(comparison, locale).word;
}

function envelopeHeadline(result: ExperimentResult): string | undefined {
  const cmp = result.comparison.result;
  if (cmp.status !== 'completed' || !('value' in cmp)) return undefined;
  const text = cmp.value?.headline?.trim();
  return text || undefined;
}

function metricsRows(theme: Theme, result: ExperimentResult, locale: Locale, clocks: PhaseClockBounds | undefined, width: number): string[] {
  const facts = result.facts;
  const missing = t(locale, 'notRecorded');
  if (!facts) return [kv(theme, t(locale, 'metricsElapsedField'), missing, width - 2)];
  const rows: string[] = [];
  if (facts.wallClockMs !== undefined) rows.push(kv(theme, t(locale, 'metricsCandidateElapsed'), `${Math.round(facts.wallClockMs / 1000)}s`, width - 2));
  const comparisonMs = clocks?.comparisonStartedAt && clocks.comparisonEndedAt
    ? clocks.comparisonEndedAt - clocks.comparisonStartedAt : undefined;
  if (comparisonMs !== undefined && comparisonMs >= 0) rows.push(kv(theme, t(locale, 'metricsComparisonElapsed'), `${Math.round(comparisonMs / 1000)}s`, width - 2));
  rows.push(kv(theme, t(locale, 'metricsTotalElapsed'), facts.elapsedMs === undefined ? missing : `${Math.round(facts.elapsedMs / 1000)}s`, width - 2));
  const usage = [
    facts.tokenCount === undefined ? `${missing} tokens` : `${facts.tokenCount} tokens`,
    facts.costUsd === undefined ? `${missing} ${t(locale, 'metricsUsageSummary').toLowerCase()}` : `$${facts.costUsd.toFixed(2)}`,
  ].filter((part): part is string => Boolean(part));
  rows.push(kv(theme, t(locale, 'metricsUsageField'), usage.join(` ${theme.glyphs.sep} `), width - 2));
  return rows;
}

function explainOutcome(result: ExperimentResult, width: number, product: string, locale: Locale): readonly string[] | undefined {
  const failure = result.record.outcome.termination.failure;
  if (failure?.message) {
    if (failure.origin === 'controller' && result.decision.status === 'failed' && result.decision.failure?.kind) {
      return wrapBodyLine(formatHarnessFailure(locale, result.record.outcome.task.status === 'not_assessed' ? 'opening' : 'controller', result.decision.failure.kind), width);
    }
    const origin = failure.origin === 'controller' ? 'Reprise' : failure.origin === 'runtime' ? product : failure.origin;
    const lines = failure.code === 'failed.runtime.upstream_unavailable'
      ? [t(locale, 'upstreamUnavailable'), `${origin}: ${failure.message}`]
      : /invalid JSON|schema validation failed/i.test(failure.message)
      ? [`${origin}: ${failure.message}`, t(locale, 'resultModelOutputError', { product })]
      : [`${origin}: ${failure.message}`];
    return lines.flatMap((line) => wrapBodyLine(line, width));
  }
  const value = result.decision.status === 'completed' ? result.decision.value : undefined;
  if (value?.type === 'done' && value.reason !== 'satisfied' && value.rationale?.trim()) {
    return wrapBodyLine(value.rationale.trim(), width);
  }
  const compared = result.comparison.result.status !== 'skipped';
  if (result.record.outcome.termination.kind === 'blocked') {
    const summary = t(locale, 'resultTaskBlocked');
    return wrapBodyLine(compared ? `${summary} ${t(locale, 'resultComparedAfterLimit')}` : summary, width);
  }
  if (result.record.outcome.termination.kind === 'limit_reached') {
    const code = result.record.outcome.termination.code;
    const cap = code === 'limit.target_turns' ? t(locale, 'resultLimitTurns') : t(locale, 'resultLimitOther', { code });
    return wrapBodyLine(compared ? `${cap} ${t(locale, 'resultComparedAfterLimit')}` : cap, width);
  }
  return undefined;
}

function parentPath(path: string): string {
  const posix = asPosixPath(path).replace(/\/+$/, '');
  const slash = posix.lastIndexOf('/');
  return slash <= 0 ? posix : posix.slice(0, slash);
}

function shortPath(path: string | undefined, experimentRoot: string | undefined, vacant: string): string {
  if (!path?.trim()) return vacant;
  if (experimentRoot) {
    const relativePath = relativeInside(experimentRoot, path);
    if (relativePath) return relativePath;
  }
  const parts = asPosixPath(path).split('/').filter((item) => item);
  return parts[parts.length - 1] ?? path;
}

/** Prefer basename short labels on the result first screen; full path stays on the hit target. */
function shortLabel(path: string | undefined, experimentRoot: string | undefined, vacant: string): string {
  if (!path?.trim()) return vacant;
  const relative = shortPath(path, experimentRoot, vacant);
  const parts = asPosixPath(relative).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? relative;
}
