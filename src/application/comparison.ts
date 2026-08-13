import { Value } from '@sinclair/typebox/value';
import {
  RunRecordSchema,
  TaskCaseSchema,
  type RunRecord,
  type TaskCase,
} from '../core/schema.js';
import {
  assertComparisonResult,
  type ComparisonAgentPort,
  type ComparisonContext,
  type ComparisonResult,
} from '../agents/comparison-agent.js';
import type { AgentToolDefinition, StructuredAgentResult } from '../infrastructure/pi-agent-host.js';

export type RunInspection = {
  runId: string;
  finalMessage?: string;
  changedPaths: readonly string[];
  runtimeGeneratedPaths: readonly string[];
  commands: readonly string[];
  rejectedApprovals: number;
  turns: number;
  wallClockMs?: number;
  tokenCount?: number;
};

export function buildComparisonContext(taskCase: TaskCase, runs: readonly RunRecord[], inspections: readonly RunInspection[] = []): ComparisonContext {
  assertFacts(taskCase, runs);
  return {
    task: { caseId: taskCase.caseId, summary: taskCase.initialInput.text },
    baseline: {
      summary: taskCase.baseline.finalMessage ?? `Baseline ${taskCase.baseline.status}.`,
      evidenceRefs: unique([...taskCase.baseline.evidenceRefs, ...taskCase.baseline.artifactRefs.map((ref) => `artifact:${ref.artifactId}`)]),
    },
    candidates: runs.map((run) => ({
      runId: run.attempt.runId,
      summary: inspectionSummary(run, inspections.find((item) => item.runId === run.attempt.runId), taskCase.privacy.allowModelText),
      evidenceRefs: runEvidence(run),
    })),
    telemetry: runs.map((run) => ({ runId: run.attempt.runId, summary: telemetrySummary(run, inspections.find((item) => item.runId === run.attempt.runId)) })),
    artifactRefs: unique(runs.flatMap((run) => run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`))),
    allowModelText: taskCase.privacy.allowModelText,
  };
}

export async function comparePersistedFacts(input: {
  taskCase: TaskCase;
  runs: readonly RunRecord[];
  agent: ComparisonAgentPort;
  tools?: readonly AgentToolDefinition[];
  inspections?: readonly RunInspection[];
}): Promise<{ context: ComparisonContext; result: StructuredAgentResult<ComparisonResult> }> {
  const context = buildComparisonContext(input.taskCase, input.runs, input.inspections);
  const result = await input.agent.compare(context, input.tools);
  if (result.status === 'completed') assertComparisonResult(result.value, context);
  return { context, result };
}

function assertFacts(taskCase: TaskCase, runs: readonly RunRecord[]): void {
  if (!Value.Check(TaskCaseSchema, taskCase)) throw new Error('Invalid TaskCase for comparison.');
  for (const run of runs) {
    if (!Value.Check(RunRecordSchema, run)) throw new Error('Invalid RunRecord for comparison.');
    if (run.attempt.caseId !== taskCase.caseId) throw new Error(`Run ${run.attempt.runId} does not belong to case ${taskCase.caseId}.`);
  }
}

function inspectionSummary(run: RunRecord, inspection: RunInspection | undefined, allowModelText: boolean): string {
  const facts = [`task=${run.outcome.task.status}`, `termination=${run.outcome.termination.code}`];
  if (!inspection) return `${facts.join('; ')}.`;
  facts.push(`turns=${inspection.turns}`, `changedFiles=${inspection.changedPaths.length}`, `commands=${inspection.commands.length}`);
  if (inspection.rejectedApprovals) facts.push(`rejectedApprovals=${inspection.rejectedApprovals}`);
  if (allowModelText && inspection.finalMessage) facts.push(`finalMessage=${inspection.finalMessage}`);
  return `${facts.join('; ')}.`;
}

function telemetrySummary(run: RunRecord, inspection: RunInspection | undefined): string {
  if (!inspection) return `Trace events ${run.trace.firstSequence}-${run.trace.lastSequence}.`;
  return [`turns=${inspection.turns}`, inspection.wallClockMs === undefined ? undefined : `wallClockMs=${inspection.wallClockMs}`, inspection.tokenCount === undefined ? undefined : `tokens=${inspection.tokenCount}`].filter((value): value is string => Boolean(value)).join('; ');
}

function runEvidence(run: RunRecord): string[] {
  return unique([
    ...run.outcome.task.evidenceRefs,
    ...run.outcome.cleanup.evidenceRefs,
    ...(run.outcome.termination.failure?.evidenceRefs ?? []),
    ...run.warnings.flatMap((warning) => warning.evidenceRefs),
    ...run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`),
  ]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
