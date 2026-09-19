import { resolve, normalize } from 'node:path';
import { asPosixPath, relativeInside } from '../../core/paths.js';
import type { ExperimentResult } from '../../application/experiment.js';
import { resolveResultPathLinks, type ResultPathLinks } from '../../application/result-paths.js';
import { localPathFromFileUrl } from '../open-report.js';
import { compact, hitFileLink } from '../format.js';
import { formatHarnessFailure, t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { kv, kvLinkBlock, panel, panelWithHits, wrapBodyLine, type KvLinkBlock } from '../widgets.js';
import type { ResultAction } from '../page-input.js';

export type ResultPointerHit = { readonly action: ResultAction; readonly x0: number; readonly x1: number };
export type ResultRender = { readonly lines: readonly string[]; readonly rowHits: ReadonlyMap<number, readonly ResultPointerHit[]> };

export function renderResult(theme: Theme, width: number, result: ExperimentResult, locale: Locale = 'en', productLabel?: string, comparePending = false): string[] {
  return [...renderResultWithHits(theme, width, result, locale, productLabel, comparePending).lines];
}

export function renderResultWithHits(theme: Theme, width: number, result: ExperimentResult, locale: Locale = 'en', productLabel?: string, comparePending = false): ResultRender {
  const kind = result.record.outcome.termination.kind;
  const vacant = theme.framed ? '—' : '-';
  const skipped = result.comparison.result.status === 'skipped';
  const comparison = result.comparison.result;
  const failed = comparison.status === 'failed';
  const experimentRoot = result.experimentRoot ?? (result.reportPath ? parentPath(result.reportPath) : undefined);
  const paths = resolveResultPathLinks(result);
  const runId = result.record.attempt?.runId;
  const inner = Math.max(20, width - 4);
  const headline = skipped ? undefined : envelopeHeadline(result);
  const summary = explainOutcome(result, inner, productLabel ?? t(locale, 'unknownAgent'), locale);
  const metrics = metricsLine(theme, result, locale);
  const candidateLabel = candidateDisplayLabel(result, productLabel);
  const body: string[] = [];
  const bodyHits = new Map<number, readonly ResultPointerHit[]>();
  const push = (line: string) => {
    body.push(line);
  };
  const pushLink = (action: ResultAction, block: KvLinkBlock) => {
    for (let index = 0; index < block.lines.length; index += 1) {
      const hit = block.hits[index];
      if (hit) bodyHits.set(body.length, [{ action, ...hit }]);
      body.push(block.lines[index] ?? '');
    }
  };
  push(terminationBanner(theme, kind));
  push(kv(theme, t(locale, 'resultTask'), result.record.outcome.task.status, width - 2));
  push(kv(theme, t(locale, 'resultTermination'), `${kind} · ${result.record.outcome.termination.code}`, width - 2));
  push(kv(theme, t(locale, 'resultCleanup'), result.record.outcome.cleanup?.status ?? vacant, width - 2));
  if (candidateLabel) push(kv(theme, t(locale, 'candidateLabel'), candidateLabel, width - 2));
  if (!skipped) push(kv(theme, t(locale, 'resultComparison'), comparisonWord(comparison, locale), width - 2));
  if (metrics) push(`     ${metrics}`);
  if (headline) {
    push('');
    for (const line of wrapBodyLine(headline, inner)) push(` ${line}`);
  }
  if (summary) {
    push('');
    for (const line of summary) push(` ${line}`);
  }
  if (skipped) {
    push('');
    push(kv(theme, t(locale, 'resultComparison'), t(locale, 'comparisonSkipped'), width - 2));
  }
  if (comparePending) {
    push('');
    push(` ${theme.style.accent(t(locale, 'hintCompare'))}`);
  }
  pushLink('open-report', kvLinkBlock(theme, failed ? t(locale, 'resultDiagnostic') : t(locale, 'resultReport'), shortPath(paths.report, experimentRoot, vacant), paths.report, width));
  pushLink('open-history-final', kvLinkBlock(theme, t(locale, 'resultHistoryFinal'), shortPath(paths.historyFinal, experimentRoot, vacant), paths.historyFinal, width));
  pushLink('open-candidate-final', kvLinkBlock(theme, t(locale, 'resultCandidateFinal'), shortPath(paths.candidateFinal, experimentRoot, vacant), paths.candidateFinal, width));
  pushLink('open-trace', kvLinkBlock(theme, t(locale, 'resultTraceSecondary'), tracePath(runId, theme, width, vacant), paths.trace, width));
  pushLink('open-replica', kvLinkBlock(theme, t(locale, 'resultReplicaSecondary'), replicaLabel(runId, theme, width, vacant), paths.replica, width));
  return panelWithHits(theme, `${t(locale, 'resultTitle')} ${theme.glyphs.h} ${kind}`, body, width, bodyHits);
}

export function resultHints(locale: Locale = 'en', comparePending = false): readonly (readonly [string, string])[] {
  const opens: (readonly [string, string])[] = [
    ['o', t(locale, 'hintReport')],
    ['h', t(locale, 'hintHistoryFinal')],
    ['f', t(locale, 'hintCandidateFinal')],
  ];
  if (comparePending) return [['c', t(locale, 'hintCompare')], ...opens, ['Esc', t(locale, 'hintHome')]];
  return [...opens, ['Esc', t(locale, 'hintHome')]];
}

export function resultPointerAction(
  lines: readonly string[],
  row: number,
  col: number,
  locale: Locale = 'en',
  paths?: ResultPathLinks,
  rowHits?: ReadonlyMap<number, readonly ResultPointerHit[]>,
): ResultAction | undefined {
  const line = lines[row];
  if (!line) return undefined;
  const compare = t(locale, 'hintCompare');
  if (stripForHit(line).includes(compare)) return 'compare';
  const href = hitFileLink(line, col);
  if (href && paths) {
    const action = resolveResultLinkAction(href, paths);
    if (action) return action;
  }
  const hits = rowHits?.get(row);
  if (hits) {
    const match = hits.find((hit) => col >= hit.x0 && col <= hit.x1);
    if (match) return match.action;
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
  const model = candidate.requestedModel?.trim();
  if (!model) return product;
  return `${product} · ${model}`;
}

function stripForHit(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '');
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

function terminationBanner(theme: Theme, kind: string): string {
  if (kind === 'completed') return theme.style.ok(` ${theme.glyphs.ok} ${kind}`);
  return theme.style.danger(` ${kind === 'failed' ? theme.glyphs.err : theme.glyphs.warn} ${kind}`);
}

function comparisonWord(comparison: ExperimentResult['comparison']['result'], locale: Locale): string {
  if (comparison.status === 'failed') {
    return `${t(locale, 'comparisonFailedWord')} (${comparison.failure.kind ?? comparison.failure.code})`;
  }
  if (comparison.status === 'completed' && 'value' in comparison && comparison.value?.status === 'insufficient_evidence') {
    return t(locale, 'comparisonInsufficient');
  }
  return t(locale, 'comparisonDone');
}

function envelopeHeadline(result: ExperimentResult): string | undefined {
  const cmp = result.comparison.result;
  if (cmp.status !== 'completed' || !('value' in cmp)) return undefined;
  const text = cmp.value?.headline?.trim();
  return text || undefined;
}

function metricsLine(theme: Theme, result: ExperimentResult, locale: Locale): string | undefined {
  const facts = result.facts;
  if (!facts) return undefined;
  const total = facts.elapsedMs;
  const candidate = facts.wallClockMs;
  const showBoth = total !== undefined && candidate !== undefined && total - candidate >= 2000;
  const missing = t(locale, 'notRecorded');
  const parts = [
    total !== undefined ? `${Math.round(total / 1000)}s` : candidate === undefined ? undefined : `${Math.round(candidate / 1000)}s`,
    showBoth && candidate !== undefined ? `candidate ${Math.round(candidate / 1000)}s` : undefined,
    `${facts.turns} turn${facts.turns === 1 ? '' : 's'}`,
    `${facts.controllerCalls} controller`,
    facts.tokenCount === undefined ? `${missing} tokens` : `${facts.tokenCount} tokens`,
    facts.costUsd === undefined ? `${missing} cost` : `$${facts.costUsd.toFixed(2)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(` ${theme.glyphs.sep} `);
}

function explainOutcome(result: ExperimentResult, width: number, product: string, locale: Locale): readonly string[] | undefined {
  const failure = result.record.outcome.termination.failure;
  if (failure?.message) {
    if (failure.origin === 'controller' && result.decision.status === 'failed' && result.decision.failure?.kind) {
      return wrapBodyLine(formatHarnessFailure(locale, result.record.outcome.task.status === 'not_assessed' ? 'opening' : 'controller', result.decision.failure.kind), width);
    }
    const origin = failure.origin === 'controller' ? 'Controller' : failure.origin === 'runtime' ? product : failure.origin;
    const lines = failure.code === 'failed.runtime.upstream_unavailable'
      ? [t(locale, 'upstreamUnavailable'), `${origin}: ${failure.message}`]
      : /invalid JSON|schema validation failed/i.test(failure.message)
      ? [`${origin}: ${failure.message}`, `The Candidate turn still ran. This is a Harness-agent output error, not a ${product} runtime crash.`]
      : [`${origin}: ${failure.message}`];
    return lines.flatMap((line) => wrapBodyLine(line, width));
  }
  const value = result.decision.status === 'completed' ? result.decision.value : undefined;
  if (value?.type === 'done' && value.reason !== 'satisfied' && value.rationale?.trim()) {
    return wrapBodyLine(value.rationale.trim(), width);
  }
  const compared = result.comparison.result.status !== 'skipped';
  if (result.record.outcome.termination.kind === 'blocked') {
    return wrapBodyLine(compared
      ? 'Candidate did not finish the original task. Comparison still ran. Open the report from the short label.'
      : 'Candidate did not finish the original task.', width);
  }
  if (result.record.outcome.termination.kind === 'limit_reached') {
    const code = result.record.outcome.termination.code;
    const cap = code === 'limit.target_turns' ? 'Candidate reached the target turn limit.' : `Candidate reached a run limit (${code}).`;
    return wrapBodyLine(compared ? `${cap} Comparison still ran.` : cap, width);
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

function runFolderLabel(prefix: string, runId: string | undefined, theme: Theme, width: number, vacant: string): string {
  if (!runId) return vacant;
  const full = `${prefix}${runId}/`;
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const valueWidth = Math.max(8, inner - 14);
  if (full.length <= valueWidth) return full;
  return `${prefix}${compact(runId, Math.max(10, valueWidth - prefix.length - 1), theme.glyphs.ellipsis)}/`;
}

function replicaLabel(runId: string | undefined, theme: Theme, width: number, vacant: string): string {
  return runFolderLabel('environment/runs/', runId, theme, width, vacant);
}

function tracePath(runId: string | undefined, theme: Theme, width: number, vacant: string): string {
  return runFolderLabel('runs/', runId, theme, width, vacant);
}
