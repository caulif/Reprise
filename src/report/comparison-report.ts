import { Value } from '@sinclair/typebox/value';
import { assertComparisonResult, type ComparisonResult } from '../agents/comparison-agent.js';
import { SAFE_ID } from '../core/identity.js';
import { buildComparisonContext, type RunInspection } from '../application/comparison.js';
import { ArtifactRefSchema, type ArtifactRef, type RunRecord, type TaskCase } from '../core/schema.js';

const MAX_NARRATIVE_LENGTH = 64 * 1024;
const SINGLE_RUN_NOTICE = 'Single run; results are affected by randomness. This report is not a ranking.';
const NO_NARRATIVE = 'No validated comparison narrative is available. The files below hold the persisted record.';

export type ReportArtifact = { ref: ArtifactRef; kind: string; mediaType?: string; byteLength?: number; unavailableReason?: string };
export type ComparisonProjection = {
  caseId: string;
  runs: readonly ReportRun[];
  narrative?: string;
  narrativePath?: string;
  artifacts: readonly ProjectedArtifact[];
};
type ReportRun = { runId: string; model: string; startedAt: string; metrics: string };
type ProjectedArtifact = { artifactId: string; kind: string; mediaType?: string; byteLength?: number; unavailableReason?: string; href?: string };

/** Reprojects immutable Host facts; it never needs a live model call. */
export function buildComparisonProjection(input: { taskCase: TaskCase; runs: readonly RunRecord[]; comparison?: ComparisonResult; comparisonNarrative?: string; artifacts?: readonly ReportArtifact[]; inspections?: readonly RunInspection[] }): ComparisonProjection {
  const context = buildComparisonContext(input.taskCase, input.runs, input.inspections);
  assertSingleExperiment(input.runs);
  if (input.comparison) assertComparisonResult(input.comparison, context);
  return {
    caseId: input.taskCase.caseId,
    runs: input.runs.slice().sort((left, right) => left.attempt.runId.localeCompare(right.attempt.runId)).map((run) => projectRun(run, input.inspections?.find((item) => item.runId === run.attempt.runId))),
    ...(input.comparisonNarrative ? { narrative: truncate(input.comparisonNarrative, MAX_NARRATIVE_LENGTH) } : {}),
    ...(input.comparison ? { narrativePath: input.comparison.reportPath } : {}),
    artifacts: projectArtifacts(input.runs, input.artifacts ?? []),
  };
}

export function renderComparisonReport(projection: ComparisonProjection): string {
  const body = [renderHeader(projection), renderNarrative(projection), renderFiles(projection)].join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(`Reprise comparison: ${projection.caseId}`)}</title><style>${styles}</style></head><body><main>${body}</main></body></html>\n`;
}

function assertSingleExperiment(runs: readonly RunRecord[]): void {
  const experimentId = runs[0]?.attempt.experimentId;
  if (experimentId && runs.some((run) => run.attempt.experimentId !== experimentId)) throw new Error('Report runs must belong to one experiment.');
}
function projectRun(run: RunRecord, inspection: RunInspection | undefined): ReportRun {
  const metrics = inspection
    ? [`Turns: ${inspection.turns}`, inspection.wallClockMs === undefined ? undefined : `Wall-clock: ${inspection.wallClockMs} ms`, `Changed files: ${inspection.changedPaths.length}`, inspection.tokenCount === undefined ? undefined : `Tokens: ${inspection.tokenCount}`].filter((value): value is string => Boolean(value)).join(' · ')
    : `Trace events ${run.trace.firstSequence}-${run.trace.lastSequence}.`;
  return { runId: run.attempt.runId, model: run.attempt.candidate.requestedModel, startedAt: run.attempt.createdAt, metrics };
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
  const runs = projection.runs.length
    ? projection.runs.map((run) => `<p class="run">${escapeHtml(run.model)} · ${escapeHtml(run.runId)} · started ${escapeHtml(run.startedAt)}</p><p class="metrics">${escapeHtml(run.metrics)}</p>`).join('')
    : '<p class="run">No persisted candidate runs are available.</p>';
  return `<header><h1>Reprise comparison · ${escapeHtml(projection.caseId)}</h1>${runs}<p class="notice">${SINGLE_RUN_NOTICE}</p></header>`;
}
/** The agent owns the body; the Host only escapes it, so a report can never carry agent-authored HTML. */
function renderNarrative(projection: ComparisonProjection): string {
  return projection.narrative ? `<section class="narrative"><pre>${escapeHtml(projection.narrative)}</pre></section>` : `<section class="narrative"><p>${NO_NARRATIVE}</p></section>`;
}
function renderFiles(projection: ComparisonProjection): string {
  const entries = [
    ...(projection.narrativePath ? [`<a href="${escapeHtml(projection.narrativePath)}">${escapeHtml(projection.narrativePath)}</a> · comparison narrative`] : []),
    ...projection.artifacts.map((artifact) => `${artifact.href ? `<a href="${escapeHtml(artifact.href)}">${escapeHtml(artifact.artifactId)}</a>` : escapeHtml(artifact.artifactId)} · ${escapeHtml(artifact.kind)}${artifact.mediaType ? ` · ${escapeHtml(artifact.mediaType)}` : ''}${artifact.byteLength !== undefined ? ` · ${artifact.byteLength} bytes` : ''}${artifact.unavailableReason ? ` · unavailable: ${escapeHtml(artifact.unavailableReason)}` : ''}`),
  ];
  const body = entries.length ? `<ul>${entries.map((entry) => `<li>${entry}</li>`).join('')}</ul>` : '<p>No experiment-owned files are available.</p>';
  return `<section><h2>Files</h2><p>Everything is on disk beside this report; open a file for the full detail.</p>${body}</section>`;
}
function safeArtifactHref(ref: ArtifactRef, runs: readonly RunRecord[]): string | undefined { if (!('experimentId' in ref) || !SAFE_ID.test(ref.artifactId) || (ref.runId !== undefined && !SAFE_ID.test(ref.runId)) || !runs.some((run) => run.attempt.experimentId === ref.experimentId && (ref.runId === undefined || run.attempt.runId === ref.runId))) return undefined; return ref.runId ? `./runs/${ref.runId}/artifacts/${ref.artifactId}` : `./artifacts/${ref.artifactId}`; }
function artifactKey(ref: ArtifactRef): string { return 'experimentId' in ref ? `${ref.experimentId}/${ref.runId ?? ''}/${ref.artifactId}` : `case/${ref.caseId}/${ref.artifactId}`; }
function truncate(value: string, limit: number): string { return value.length > limit ? `${value.slice(0, limit)}…` : value; }
function escapeHtml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character); }
const styles = 'pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#18212b}main{max-width:960px;margin:auto;padding:24px}header,section{background:#fff;border:1px solid #d9dee5;border-radius:8px;padding:16px;margin:16px 0}h1,h2{margin-top:0}h1{font-size:22px}.run{margin:0;font-weight:600}.metrics{margin:4px 0 0;color:#52606d}.notice{margin:12px 0 0;color:#52606d;font-size:14px}ul{margin:0;padding-left:20px}a{color:#0759b0;overflow-wrap:anywhere}';
