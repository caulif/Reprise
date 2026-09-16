import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeControllerSystemPrompt } from '../../src/agents/controller-agent.js';
import { composeComparisonSystemPrompt } from '../../src/agents/comparison-agent.js';
import { composeRecoverySystemPrompt } from '../../src/agents/recovery-agent.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { buildComparisonContext, type RunInspection } from '../../src/application/comparison.js';
import { renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';
import type { RunRecord, TaskCase } from '../../src/core/schema.js';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../test/snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

async function assertSnapshot(name: string, actual: string): Promise<void> {
  const path = join(SNAPSHOT_DIR, `${name}.txt`);
  const normalized = actual.replace(/\r\n/g, '\n');
  if (UPDATE) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, normalized, 'utf8');
    return;
  }
  const expected = (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(normalized, expected, `snapshot ${name} drifted; set UPDATE_SNAPSHOTS=1 to rewrite`);
}

function toolCatalog(tools: readonly { name: string; description: string; parameters: unknown }[]): string {
  return `${JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })), null, 2)}\n`;
}

test('agent system prompts match committed snapshots', async () => {
  await assertSnapshot('controller-system-prompt', `${composeControllerSystemPrompt('zh')}\n`);
  await assertSnapshot('comparison-system-prompt', `${composeComparisonSystemPrompt('zh')}\n`);
  await assertSnapshot('recovery-system-prompt', `${composeRecoverySystemPrompt('zh')}\n`);
});

test('comparison report shells match committed snapshots', async () => {
  const timestamp = '2026-08-15T00:00:00.000Z';
  const taskCase: TaskCase = {
    schemaVersion: 1, caseId: 'case-1', source: { productId: 'codex', sessionId: 'session-1' },
    initialInput: { id: 'message-1', role: 'user', text: 'Fix the report.' },
    transcript: [{ id: 'message-1', role: 'user', text: 'Fix the report.' }],
    historicalEvents: [],
    baseline: { status: 'available', finalMessage: 'Done.', artifactRefs: [], evidenceRefs: ['event:baseline-1'] },
    sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [], model: 'gpt-5' },
    provenance: { packVersion: 'fixture', importedAt: timestamp, sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: 'b'.repeat(64),
  };
  const runRecord: RunRecord = {
    attempt: {
      schemaVersion: 1, runId: 'run-1', experimentId: 'experiment-1', caseId: 'case-1',
      candidate: { candidateId: 'candidate-1', productId: 'codex', requestedModel: 'gpt-5.6' },
      policy: { wallClockMs: 1000, maxTargetTurns: 2, maxModelCalls: 3, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 },
      createdAt: timestamp,
    },
    state: 'finished', stageReached: 'awaiting_controller',
    outcome: {
      task: { status: 'incomplete', evidenceRefs: [] },
      termination: { kind: 'limit_reached', code: 'limit.turns', initiatedBy: 'harness' },
      cleanup: { status: 'complete', remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: 'experiment-1', runId: 'run-1', firstSequence: 1, lastSequence: 2 },
    artifactRefs: [], warnings: [],
  };
  const inspection: RunInspection = {
    runId: 'run-1', changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 1, wallClockMs: 4000,
  };
  const facts = buildComparisonContext(taskCase, [runRecord], [inspection]).reportFacts;
  const slots = { headline: 'The candidate produced a usable file.', 'key-differences': '<p>The candidate delivered a file; history did not.</p>' };
  await assertSnapshot('comparison-report-zh', renderComparisonReportShell({ task: 'Fix the report.', facts, metrics: facts.metrics ?? {}, slots, locale: 'zh' }));
  await assertSnapshot('comparison-report-en', renderComparisonReportShell({ task: 'Fix the report.', facts, metrics: facts.metrics ?? {}, slots, locale: 'en' }));
});

test('runtime-facing tool schemas match committed snapshots', async () => {
  await assertSnapshot('recovery-tools', toolCatalog(workspaceTools('TMP', { allowShell: true })));
});
