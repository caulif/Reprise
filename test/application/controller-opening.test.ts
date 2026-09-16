import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, type SteeringContext } from '../../src/agents/controller-agent.js';
import { AgentHost, type ProviderAdapter } from '../../src/infrastructure/agent/host.js';

function context(): SteeringContext {
  return {
    requestId: 'controller-request-run-1-1',
    runId: 'run-1',
    runState: 'created',
    phase: 'opening',
    task: {
      initialInput: { id: 'message-1', role: 'user', text: 'Implement it.' },
      baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    },
    current: { summary: 'Candidate turn has not started.', evidenceRefs: [] },
    trajectory: { summary: 'Settled turns: 0.', evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 0, decisionsLimit: 3 },
    promptContent: 'phase=opening\n',
  };
}

function caller(responses: string[]): ProviderAdapter {
  return {
    createSession() {
      return {
        append: async () => {
          const next = responses.shift();
          if (next === undefined) throw new Error('unexpected extra append');
          return next;
        },
        cancel() {},
      };
    },
  };
}

test('Controller opening rejects done and requires created', async () => {
  const opening = context();
  const done = new ControllerAgent({
    host: new AgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'done', reason: 'satisfied' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const rejected = await done.decide(opening);
  assert.equal(rejected.status, 'failed');
  if (rejected.status === 'failed') assert.match(rejected.failure.message, /opening decision must be send/);
  const send = new ControllerAgent({
    host: new AgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'send', message: 'Work in this directory.', intent: 'continue' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const accepted = await send.decide(opening);
  assert.equal(accepted.status, 'completed');
  await assert.rejects(
    () => send.decide({ ...opening, runState: 'launching' }),
    /Opening Controller decision requires CandidateRun created/,
  );
});

test('Controller send.message no longer rejects Host-term wording', async () => {
  const leaked = new ControllerAgent({
    host: new AgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'send', message: 'Please read INDEX.md', intent: 'continue' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const accepted = await leaked.decide(context());
  assert.equal(accepted.status, 'completed');
  if (accepted.status === 'completed') assert.equal(accepted.value.type === 'send' ? accepted.value.message : '', 'Please read INDEX.md');
});

test('opening send that cites unseen candidate advice is no longer a runtime rejection', async () => {
  const leak = '按你建议的优先级来，先做第 1 和第 2 项。';
  const leaked = new ControllerAgent({
    host: new AgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'send', message: leak, intent: 'continue' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const accepted = await leaked.decide(context());
  assert.equal(accepted.status, 'completed');
  if (accepted.status === 'completed' && accepted.value.type === 'send') assert.equal(accepted.value.message, leak);
});
