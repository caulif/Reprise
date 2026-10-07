import { Value } from '@sinclair/typebox/value';
import { sha256 } from '../src/core/identity.js';
import { TaskCaseSchema, type TaskCase } from '../src/core/schema.js';
import type { ComparisonEvaluationCase } from '../src/core/comparison-evaluation-schema.js';

export function comparisonEvaluationTask(item: ComparisonEvaluationCase): TaskCase {
  const sourceHash = sha256(JSON.stringify(item));
  const task: TaskCase = {
    schemaVersion: 1, caseId: `case-${item.id}`, source: { productId: 'codex', sessionId: `fixture-${item.id}` },
    initialInput: { id: 'user-1', role: 'user', text: item.task },
    transcript: [{ id: 'user-1', role: 'user', text: item.task },
      ...(item.baseline.content === undefined ? [] : [{ id: 'historical-artifact', role: 'tool' as const,
        text: `Synthetic frozen final file write: ${item.baseline.file}\n${item.baseline.content}` }]),
      { id: 'historical-process', role: 'tool', text: `Synthetic frozen process observations:\n${item.baseline.process.join('\n')}` },
      { id: 'historical-final', role: 'assistant', text: item.baseline.finalMessage }],
    historicalEvents: [], baseline: { status: item.baseline.content === undefined ? 'unavailable' : 'available',
      finalMessage: item.baseline.finalMessage, artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: 'codex', version: 'synthetic-v1', model: item.baseline.model, artifactRefs: [] },
    taskContext: { evaluationProvenance: 'synthetic', note: 'Frozen hand-authored fixtures, not real model executions. Evaluation expectations are not model inputs.' },
    provenance: { packVersion: 'comparison-evaluation-v1', importedAt: '2026-10-04T00:00:00.000Z', sourceHash },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: sourceHash,
  };
  if (!Value.Check(TaskCaseSchema, task)) throw new Error('Evaluation TaskCase failed schema validation.');
  return task;
}
