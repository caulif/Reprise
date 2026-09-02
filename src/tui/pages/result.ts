import { join } from 'node:path';
import { asPosixPath, relativeInside } from '../../core/paths.js';
import type { CodexExperimentResult } from '../../application/experiment.js';
import { compact, missing } from '../format.js';
import { t, type Locale } from '../i18n.js';
import type { Theme } from '../theme.js';
import { joinColumns, kv, kvLinkBlock, panel, wrapBodyLine } from '../widgets.js';

export function renderResult(theme: Theme, width: number, result: CodexExperimentResult, locale: Locale = 'en', productLabel?: string): string[] {
  const kind = result.record.outcome.termination.kind;
  const vacant = theme.framed ? '—' : '-';
  const decision = controllerLabel(theme, result, vacant);
  const comparison = result.comparison.result.status === 'skipped'
    ? t(locale, 'comparisonSkipped')
    : missing(result.comparison.result.status, vacant);
  const experimentRoot = result.experimentRoot ?? (result.reportPath ? parentPath(result.reportPath) : undefined);
  const report = shortPath(result.reportPath, experimentRoot, vacant);
  const runId = result.record.attempt?.runId;
  const trace = tracePath(runId, theme, width, vacant);
  const traceAbs = runId && experimentRoot ? join(experimentRoot, 'runs', runId) : undefined;
  const summary = explainOutcome(result, Math.max(20, width - 4), productLabel ?? t(locale, 'unknownAgent'), locale);
  const metrics = metricsLine(theme, result);
  const col = theme.density === 'wide' ? Math.floor((width - 4) / 2) : width - 2;
  const facts = theme.density === 'wide'
    ? joinColumns(
      [kv(theme, 'Run', compact(result.record.attempt.runId, col - 14, theme.glyphs.ellipsis), col), kv(theme, 'Controller', decision, col)],
      [kv(theme, 'Cleanup', result.record.outcome.cleanup.status, col), kv(theme, 'Comparison', comparison, col)],
      col, col, 2,
    )
    : [
      kv(theme, 'Run', compact(result.record.attempt.runId, Math.max(12, width - 16), theme.glyphs.ellipsis), width - 2),
      kv(theme, 'Cleanup', result.record.outcome.cleanup.status, width - 2),
      kv(theme, 'Controller', decision, width - 2),
      kv(theme, 'Comparison', comparison, width - 2),
    ];
  return panel(theme, `${t(locale, 'resultTitle')} ${theme.glyphs.h} ${kind}`, [
    terminationBanner(theme, kind),
    `     ${result.record.outcome.termination.code}`,
    ...(metrics ? [`     ${metrics}`] : []),
    ...(summary ? ['', ...summary.map((line) => ` ${line}`)] : []),
    '',
    ...facts,
    ...(result.comparison.result.status === 'skipped' ? [] : kvLinkBlock(theme, 'Report', report, result.reportPath, width)),
    ...kvLinkBlock(theme, 'Trace', trace, traceAbs, width),
  ], width);
}

export function resultHints(locale: Locale = 'en'): readonly (readonly [string, string])[] {
  return [['o', t(locale, 'hintReport')], ['t', t(locale, 'hintTrace')], ['/', t(locale, 'hintFind')], ['Enter', t(locale, 'hintHome')], ['b', t(locale, 'hintHome')]];
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

function controllerLabel(theme: Theme, result: CodexExperimentResult, vacant: string): string {
  if (result.decision.status !== 'completed') return missing(result.decision.status, vacant);
  const value = result.decision.value;
  if (value.type === 'done') return value.reason ? `done ${theme.glyphs.sep} ${value.reason}` : 'done';
  return value.type;
}

function metricsLine(theme: Theme, result: CodexExperimentResult): string | undefined {
  const facts = result.facts;
  if (!facts) return undefined;
  const total = facts.elapsedMs;
  const candidate = facts.wallClockMs;
  const showBoth = total !== undefined && candidate !== undefined && total - candidate >= 2000;
  const parts = [
    total !== undefined ? `${Math.round(total / 1000)}s` : candidate === undefined ? undefined : `${Math.round(candidate / 1000)}s`,
    showBoth && candidate !== undefined ? `candidate ${Math.round(candidate / 1000)}s` : undefined,
    `${facts.turns} turn${facts.turns === 1 ? '' : 's'}`,
    `${facts.controllerCalls} controller`,
    facts.tokenCount === undefined ? undefined : `${facts.tokenCount} tokens`,
  ].filter((part): part is string => Boolean(part));
  return parts.join(` ${theme.glyphs.sep} `);
}

function explainOutcome(result: CodexExperimentResult, width: number, product: string, locale: Locale): readonly string[] | undefined {
  const failure = result.record.outcome.termination.failure;
  if (failure?.message) {
    const origin = failure.origin === 'controller' ? 'Controller' : failure.origin === 'runtime' ? product : failure.origin;
    const lines = failure.code === 'failed.runtime.upstream_unavailable'
      ? [t(locale, 'upstreamUnavailable'), `${origin}: ${failure.message}`]
      : /invalid JSON|schema validation failed/i.test(failure.message)
      ? [`${origin}: ${failure.message}`, `The Candidate turn still ran. This is a Harness-agent output error, not a ${product} runtime crash.`]
      : [`${origin}: ${failure.message}`];
    return lines.flatMap((line) => wrapBodyLine(line, width));
  }
  const value = result.decision.status === 'completed' ? result.decision.value : undefined;
  if (value?.type === 'done' && value.rationale?.trim()) return wrapBodyLine(value.rationale.trim(), width);
  if (result.record.outcome.termination.kind === 'blocked') {
    return wrapBodyLine('Candidate did not finish the original task. Comparison still ran. Press o for the report.', width);
  }
  if (result.record.outcome.termination.kind === 'limit_reached') {
    const code = result.record.outcome.termination.code;
    const message = code === 'limit.target_turns'
      ? 'Candidate reached the target turn limit. Comparison still ran. Press o for the report.'
      : `Candidate reached a run limit (${code}). Comparison still ran. Press o for the report.`;
    return wrapBodyLine(message, width);
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
  const parts = asPosixPath(path).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function tracePath(runId: string | undefined, theme: Theme, width: number, vacant: string): string {
  if (!runId) return vacant;
  const full = `runs/${runId}/`;
  const inner = Math.max(1, width - (theme.framed ? 2 : 3));
  const valueWidth = Math.max(8, inner - 14);
  if (full.length <= valueWidth) return full;
  return `runs/${compact(runId, Math.max(10, valueWidth - 6), theme.glyphs.ellipsis)}/`;
}
