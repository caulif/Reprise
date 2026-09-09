import { join } from 'node:path';
import { asPosixPath, relativeInside } from '../../core/paths.js';
import type { ExperimentResult } from '../../application/experiment.js';
import { compact } from '../format.js';
import { formatHarnessFailure, t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { kv, kvLinkBlock, panel, wrapBodyLine } from '../widgets.js';

export function renderResult(theme: Theme, width: number, result: ExperimentResult, locale: Locale = 'en', productLabel?: string): string[] {
  const kind = result.record.outcome.termination.kind;
  const vacant = theme.framed ? '—' : '-';
  const skipped = result.comparison.result.status === 'skipped';
  const comparison = result.comparison.result;
  const failed = comparison.status === 'failed';
  const experimentRoot = result.experimentRoot ?? (result.reportPath ? parentPath(result.reportPath) : undefined);
  const report = shortPath(result.reportPath, experimentRoot, vacant);
  const runId = result.record.attempt?.runId;
  const trace = tracePath(runId, theme, width, vacant);
  const traceAbs = runId && experimentRoot ? join(experimentRoot, 'runs', runId) : undefined;
  const replicaAbs = runId && experimentRoot ? join(experimentRoot, 'environment', 'runs', runId) : undefined;
  const inner = Math.max(20, width - 4);
  const headline = skipped ? undefined : envelopeHeadline(result);
  const summary = explainOutcome(result, inner, productLabel ?? t(locale, 'unknownAgent'), locale);
  const metrics = metricsLine(theme, result, locale);
  return panel(theme, `${t(locale, 'resultTitle')} ${theme.glyphs.h} ${kind}`, [
    terminationBanner(theme, kind),
    kv(theme, 'Task', result.record.outcome.task.status, width - 2),
    kv(theme, 'Termination', `${kind} · ${result.record.outcome.termination.code}`, width - 2),
    kv(theme, 'Cleanup', result.record.outcome.cleanup?.status ?? vacant, width - 2),
    ...(!skipped ? [kv(theme, 'Comparison', failed ? `${locale === 'zh' ? '比较报告生成失败' : 'Report generation failed'} (${comparison.failure.kind ?? comparison.failure.code})` : comparison.status, width - 2)] : []),
    ...(metrics ? [`     ${metrics}`] : []),
    ...(headline ? ['', ...wrapBodyLine(headline, inner).map((line) => ` ${line}`)] : []),
    ...(summary ? ['', ...summary.map((line) => ` ${line}`)] : []),
    ...(skipped ? ['', kv(theme, 'Comparison', t(locale, 'comparisonSkipped'), width - 2)] : []),
    ...(skipped ? [] : kvLinkBlock(theme, failed ? 'Diagnostic' : 'Report', report, result.reportPath, width)),
    ...kvLinkBlock(theme, 'Replica', replicaLabel(runId, theme, width, vacant), replicaAbs, width),
    ...kvLinkBlock(theme, 'Trace', trace, traceAbs, width),
  ], width);
}

export function resultHints(locale: Locale = 'en', comparisonSkipped = false, comparePending = false): readonly (readonly [string, string])[] {
  const rest: readonly (readonly [string, string])[] = [
    ['t', t(locale, 'hintTrace')],
    ['w', t(locale, 'hintReplica')],
    ['Enter', t(locale, 'hintHome')],
    ['Esc', t(locale, 'hintHome')],
    ['b', t(locale, 'hintHome')],
  ];
  const report = comparisonSkipped ? rest : [['o', t(locale, 'hintReport')] as const, ...rest];
  return comparePending || comparisonSkipped
    ? [['c', t(locale, 'hintCompare')], ...report]
    : report;
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
  if (kind === 'cancelled' || kind === 'blocked' || kind === 'stalled') {
    return theme.style.warn(` ${theme.glyphs.warn} ${kind}`);
  }
  return theme.style.danger(` ${theme.glyphs.err} ${kind}`);
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
    `${missing} cost`,
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
      ? 'Candidate did not finish the original task. Comparison still ran. Press o for the report.'
      : 'Candidate did not finish the original task.', width);
  }
  if (result.record.outcome.termination.kind === 'limit_reached') {
    const code = result.record.outcome.termination.code;
    const cap = code === 'limit.target_turns' ? 'Candidate reached the target turn limit.' : `Candidate reached a run limit (${code}).`;
    return wrapBodyLine(compared ? `${cap} Comparison still ran. Press o for the report.` : cap, width);
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
