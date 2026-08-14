import { Value } from '@sinclair/typebox/value';
import { assertComparisonResult, type ComparisonResult } from '../agents/comparison-agent.js';
import { SAFE_ID } from '../core/identity.js';
import { buildComparisonContext, type RunInspection } from '../application/comparison.js';
import { describeStop } from '../application/replay-conditions.js';
import { ArtifactRefSchema, type ArtifactRef, type RunRecord, type TaskCase } from '../core/schema.js';
import { reportCopy } from './copy.js';
import { renderSafeMarkdown, reportLang } from './safe-markdown.js';

const MAX_NARRATIVE_LENGTH = 64 * 1024;

export type ReportArtifact = { ref: ArtifactRef; kind: string; mediaType?: string; byteLength?: number; unavailableReason?: string };
export type ComparisonProjection = {
  caseId: string;
  taskSummary: string;
  lang: 'zh' | 'en';
  baseline: { status: string; summary: string };
  runs: readonly ReportRun[];
  narrative?: string;
  narrativePath?: string;
  artifacts: readonly ProjectedArtifact[];
  changedPaths: readonly string[];
};
type ReportRun = {
  runId: string;
  model: string;
  startedAt: string;
  metrics: string;
  termination: string;
  stopLabel: string;
  conditions?: readonly string[];
};
type ProjectedArtifact = { artifactId: string; kind: string; mediaType?: string; byteLength?: number; unavailableReason?: string; href?: string };

/** Reprojects immutable Host facts; it never needs a live model call. */
export function buildComparisonProjection(input: { taskCase: TaskCase; runs: readonly RunRecord[]; comparison?: ComparisonResult; comparisonNarrative?: string; artifacts?: readonly ReportArtifact[]; inspections?: readonly RunInspection[] }): ComparisonProjection {
  const context = buildComparisonContext(input.taskCase, input.runs, input.inspections);
  assertSingleExperiment(input.runs);
  if (input.comparison) assertComparisonResult(input.comparison, context);
  const narrative = input.comparisonNarrative ? truncate(input.comparisonNarrative, MAX_NARRATIVE_LENGTH) : undefined;
  const inspections = input.inspections ?? [];
  const lang = reportLang(input.taskCase.initialInput.text);
  const copy = reportCopy(lang);
  return {
    caseId: input.taskCase.caseId,
    taskSummary: input.taskCase.initialInput.text,
    lang,
    baseline: {
      status: copy.baselineStatus(input.taskCase.baseline.status),
      summary: input.taskCase.baseline.finalMessage ?? copy.baselineFallback(input.taskCase.baseline.status),
    },
    runs: input.runs.slice().sort((left, right) => left.attempt.runId.localeCompare(right.attempt.runId)).map((run) => projectRun(run, inspections.find((item) => item.runId === run.attempt.runId), lang)),
    ...(narrative ? { narrative } : {}),
    ...(input.comparison ? { narrativePath: input.comparison.reportPath } : {}),
    artifacts: projectArtifacts(input.runs, input.artifacts ?? []),
    changedPaths: unique(inspections.flatMap((item) => item.changedPaths)),
  };
}

export function renderComparisonReport(projection: ComparisonProjection): string {
  const body = [renderHeader(projection), renderNarrative(projection), renderCompare(projection), renderFiles(projection)].join('');
  const copy = reportCopy(projection.lang);
  return `<!doctype html>\n<html lang="${projection.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(`${copy.product}: ${projection.caseId}`)}</title><style>${styles}</style></head><body><main class="lang-${projection.lang}">${body}</main></body></html>\n`;
}

