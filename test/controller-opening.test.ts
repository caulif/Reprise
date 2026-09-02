import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, type SteeringContext } from '../src/agents/controller-agent.js';
import { PiAgentHost, type PiTextCaller } from '../src/infrastructure/pi-agent-host.js';

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
      historicalUserTurns: [],
    },
    current: { summary: 'Candidate turn has not started.', evidenceRefs: [] },
    trajectory: { summary: 'Settled turns: 0.', evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 0, decisionsLimit: 3 },
  };
}

function caller(responses: string[]): PiTextCaller {
  return {
    createSession() {
      return {
        append: async () => responses.shift() ?? '',
        cancel() {},
      };
    },
  };
}

test('Controller opening rejects done and requires created', async () => {
  const opening = context();
  const done = new ControllerAgent({
    host: new PiAgentHost(caller([JSON.stringify({ type: 'done', reason: 'satisfied' })])),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const rejected = await done.decide(opening);
  assert.equal(rejected.status, 'failed');
  if (rejected.status === 'failed') assert.match(rejected.failure.message, /opening decision must be send/);
  const send = new ControllerAgent({
    host: new PiAgentHost(caller([JSON.stringify({ type: 'send', message: 'Work in this directory.', intent: 'continue' })])),
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
