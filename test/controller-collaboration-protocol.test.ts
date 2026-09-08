import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, CONTROLLER_PROMPT_DIGEST, CONTROLLER_SYSTEM_PROMPT } from '../src/agents/controller-agent.js';
import { PiAgentHost } from '../src/infrastructure/pi-agent-host.js';
import { controllerPromptContent, controllerRequestSnapshot, renderIndexMarkdown } from '../src/application/controller-briefing.js';
import { sha256 } from '../src/core/identity.js';
import type { SteeringContext } from '../src/agents/controller-agent.js';

function steering(runId: string): SteeringContext {
  return {
    requestId: `controller-request-${runId}-2`,
    runId,
    runState: 'awaiting_controller',
    phase: 'steering',
    task: {
      initialInput: { id: 'message-1', role: 'user', text: 'Implement it.' },
      baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText: true, allowBinary: false, redactions: [] },
      historicalUserTurns: [],
    },
    current: { summary: 'Candidate turn has settled.', evidenceRefs: [] },
    trajectory: { summary: 'Settled turns: 1.', evidenceRefs: [] },
    evidenceCatalog: [],
    budget: { decisionsUsed: 1 },
    promptContent: controllerPromptContent({
      phase: 'steering',
      briefingRoot: '/briefing',
      indexMarkdown: renderIndexMarkdown('run/turns/0001'),
    }),
  };
}

test('Controller request snapshot records the live prompt digest', () => {
  assert.equal(CONTROLLER_PROMPT_DIGEST, sha256(CONTROLLER_SYSTEM_PROMPT));
  const snapshot = controllerRequestSnapshot(steering('run-1'));
  assert.equal(snapshot.promptDigest, CONTROLLER_PROMPT_DIGEST);
  assert.match(String(snapshot.promptContent), /Exhausting historical user sentences is not done\/satisfied/);
  assert.match(String(snapshot.promptContent), /current candidate facts/);
});

test('distinct CandidateRun ids do not share a Controller Session', async () => {
  let sessions = 0;
  const host = new PiAgentHost({
    createSession() {
      sessions += 1;
      return {
        append: async () => JSON.stringify({ type: 'done', reason: 'satisfied' }),
        cancel() {},
      };
    },
  });
  const controller = new ControllerAgent({ host, timeoutMs: 50, maxRepairAttempts: 0 });
  await controller.decide(steering('run-a'));
  await controller.decide(steering('run-b'));
  assert.equal(sessions, 2);
});