function assertSingleExperiment(runs: readonly RunRecord[]): void {
  const experimentId = runs[0]?.attempt.experimentId;
  if (experimentId && runs.some((run) => run.attempt.experimentId !== experimentId)) throw new Error('Report runs must belong to one experiment.');
}
function projectRun(run: RunRecord, inspection: RunInspection | undefined, lang: 'zh' | 'en'): ReportRun {
  const copy = reportCopy(lang);
  const requested = run.attempt.candidate.requestedModel;
  const resolved = run.manifest?.resolvedModel.resolved;
  const model = resolved && resolved !== 'unknown' && resolved !== requested ? `${requested} → ${resolved}` : requested;
  const metrics = inspection
    ? [copy.turns(inspection.turns), inspection.wallClockMs === undefined ? undefined : copy.wallClock(inspection.wallClockMs), copy.changedFiles(inspection.changedPaths.length), inspection.tokenCount === undefined ? undefined : copy.tokens(inspection.tokenCount)].filter((value): value is string => Boolean(value)).join(' · ')
    : copy.traceEvents(run.trace.firstSequence, run.trace.lastSequence);
  return {
    runId: run.attempt.runId,
    model,
    startedAt: run.attempt.createdAt,
    metrics,
    termination: run.outcome.termination.code,
    stopLabel: describeStop(run, lang),
    ...(inspection?.replayConditions?.length ? { conditions: inspection.replayConditions } : {}),
  };
}
function projectArtifacts(runs: readonly RunRecord[], supplied: readonly ReportArtifact[]): ProjectedArtifact[] {
  const known = new Map<string, ArtifactRef>();
  for (const run of runs) for (const ref of run.artifactRefs) known.set(artifactKey(ref), ref);
  const artifacts: readonly ReportArtifact[] = supplied.length ? supplied : [...known.values()].map((ref) => ({ ref, kind: 'unknown' }));
  return artifacts.map((artifact) => {
    if (!Value.Check(ArtifactRefSchema, artifact.ref) || !known.has(artifactKey(artifact.ref))) throw new Error('Artifact catalog contains an unowned reference.');
    if (!artifact.kind.trim() || (artifact.mediaType !== undefined && !artifact.mediaType.trim()) || (artifact.byteLength !== undefined && (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0))) throw new Error('Artifact catalog contains invalid metadata.');
    const href = safeArtifactHref(artifact.ref, runs);
    return { artifactId: artifact.ref.artifactId, kind: artifact.kind, ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}), ...(artifact.byteLength !== undefined ? { byteLength: artifact.byteLength } : {}), ...(artifact.unavailableReason ? { unavailableReason: artifact.unavailableReason } : {}), ...(href ? { href } : {}) };
  });
}
function renderHeader(projection: ComparisonProjection): string {
  const copy = reportCopy(projection.lang);
  const run = projection.runs[0];
  const kicker = run
    ? `${copy.product} · ${projection.caseId} · ${run.runId}`
    : `${copy.product} · ${projection.caseId}`;
  const identity = run
    ? `<p class="run">${escapeHtml(run.model)} · ${escapeHtml(copy.started(run.startedAt))}</p><p class="metrics">${escapeHtml(run.metrics)}</p><p class="stop">${escapeHtml(run.stopLabel)}</p>`
    : `<p class="run">${escapeHtml(copy.noRuns)}</p>`;
  return `<header><p class="kicker">${escapeHtml(kicker)}</p><h1>${escapeHtml(compact(projection.taskSummary, 160))}</h1>${identity}<p class="notice">${escapeHtml(copy.notice)}</p></header>`;
}
function renderCompare(projection: ComparisonProjection): string {
  const copy = reportCopy(projection.lang);
  const run = projection.runs[0];
  const paths = projection.changedPaths;
  const extra = Math.max(0, paths.length - 4);
  const candidateDisk = paths.length
    ? copy.changedPaths(paths.length, compact(paths.slice(0, 4).join(', '), 160), extra)
    : copy.noChangedPaths;
  const conditions = run?.conditions?.length
    ? `<details class="limits"><summary>${escapeHtml(copy.limits)}</summary><ul class="conditions">${run.conditions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>`
    : '';
  return `<section class="compare"><h2>${escapeHtml(copy.contrast)}</h2><div class="strip"><article class="side baseline"><h3>${escapeHtml(copy.baseline)}</h3><p class="row"><span>${escapeHtml(copy.onDisk)}</span> ${escapeHtml(copy.baselineDisk)}</p><p class="row"><span>${escapeHtml(copy.outcome)}</span> ${escapeHtml(projection.baseline.status)}</p><p class="row"><span>${escapeHtml(copy.identity)}</span> ${escapeHtml(copy.frozenSession)}</p></article><article class="side candidate"><h3>${escapeHtml(copy.candidate)}</h3><p class="row"><span>${escapeHtml(copy.onDisk)}</span> ${escapeHtml(candidateDisk)}</p><p class="row"><span>${escapeHtml(copy.outcome)}</span> ${escapeHtml(run?.stopLabel ?? '—')}</p><p class="row"><span>${escapeHtml(copy.identity)}</span> ${escapeHtml(run?.model ?? '—')}</p></article></div>${conditions}</section>`;
}
function renderNarrative(projection: ComparisonProjection): string {
  const copy = reportCopy(projection.lang);
  if (!projection.narrative) return `<section class="narrative"><p>${escapeHtml(copy.noNarrative)}</p></section>`;
  const hrefs = new Map(projection.artifacts.filter((item) => item.href).map((item) => [item.artifactId, item.href ?? '']));
  return `<section class="narrative">${renderSafeMarkdown(projection.narrative, (id) => hrefs.get(id))}</section>`;
}
function renderFiles(projection: ComparisonProjection): string {
  const copy = reportCopy(projection.lang);
  const changed = projection.changedPaths.length
    ? `<ul class="paths">${projection.changedPaths.map((path) => `<li><code>${escapeHtml(path)}</code> · ${escapeHtml(copy.pathInScope)}</li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(copy.noChangedPathsListed)}</p>`;
  const entries = [
    ...(projection.narrativePath ? [`<a href="${escapeHtml(projection.narrativePath)}">${escapeHtml(projection.narrativePath)}</a> · ${escapeHtml(copy.narrativeLabel)}`] : []),
    ...projection.artifacts.map((artifact) => `${artifact.href ? `<a href="${escapeHtml(artifact.href)}">${escapeHtml(artifact.artifactId)}</a>` : escapeHtml(artifact.artifactId)} · ${escapeHtml(artifact.kind)}${artifact.mediaType ? ` · ${escapeHtml(artifact.mediaType)}` : ''}${artifact.byteLength !== undefined ? ` · ${artifact.byteLength} bytes` : ''}${artifact.unavailableReason ? ` · ${escapeHtml(copy.unavailable)}: ${escapeHtml(artifact.unavailableReason)}` : ''}`),
  ];
  const catalog = entries.length ? `<ul>${entries.map((entry) => `<li>${entry}</li>`).join('')}</ul>` : `<p>${escapeHtml(copy.noFiles)}</p>`;
  return `<section class="files"><h2>${escapeHtml(copy.evidence)}</h2><p>${escapeHtml(copy.evidenceNote)}</p>${changed}<details><summary>${escapeHtml(copy.catalog)}</summary>${catalog}</details></section>`;
}
function safeArtifactHref(ref: ArtifactRef, runs: readonly RunRecord[]): string | undefined { if (!('experimentId' in ref) || !SAFE_ID.test(ref.artifactId) || (ref.runId !== undefined && !SAFE_ID.test(ref.runId)) || !runs.some((run) => run.attempt.experimentId === ref.experimentId && (ref.runId === undefined || run.attempt.runId === ref.runId))) return undefined; return ref.runId ? `./runs/${ref.runId}/artifacts/${ref.artifactId}` : `./artifacts/${ref.artifactId}`; }
function artifactKey(ref: ArtifactRef): string { return 'experimentId' in ref ? `${ref.experimentId}/${ref.runId ?? ''}/${ref.artifactId}` : `case/${ref.caseId}/${ref.artifactId}`; }
function truncate(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}…` : value; }
function compact(value: string, limit: number): string { const text = value.replaceAll(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; }
function unique(values: readonly string[]): string[] { return [...new Set(values)]; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character); }

