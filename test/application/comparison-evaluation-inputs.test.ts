import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareComparisonEvaluationFixture, EVALUATION_POLICY } from '../../scripts/comparison-evaluation-fixtures.js';
import { verifyComparisonEvaluationInputs } from '../../scripts/comparison-evaluation-inputs.js';
import { readComparisonEvaluationSuite } from '../../src/application/comparison-evaluation.js';
import { comparePersistedExperiment } from '../../src/application/experiment-compare-persisted.js';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema } from '../../src/core/schema.js';
import { sha256 } from '../../src/core/identity.js';
import { parseCommittedEventLog } from '../../src/infrastructure/agent/model-input.js';
import { publicationSteps, scriptedComparison } from '../support/autonomous-comparison.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-evaluation-input-binding-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const suite = readComparisonEvaluationSuite(JSON.parse(await readFile(new URL('../fixtures/comparison-evaluation/suite.json', import.meta.url), 'utf8')) as unknown);
  const item = suite.cases[0]!;
  const prepared = await prepareComparisonEvaluationFixture(root, item);
  return { root, item, prepared };
}

test('frozen input identity rejects task changes with old contentHash and candidate byte changes', async t => {
  const { root, item, prepared } = await fixture(t);
  const verify = () => verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
  await verify();
  const casePath = join(prepared.dataDir, 'cases', `case-${item.id}`, 'case.json');
  const original = await readFile(casePath);
  const task: unknown = JSON.parse(original.toString('utf8'));
  assert.ok(Value.Check(TaskCaseSchema, task));
  const originalHash = task.contentHash;
  task.initialInput.text = 'Changed task while retaining old declared content hash';
  assert.equal(task.contentHash, originalHash);
  await writeFile(casePath, JSON.stringify(task));
  await assert.rejects(verify(), /Frozen evaluation input changed/);
  await writeFile(casePath, original);
  const candidate = join(prepared.dataDir, 'experiments', prepared.experimentId, 'environment', 'snapshots', 'fixture-run', item.candidate.file);
  const originalCandidate = await readFile(candidate);
  await writeFile(candidate, 'Different candidate delivery');
  await assert.rejects(verify(), /Frozen evaluation input changed/);
  await writeFile(candidate, originalCandidate);
  await verify();
  await assert.rejects(verifyComparisonEvaluationInputs(root, item, 'a'.repeat(64)), /identity mismatch/);
  await assert.rejects(verifyComparisonEvaluationInputs(root, { ...item, task: 'New suite task' }, prepared.inputIdentityHash), /identity mismatch/);
});

test('legitimate persisted comparisons can append events and artifacts without invalidating frozen inputs', async t => {
  const { root, item, prepared } = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    await verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
    const scripted = scriptedComparison(publicationSteps().slice(0, 2), { onGeneration: (_context, index) => {
      if (index === 2) throw new Error('Offline fixture failure after accepted autonomous submission');
    } });
    const result = await comparePersistedExperiment({ ...prepared,
      comparison: attempt === 0 ? { compare: async () => ({ status: 'cancelled' }), cancel: async () => {} } : scripted.agents.comparison,
      agentConfig: scripted.agents.config,
      policy: EVALUATION_POLICY, now: new Date().toISOString() });
    assert.equal(result.comparison.result.status, attempt === 0 ? 'cancelled' : 'failed');
    if (attempt === 1) {
      assert.equal(scripted.contexts.length, 3, 'The current factory must reach the deliberate post-submission failure rather than time out');
      assert.ok(result.comparison.result.status === 'failed');
      assert.match(result.comparison.result.failure.message, /Offline fixture failure after accepted autonomous submission/);
    }
    await verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
  }
  const eventsPath = join(prepared.dataDir, 'experiments', prepared.experimentId, 'events.jsonl');
  const events = await readFile(eventsPath);
  assert.ok(parseCommittedEventLog(events.toString('utf8')).events.some(event => {
    const payload = event.payload as { tool?: string; details?: { status?: string }; nativeHook?: unknown };
    return event.type === 'agent.tool_completed' && payload.tool === 'submit_report' && !payload.nativeHook && payload.details?.status === 'accepted';
  }), 'Actual accepted submission must be present in the permitted suffix');
  await writeFile(eventsPath, events.subarray(1));
  await assert.rejects(verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash), /event prefix changed/);
});

test('unexpected source files are rejected while separately generated report outputs stay outside input identity', async t => {
  const { root, item, prepared } = await fixture(t);
  await writeFile(join(root, 'report.html'), 'Generated output');
  await verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
  await writeFile(join(root, 'source', 'extra.txt'), 'Unexpected new source');
  await assert.rejects(verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash), /Unexpected file added/);
});

test('frozen inputs permit persisted draft audit and Host investigation closure suffix events', async t => {
  const { root, item, prepared } = await fixture(t);
  const eventsPath = join(prepared.dataDir, 'experiments', prepared.experimentId, 'events.jsonl');
  let sequence = parseCommittedEventLog(await readFile(eventsPath, 'utf8')).events.length;
  for (const event of [
    { type: 'comparison.draft_audit_started', payload: {
      schemaVersion: 1, attemptId: 'attempt', sessionId: 'review-session', inspectionRequired: true,
    } },
    { type: 'comparison.investigation_closed', payload: {
      schemaVersion: 1, attemptId: 'attempt', sessionId: 'investigation-session', reason: 'bounded_investigation_timeout',
      previous: { revision: 1, catalogRevision: 0, digest: 'a'.repeat(64) },
      current: { revision: 2, catalogRevision: 0, digest: 'b'.repeat(64) },
      questionIds: ['question'], semanticAssessment: 'not_certified',
    } },
  ]) {
    sequence++;
    const body = { schemaVersion: 1, sequence, eventId: `comparison-${sequence}`, occurredAt: new Date().toISOString(), runId: 'fixture-run', ...event };
    await appendFile(eventsPath, `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`);
    await verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
  }
});

test('valid checksums cannot authorize new Runtime or Controller process observations after preparation', async t => {
  const { root, item, prepared } = await fixture(t);
  const eventsPath = join(prepared.dataDir, 'experiments', prepared.experimentId, 'events.jsonl');
  const original = await readFile(eventsPath);
  const sequence = parseCommittedEventLog(original.toString('utf8')).events.length + 1;
  for (const event of [
    { type: 'comparison.unknown_future_event', payload: {} },
    { type: 'runtime.tool_finished', payload: { item: { type: 'commandExecution', command: 'invented check', aggregated_output: 'New process evidence' } } },
    { type: 'agent.tool_completed', payload: { role: 'controller', tool: 'new-check', result: 'New process evidence' } },
    { type: 'agent.model_stream_completed', payload: { role: 'controller', schemaVersion: 1, requestIndex: 1,
      startedAt: 1000, firstEventAt: 1010, firstTextAt: null, finishedAt: 1030, events: 1 } },
    { type: 'artifact.created', payload: { artifactId: 'new-candidate-evidence' } },
  ]) {
    const body = { schemaVersion: 1, sequence, eventId: `injected-${sequence}`, occurredAt: new Date().toISOString(), runId: 'fixture-run', ...event };
    await appendFile(eventsPath, `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`);
    assert.equal(parseCommittedEventLog(await readFile(eventsPath, 'utf8')).diagnostic, undefined);
    await assert.rejects(verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash), /Non-Comparison event appended/);
    await writeFile(eventsPath, original);
  }
});
