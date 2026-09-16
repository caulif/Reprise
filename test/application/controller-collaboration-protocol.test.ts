import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerAgent, CONTROLLER_SYSTEM_PROMPT, composeControllerSystemPrompt, type SteeringContext } from '../../src/agents/controller-agent.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { controllerPromptContent, controllerRequestSnapshot, renderIndexMarkdown } from '../../src/application/controller-briefing.js';
import { promptDigest } from '../../src/infrastructure/agent/prompt-digest.js';

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

test('Controller request snapshot records hostFacts without judging requirements', () => {
  const snapshot = controllerRequestSnapshot({
    ...steering('run-1'),
    hostFacts: {
      changedPaths: ['a.ts'],
      requestId: 'controller-request-run-1-2',
      runId: 'run-1',
      phase: 'steering',
      recentToolErrors: [{ tool: 'read', message: 'not found' }],
      historicalRequirementRefs: [{ id: 'message-1', path: 'history/user-inputs/message-1.txt', status: 'unknown' }],
    },
  });
  assert.deepEqual(
    (snapshot.hostFacts as { recentToolErrors: unknown }).recentToolErrors,
    [{ tool: 'read', message: 'not found' }],
  );
  assert.equal(
    (snapshot.hostFacts as { historicalRequirementRefs: { status: string }[] }).historicalRequirementRefs[0]?.status,
    'unknown',
  );
});

test('Controller request snapshot records the live prompt digest', () => {
  const snapshot = controllerRequestSnapshot(steering('run-1'));
  assert.equal(snapshot.promptDigest, promptDigest(composeControllerSystemPrompt('zh')));
  assert.notEqual(snapshot.promptDigest, promptDigest(CONTROLLER_SYSTEM_PROMPT));
  assert.doesNotMatch(String(snapshot.promptContent), /# INDEX\.md/);
  assert.match(String(snapshot.promptContent), /Latest turn: run\/turns\/0001/);
  assert.match(String(snapshot.promptContent), /Read current-user-view\.md first/);
});

test('distinct CandidateRun ids do not share a Controller Session', async () => {
  let sessions = 0;
  const host = new AgentHost({
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
