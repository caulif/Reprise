import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import { defaultHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';

test('Harness agent factory shares one Pi session caller and persisted model choice', async () => {
  let calls = 0;
  const agents = createHarnessAgents(defaultHarnessModelConfig(), { createSession: () => ({ append: async () => { calls += 1; return '{"type":"done","reason":"satisfied"}'; }, cancel() {} }) });
  const decision = await agents.controller.decide({ requestId: 'controller-request-run-1-1', runId: 'run-1', runState: 'awaiting_controller', task: { initialInput: { id: 'input-1', role: 'user', text: 'Fix it.' }, baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, historicalUserTurns: [] }, current: { summary: 'Settled.', evidenceRefs: [] }, trajectory: { summary: 'One turn.', evidenceRefs: [] }, evidenceCatalog: [], budget: { decisionsUsed: 1, decisionsLimit: 2 } });
  assert.equal(decision.status, 'completed');
  if (decision.status === 'completed') assert.equal(decision.value.type, 'done');
  assert.equal(calls, 1);
  assert.deepEqual(agents.config, {
    providerId: 'openai-codex',
    requestedModel: 'gpt-5.6-terra',
    budget: { callTimeoutMs: 24 * 60 * 60_000, maxStructuredRepairAttempts: 1 },
    recoveryBudget: { callTimeoutMs: 24 * 60 * 60_000, maxStructuredRepairAttempts: 1 },
  });
});
