import { Value } from '@sinclair/typebox/value';
import { assertComparisonResult, type ComparisonResult } from '../agents/comparison-agent.js';
import { buildComparisonContext } from '../application/comparison.js';
import { ArtifactRefSchema, type ArtifactRef, type RunRecord, type TaskCase } from '../core/schema.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TEXT_LENGTH = 4_000;

export type ReportArtifact = {
  ref: ArtifactRef;
  kind: string;
  mediaType?: string;
  byteLength?: number;
  unavailableReason?: string;
};

export type ComparisonProjection = {
  task: { caseId: string; input: string; baseline: { status: string; summary: string; artifactIds: readonly string[] } };
  comparison?: ComparisonResult;
  runs: readonly ReportRun[];
  artifacts: readonly ProjectedArtifact[];
};

type ReportRun = {
  runId: string;
  candidate: string;
  model: string;
  taskStatus: string;
  termination: string;
  fidelity: string;
  fidelityReasons: readonly string[];
  telemetry: string;
  warnings: readonly string[];
};

type ProjectedArtifact = {
  artifactId: string;
  kind: string;
  mediaType?: string;
  byteLength?: number;
  unavailableReason?: string;
  href?: string;
};

export function buildComparisonProjection(input: {
  taskCase: TaskCase;
  runs: readonly RunRecord[];
  comparison?: ComparisonResult;
  artifacts?: readonly ReportArtifact[];
}): ComparisonProjection {
  const context = buildComparisonContext(input.taskCase, input.runs);
  assertSingleExperiment(input.runs);
  if (input.comparison) assertComparisonResult(input.comparison, context);
  const artifacts = projectArtifacts(input.runs, input.artifacts ?? []);
  return {
    task: {
      caseId: input.taskCase.caseId,
      input: displayText(input.taskCase.initialInput.text),
      baseline: {
        status: input.taskCase.baseline.status,
        summary: displayText(input.taskCase.baseline.finalMessage ?? `Baseline ${input.taskCase.baseline.status}.`),
        artifactIds: input.taskCase.baseline.artifactRefs.map((ref) => ref.artifactId).sort(),
      },
    },
    ...(input.comparison ? { comparison: sanitizeComparison(input.comparison) } : {}),
    runs: input.runs.slice().sort((left, right) => left.attempt.runId.localeCompare(right.attempt.runId)).map(projectRun),
    artifacts,
  };
}