const styles = [
  ':root{--paper:#f4efe6;--ink:#1c1915;--muted:#5c564c;--line:#d7cfc2;--card:#fffaf2;--candidate:#8a4b12;--link:#6b3a0d;--warn:#f3e0c2}',
  '@media (prefers-color-scheme:dark){:root{--paper:#161310;--ink:#f3ece3;--muted:#b5ada2;--line:#3a342c;--card:#1e1a16;--candidate:#e0a36a;--link:#e0a36a;--warn:#3a2c18}}',
  '@media print{body{background:#fff;color:#000}header,section{border-color:#ccc}}',
  'body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 "Segoe UI","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif}',
  'main{max-width:960px;margin:auto;padding:28px 20px 48px}',
  'header,section{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:20px 22px;margin:16px 0}',
  'h1{font-size:22px;margin:4px 0 12px}h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 12px;color:var(--muted)}h3{font-size:16px;margin:0 0 8px}',
  '.lang-zh h2,.lang-zh .row span{text-transform:none;letter-spacing:0}',
  '.kicker{margin:0;color:var(--muted);font-size:13px}.run{margin:0;font-weight:600}.metrics,.stop,.notice,.muted{margin:6px 0 0;color:var(--muted);font-size:14px}',
  '.strip{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
  '.side{padding:12px 14px;border:1px solid var(--line);border-radius:4px}.side.candidate{border-color:var(--candidate)}.side.candidate h3{color:var(--candidate)}',
  '.row{margin:8px 0 0;font-size:14px}.row span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}',
  '.conditions{margin:8px 0 0;padding-left:20px;color:var(--muted);font-size:14px}',
  '.limits{margin-top:12px;background:var(--warn);padding:8px 12px;border-radius:4px}',
  '.narrative{border-color:var(--candidate)}.narrative h1,.narrative h2,.narrative h3{text-transform:none;letter-spacing:0;color:var(--ink)}.narrative>h1:first-child{font-size:26px;margin:0 0 12px}',
  'table{width:100%;border-collapse:collapse;margin:12px 0;font-size:14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;overflow-wrap:anywhere}',
  'ul,ol{margin:8px 0;padding-left:22px}pre,code{overflow-wrap:anywhere}pre{white-space:pre-wrap;margin:0}',
  'a{color:var(--link)}details{margin-top:12px}summary{cursor:pointer;color:var(--muted)}',
  '@media (max-width:720px){.strip{grid-template-columns:1fr}}',
].join('');
