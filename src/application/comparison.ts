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
import type { StructuredAgentResult } from '../infrastructure/pi-agent-host.js';

export function buildComparisonContext(taskCase: TaskCase, runs: readonly RunRecord[]): ComparisonContext {
  assertFacts(taskCase, runs);
  return {
    task: { caseId: taskCase.caseId, summary: taskCase.initialInput.text },
    baseline: {
      summary: taskCase.baseline.finalMessage ?? `Baseline ${taskCase.baseline.status}.`,
      evidenceRefs: unique([...taskCase.baseline.evidenceRefs, ...taskCase.baseline.artifactRefs.map((ref) => `artifact:${ref.artifactId}`)]),
    },
    candidates: runs.map((run) => ({
      runId: run.attempt.runId,
      summary: `${run.outcome.task.status}; ${run.outcome.termination.code}.`,
      evidenceRefs: runEvidence(run),
    })),
    telemetry: runs.map((run) => ({ runId: run.attempt.runId, summary: `Trace events ${run.trace.firstSequence}-${run.trace.lastSequence}.` })),
    fidelity: runs.map((run) => ({ runId: run.attempt.runId, comparisonClass: run.fidelity.comparisonClass })),
    artifactRefs: unique(runs.flatMap((run) => run.artifactRefs.map((ref) => `artifact:${ref.artifactId}`))),
    allowModelText: taskCase.privacy.allowModelText,
  };
}

export async function comparePersistedFacts(input: {
  taskCase: TaskCase;
  runs: readonly RunRecord[];
  agent: ComparisonAgentPort;
}): Promise<{ context: ComparisonContext; result: StructuredAgentResult<ComparisonResult> }> {
  const context = buildComparisonContext(input.taskCase, input.runs);
  const result = await input.agent.compare(context);
  assertComparisonResult(result.value, context);
  return { context, result };
}

function assertFacts(taskCase: TaskCase, runs: readonly RunRecord[]): void {
  if (!Value.Check(TaskCaseSchema, taskCase)) throw new Error('Invalid TaskCase for comparison.');
  for (const run of runs) {
    if (!Value.Check(RunRecordSchema, run)) throw new Error('Invalid RunRecord for comparison.');
    if (run.attempt.caseId !== taskCase.caseId) throw new Error(`Run ${run.attempt.runId} does not belong to case ${taskCase.caseId}.`);
  }
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