export function renderComparisonReport(projection: ComparisonProjection): string {
  const body = [renderTask(projection), renderComparison(projection.comparison), renderRuns(projection.runs), renderArtifacts(projection.artifacts)].join('\n');
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(`Reprise comparison: ${projection.task.caseId}`)}</title><style>${styles}</style></head>\n<body><main><h1>Reprise comparison</h1>${body}</main></body>\n</html>\n`;
}

function assertSingleExperiment(runs: readonly RunRecord[]): void {
  const experimentId = runs[0]?.attempt.experimentId;
  if (experimentId && runs.some((run) => run.attempt.experimentId !== experimentId)) {
    throw new Error('Report runs must belong to one experiment.');
  }
}

function projectRun(run: RunRecord): ReportRun {
  const traceCount = run.trace.lastSequence - run.trace.firstSequence + 1;
  return {
    runId: run.attempt.runId,
    candidate: run.attempt.candidate.candidateId,
    model: run.attempt.candidate.requestedModel,
    taskStatus: run.outcome.task.status,
    termination: `${run.outcome.termination.kind}: ${run.outcome.termination.code} (${run.outcome.termination.initiatedBy})`,
    fidelity: `${run.fidelity.comparisonClass}; environment ${run.fidelity.environment}; model ${run.fidelity.modelResolution}`,
    fidelityReasons: run.fidelity.reasons.map(displayText),
    telemetry: `Trace telemetry: events ${run.trace.firstSequence}-${run.trace.lastSequence} (${traceCount}).`,
    warnings: run.warnings.map((warning) => `${warning.code}: ${displayText(warning.message)}`),
  };
}

function projectArtifacts(runs: readonly RunRecord[], supplied: readonly ReportArtifact[]): ProjectedArtifact[] {
  const known = new Map<string, ArtifactRef>();
  for (const run of runs) for (const ref of run.artifactRefs) known.set(artifactKey(ref), ref);
  const artifacts: readonly ReportArtifact[] = supplied.length ? supplied : [...known.values()].map((ref) => ({ ref, kind: 'unknown' }));
  return artifacts.map((artifact) => {
    if (!Value.Check(ArtifactRefSchema, artifact.ref) || !known.has(artifactKey(artifact.ref))) throw new Error('Artifact catalog contains an unowned reference.');
    if (!artifact.kind.trim() || (artifact.mediaType !== undefined && !artifact.mediaType.trim())) throw new Error('Artifact catalog contains invalid metadata.');
    if (artifact.byteLength !== undefined && (!Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0)) throw new Error('Artifact catalog contains an invalid byte length.');
    const href = safeArtifactHref(artifact.ref, runs);
    return {
      artifactId: artifact.ref.artifactId,
      kind: artifact.kind,
      ...(artifact.mediaType ? { mediaType: displayText(artifact.mediaType, 200) } : {}),
      ...(artifact.byteLength !== undefined ? { byteLength: artifact.byteLength } : {}),
      ...(artifact.unavailableReason ? { unavailableReason: displayText(artifact.unavailableReason) } : {}),
      ...(href ? { href } : {}),
    };
  }).sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function safeArtifactHref(ref: ArtifactRef, runs: readonly RunRecord[]): string | undefined {
  if (!('experimentId' in ref) || !SAFE_ID.test(ref.artifactId) || (ref.runId !== undefined && !SAFE_ID.test(ref.runId))) return undefined;
  if (!runs.some((run) => run.attempt.experimentId === ref.experimentId && (ref.runId === undefined || run.attempt.runId === ref.runId))) return undefined;
  return ref.runId ? `./runs/${ref.runId}/artifacts/${ref.artifactId}` : `./artifacts/${ref.artifactId}`;
}

function artifactKey(ref: ArtifactRef): string {
  return 'experimentId' in ref ? `${ref.experimentId}/${ref.runId ?? ''}/${ref.artifactId}` : `case/${ref.caseId}/${ref.artifactId}`;
}

function sanitizeComparison(result: ComparisonResult): ComparisonResult {
  return {
    ...result,
    summary: displayText(result.summary),
    observations: result.observations.map((observation) => ({ ...observation, text: displayText(observation.text) })),
    limitations: result.limitations.map(displayText),
  };
}

function renderTask(projection: ComparisonProjection): string {
  const baselineArtifacts = projection.task.baseline.artifactIds.length ? list(projection.task.baseline.artifactIds.map((id) => `Baseline artifact: ${id}`)) : '<p>Baseline has no cataloged artifacts.</p>';
  return `<section><h2>Task ${escapeHtml(projection.task.caseId)}</h2><p>${escapeHtml(projection.task.input)}</p><h3>Baseline (${escapeHtml(projection.task.baseline.status)})</h3><p>${escapeHtml(projection.task.baseline.summary)}</p>${baselineArtifacts}</section>`;
}

function renderComparison(comparison: ComparisonResult | undefined): string {
  if (!comparison) return '<section><h2>Comparison</h2><p>No validated comparison result is available. This report lists persisted facts only.</p></section>';
  const observations = comparison.observations.map((observation) => `<li>${escapeHtml(observation.text)} <small>Evidence: ${escapeHtml(observation.evidence.join(', '))}</small></li>`);
  return `<section><h2>Comparison</h2><p>${escapeHtml(comparison.summary)}</p>${observations.length ? `<h3>Observations</h3><ul>${observations.join('')}</ul>` : ''}${comparison.limitations.length ? `<h3>Limitations</h3>${list(comparison.limitations)}` : ''}</section>`;
}

function renderRuns(runs: readonly ReportRun[]): string {
  if (!runs.length) return '<section><h2>Candidate runs</h2><p>No persisted candidate runs are available.</p></section>';
  return `<section><h2>Candidate runs</h2>${runs.map((run) => `<article><h3>${escapeHtml(run.runId)} · ${escapeHtml(run.candidate)}</h3><dl><dt>Model</dt><dd>${escapeHtml(run.model)}</dd><dt>Task assessment</dt><dd>${escapeHtml(run.taskStatus)}</dd><dt>Stop reason</dt><dd>${escapeHtml(run.termination)}</dd><dt>Fidelity</dt><dd>${escapeHtml(run.fidelity)}</dd><dt>Telemetry</dt><dd>${escapeHtml(run.telemetry)}</dd></dl>${run.fidelityReasons.length ? `<h4>Fidelity reasons</h4>${list(run.fidelityReasons)}` : ''}${run.warnings.length ? `<h4>Warnings</h4>${list(run.warnings)}` : ''}</article>`).join('')}</section>`;
}

function renderArtifacts(artifacts: readonly ProjectedArtifact[]): string {
  if (!artifacts.length) return '<section><h2>Artifacts</h2><p>No experiment-owned artifacts are available.</p></section>';
  return `<section><h2>Artifacts</h2><ul>${artifacts.map((artifact) => `<li>${artifact.href ? `<a href="${escapeHtml(artifact.href)}">${escapeHtml(artifact.artifactId)}</a>` : escapeHtml(artifact.artifactId)} · ${escapeHtml(artifact.kind)}${artifact.mediaType ? ` · ${escapeHtml(artifact.mediaType)}` : ''}${artifact.byteLength !== undefined ? ` · ${artifact.byteLength} bytes` : ''}${artifact.unavailableReason ? ` · unavailable: ${escapeHtml(artifact.unavailableReason)}` : ''}</li>`).join('')}</ul></section>`;
}

function list(items: readonly string[]): string {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function displayText(value: string, limit = MAX_TEXT_LENGTH): string {
  const redacted = value.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"']+/g, '[path redacted]').replace(/(^|[\s([{'"])(\/[\S<>"']+)/gm, '$1[path redacted]');
  return redacted.length > limit ? `${redacted.slice(0, limit)}…` : redacted;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

const styles = 'body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#18212b}main{max-width:960px;margin:auto;padding:24px}section,article{background:#fff;border:1px solid #d9dee5;border-radius:8px;padding:16px;margin:16px 0}h1,h2,h3,h4{margin-top:0}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 12px}dt{font-weight:600}dd{margin:0}small{color:#52606d}a{color:#0759b0;overflow-wrap:anywhere}';