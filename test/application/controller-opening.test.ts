import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, controllerMessageHasHostTerms, type SteeringContext } from '../../src/agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../../src/infrastructure/agent/host.js';

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

function caller(responses: string[]): PiTextCaller {
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
    host: new PiAgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'done', reason: 'satisfied' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const rejected = await done.decide(opening);
  assert.equal(rejected.status, 'failed');
  if (rejected.status === 'failed') assert.match(rejected.failure.message, /opening decision must be send/);
  const send = new ControllerAgent({
    host: new PiAgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'send', message: 'Work in this directory.', intent: 'continue' })])),
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

test('Controller send.message rejects Host terms and keeps ordinary user language', async () => {
  const leaks = [
    'Set briefingRoot first.',
    'The SteeringContext is wrong.',
    'CandidateRun is waiting.',
    'Open controller-briefing next.',
    'Read current-user-view.md',
    'Check THIS-TURN.txt',
    'Ask AgentHost.',
    'This TaskCase is done.',
    'Set allowModelText please.',
    'Use evidenceCatalog.',
    'Follow outputContract.',
    'Stay in data-host-zone.',
    'Leave data-agent-zone.',
    'See recovery-work.',
    'Please read INDEX.md',
  ];
  for (const message of leaks) {
    assert.equal(controllerMessageHasHostTerms(message), true, message);
  }
  const ordinary = [
    'please continue',
    'look at README.md',
    'run the tests',
    'the host will review this tomorrow',
    'dump the json',
    'the index of sections is incomplete',
    'please look at src/app.ts',
  ];
  for (const message of ordinary) {
    assert.equal(controllerMessageHasHostTerms(message), false, message);
  }
  const leaked = new ControllerAgent({
    host: new PiAgentHost(caller(['understood the historical user demand.', JSON.stringify({ type: 'send', message: 'Read current-user-view.md', intent: 'continue' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const rejected = await leaked.decide(context());
  assert.equal(rejected.status, 'failed');
  if (rejected.status === 'failed') assert.match(rejected.failure.message, /message contains a Host term/);
});
