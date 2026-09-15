import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessAgents } from '../../src/application/harness-agents.js';
import { defaultHarnessModelConfig } from '../../src/infrastructure/harness-model-config.js';
import { LANGUAGE_BLOCK } from '../../src/agents/language.js';

test('Harness agent factory shares one Pi session caller and persisted model choice', async () => {
  let calls = 0;
  const agents = createHarnessAgents(defaultHarnessModelConfig(), { createSession: () => ({ append: async () => { calls += 1; return '{"type":"done","reason":"satisfied"}'; }, cancel() {} }) });
  const decision = await agents.controller.decide({ requestId: 'controller-request-run-1-1', runId: 'run-1', runState: 'awaiting_controller', task: { initialInput: { id: 'input-1', role: 'user', text: 'Fix it.' }, baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] }, privacy: { allowModelText: true, allowBinary: false, redactions: [] } }, current: { summary: 'Settled.', evidenceRefs: [] }, trajectory: { summary: 'One turn.', evidenceRefs: [] }, evidenceCatalog: [], budget: { decisionsUsed: 1, decisionsLimit: 2 }, promptContent: 'phase=steering\n' });
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

test('factory does not give Controller or Comparison the candidate callTimeoutMs', () => {
  const budget = { callTimeoutMs: 20, maxStructuredRepairAttempts: 1 };
  const agents = createHarnessAgents(defaultHarnessModelConfig(), {
    createSession: () => ({ append: async () => '{"type":"done","reason":"satisfied"}', cancel() {} }),
  }, { budget });
  assert.equal(agents.comparison.timeoutMs, 0);
  assert.equal(agents.controller.timeoutMs, 0);
  assert.equal(agents.config.budget.callTimeoutMs, 20);
});

test('factory recovery budget still bounds Recovery', () => {
  const budget = { callTimeoutMs: 20, maxStructuredRepairAttempts: 1 };
  const recoveryBudget = { callTimeoutMs: 40, maxStructuredRepairAttempts: 0 };
  const agents = createHarnessAgents(defaultHarnessModelConfig(), {
    createSession: () => ({ append: async () => '{"type":"done","reason":"satisfied"}', cancel() {} }),
  }, { budget, recoveryBudget });
  assert.deepEqual(agents.config.budget, budget);
  assert.deepEqual(agents.config.recoveryBudget, recoveryBudget);
  assert.equal(agents.recovery.timeoutMs, recoveryBudget.callTimeoutMs);
});

test('locale en system prompt contains English; locale zh contains Simplified Chinese', async () => {
  const prompts: string[] = [];
  const caller = {
    createSession: (input: { systemPrompt: string }) => {
      prompts.push(input.systemPrompt);
      return { append: async () => '{"type":"done","reason":"satisfied"}', cancel() {} };
    },
  };
  const english = createHarnessAgents(defaultHarnessModelConfig(), caller, {}, { locale: 'en' });
  await english.controller.decide({
    requestId: 'controller-request-run-en-1',
    runId: 'run-en',
    runState: 'awaiting_controller',
    task: {
      initialInput: { id: 'input-1', role: 'user', text: 'Fix it.' },
      baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: 'Settled.', evidenceRefs: [] },
    trajectory: { summary: 'One turn.', evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 1, decisionsLimit: 2 },
    promptContent: 'phase=steering\n',
  });
  const chinese = createHarnessAgents(defaultHarnessModelConfig(), caller, {}, { locale: 'zh' });
  await chinese.controller.decide({
    requestId: 'controller-request-run-zh-1',
    runId: 'run-zh',
    runState: 'awaiting_controller',
    task: {
      initialInput: { id: 'input-1', role: 'user', text: 'Fix it.' },
      baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: 'Settled.', evidenceRefs: [] },
    trajectory: { summary: 'One turn.', evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 1, decisionsLimit: 2 },
    promptContent: 'phase=steering\n',
  });
  assert.match(prompts[0] ?? '', /English/);
  assert.equal((prompts[0] ?? '').includes(LANGUAGE_BLOCK('en', 'controller')), true);
  assert.doesNotMatch(prompts[0] ?? '', /Simplified Chinese/);
  assert.match(prompts[1] ?? '', /Simplified Chinese/);
  assert.equal((prompts[1] ?? '').includes(LANGUAGE_BLOCK('zh', 'controller')), true);
});

