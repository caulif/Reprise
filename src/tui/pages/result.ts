import { join } from 'node:path';
import type { CodexExperimentResult } from '../../application/codex-experiment.js';
import { missing } from '../format.js';
import type { Theme } from '../theme.js';
import { joinColumns, kv, panel } from '../widgets.js';

export function renderResult(theme: Theme, width: number, result: CodexExperimentResult): string[] {
  const kind = result.record.outcome.termination.kind;
  const vacant = theme.framed ? '—' : '-';
  const decision = result.decision.status === 'completed'
    ? result.decision.value.type
    : missing(result.decision.status, vacant);
  const comparison = missing(result.comparison.result.status, vacant);
  const limitations = result.preflight?.limitations?.length
    ? result.preflight.limitations.join(' | ')
    : vacant;
  const fidelity = result.preflight?.comparisonClass
    ?? (result.record as { fidelity?: { comparisonClass?: string } }).fidelity?.comparisonClass
    ?? 'observational';
  const experimentRoot = result.experimentRoot ?? dirnameSafe(result.reportPath);
  const trace = experimentRoot && result.record.attempt?.runId
    ? join(experimentRoot, 'runs', result.record.attempt.runId) + sepEnd()
    : vacant;
  const col = theme.density === 'wide' ? Math.floor((width - 4) / 2) : width - 2;
  const facts = theme.density === 'wide'
    ? [
      ...joinColumns(
        [kv(theme, 'Run', result.record.attempt.runId, col), kv(theme, 'Controller', decision, col), kv(theme, 'Fidelity', fidelity, col)],
        [kv(theme, 'Cleanup', result.record.outcome.cleanup.status, col), kv(theme, 'Comparison', comparison, col), kv(theme, 'Limitations', limitations, col)],
        col, col, 2,
      ),
    ]
    : [
      kv(theme, 'Run', result.record.attempt.runId, width - 2),
      kv(theme, 'Cleanup', result.record.outcome.cleanup.status, width - 2),
      kv(theme, 'Controller', decision, width - 2),
      kv(theme, 'Comparison', comparison, width - 2),
      kv(theme, 'Fidelity', fidelity, width - 2),
      kv(theme, 'Limitations', limitations, width - 2),
    ];
  return panel(theme, `Run result ${theme.glyphs.h} ${kind}`, [
    terminationBanner(theme, kind),
    `     ${result.record.outcome.termination.code}`,
    '',
    ...facts,
    kv(theme, 'Report', missing(result.reportPath, vacant), width - 2),
    kv(theme, 'Trace', trace, width - 2),
    '',
    ' Single run. Results vary between runs. Reprise records facts for inspection, not rankings.',
  ], width);
}

export function resultHints(): readonly (readonly [string, string])[] {
  return [['Enter', 'Home'], ['b', 'Home']];
}

function terminationBanner(theme: Theme, kind: string): string {
  if (kind === 'completed') return theme.style.ok(` ${theme.glyphs.ok} ${kind}`);
  if (kind === 'cancelled') return theme.style.warn(` ${theme.glyphs.warn} ${kind}`);
  return theme.style.danger(` ${theme.glyphs.err} ${kind}`);
}

function dirnameSafe(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : undefined;
}

function sepEnd(): string {
  return process.platform === 'win32' ? '\\' : '/';
}
