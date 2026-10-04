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
import { ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';

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
    const result = await comparePersistedExperiment({ ...prepared,
      comparison: attempt === 0 ? { compare: async () => ({ status: 'cancelled' }), cancel: async () => {} }
        : new ComparisonAgent({ host: new AgentHost({ createSession: () => ({ append: async () => { throw new Error('Offline fixture failure'); }, cancel() {} }) }), timeoutMs: 1000, maxRepairAttempts: 0 }),
      agentConfig: { providerId: 'offline', requestedModel: 'offline', budget: { callTimeoutMs: 1000, maxStructuredRepairAttempts: 0 } },
      policy: EVALUATION_POLICY, now: new Date().toISOString() });
    assert.equal(result.comparison.result.status, attempt === 0 ? 'cancelled' : 'failed');
    await verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash);
  }
  const eventsPath = join(prepared.dataDir, 'experiments', prepared.experimentId, 'events.jsonl');
  const events = await readFile(eventsPath);
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

test('valid checksums cannot authorize new Runtime or Controller process observations after preparation', async t => {
  const { root, item, prepared } = await fixture(t);
  const eventsPath = join(prepared.dataDir, 'experiments', prepared.experimentId, 'events.jsonl');
  const original = await readFile(eventsPath);
  const sequence = parseCommittedEventLog(original.toString('utf8')).events.length + 1;
  for (const event of [
    { type: 'runtime.tool_finished', payload: { item: { type: 'commandExecution', command: 'invented check', aggregated_output: 'New process evidence' } } },
    { type: 'agent.tool_completed', payload: { role: 'controller', tool: 'new-check', result: 'New process evidence' } },
    { type: 'artifact.created', payload: { artifactId: 'new-candidate-evidence' } },
  ]) {
    const body = { schemaVersion: 1, sequence, eventId: `injected-${sequence}`, occurredAt: new Date().toISOString(), runId: 'fixture-run', ...event };
    await appendFile(eventsPath, `${JSON.stringify({ ...body, checksum: sha256(JSON.stringify(body)) })}\n`);
    assert.equal(parseCommittedEventLog(await readFile(eventsPath, 'utf8')).diagnostic, undefined);
    await assert.rejects(verifyComparisonEvaluationInputs(root, item, prepared.inputIdentityHash), /Non-Comparison event appended/);
    await writeFile(eventsPath, original);
  }
});
