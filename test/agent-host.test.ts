import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonAgent } from '../src/agents/comparison-agent.js';
import { ControllerAgent, type SteeringContext } from '../src/agents/controller-agent.js';
import { RecoveryAgent } from '../src/agents/recovery-agent.js';
import { PiAgentHost, type PiTextCaller } from '../src/infrastructure/pi-agent-host.js';

function controllerContext(allowModelText = true): SteeringContext {
  return {
    runId: 'run-1',
    runState: 'awaiting_controller',
    task: {
      initialInput: { id: 'message-1', role: 'user', text: 'Implement it.' },
      transcript: [{ id: 'message-1', role: 'user', text: 'Implement it.' }],
      baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] },
      privacy: { allowModelText, allowBinary: false, redactions: [] },
    },
    current: { summary: 'Target is waiting.', evidenceRefs: ['event:current-1'] },
    trajectory: { summary: 'No prior turns.', evidenceRefs: ['artifact:trace-1'] },
    priorDecisions: [],
    budget: { targetTurnsUsed: 1, targetTurnsLimit: 3 },
    permissions: { requiresRealUserDecision: false },
  };
}

test('PiAgentHost accepts valid structured output and repairs malformed output once', async () => {
  const calls: Array<{ repair?: string; capabilities: readonly string[] }> = [];
  const responses = ['not-json', JSON.stringify({ type: 'send', message: 'Please verify the result.', intent: 'verify', evidenceRefs: ['event:current-1'] })];
  const caller: PiTextCaller = {
    complete: async (input) => {
      calls.push(input);
      return responses.shift() ?? '';
    },
  };
  const controller = new ControllerAgent({ host: new PiAgentHost(caller), timeoutMs: 20, maxRepairAttempts: 1 });
  const result = await controller.decide(controllerContext());
  assert.deepEqual(result, { value: { type: 'send', message: 'Please verify the result.', intent: 'verify', evidenceRefs: ['event:current-1'] }, usedFallback: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.repair?.startsWith('Return only JSON'), true);
  assert.deepEqual(calls[0]?.capabilities, ['read_observation']);
});

test('PiAgentHost uses a deterministic fallback for invalid, timed-out, and privacy-blocked calls', async () => {
  let invalidCalls = 0;
  const invalid = new ControllerAgent({
    host: new PiAgentHost({ complete: async () => { invalidCalls += 1; return JSON.stringify({ type: 'send', message: 'x', intent: 'continue', evidenceRefs: ['event:foreign-1'] }); } }),
    timeoutMs: 20,
    maxRepairAttempts: 1,
  });
  const invalidResult = await invalid.decide(controllerContext());
  assert.equal(invalidResult.usedFallback, true);
  assert.deepEqual(invalidResult.diagnostic, { code: 'invalid_output', attempts: 2 });
  assert.equal(invalidCalls, 2);

  const timedOut = new ControllerAgent({
    host: new PiAgentHost({ complete: async () => new Promise<string>(() => {}) }),
    timeoutMs: 1,
    maxRepairAttempts: 0,
  });
  assert.deepEqual((await timedOut.decide(controllerContext())).diagnostic, { code: 'agent_timeout', attempts: 1 });

  let privacyCalls = 0;
  const blocked = new ControllerAgent({
    host: new PiAgentHost({ complete: async () => { privacyCalls += 1; return '{}'; } }),
    timeoutMs: 20,
    maxRepairAttempts: 0,
  });
  const blockedResult = await blocked.decide(controllerContext(false));
  assert.deepEqual(blockedResult.diagnostic, { code: 'privacy_blocked', attempts: 0 });
  assert.equal(privacyCalls, 0);
});

test('Controller enforces CandidateRun timing before the host is called', async () => {
  let calls = 0;
  const controller = new ControllerAgent({
    host: new PiAgentHost({ complete: async () => { calls += 1; return '{}'; } }),
    timeoutMs: 20,
    maxRepairAttempts: 0,
  });
  await assert.rejects(controller.decide({ ...controllerContext(), runState: 'awaiting_target' }), /awaits controller/);
  assert.equal(calls, 0);
});

test('Comparison and Recovery receive only their declared capability and fallback safely', async () => {
  const capabilities: Array<readonly string[]> = [];
  const host = new PiAgentHost({ complete: async (input) => { capabilities.push(input.capabilities); return 'not-json'; } });
  const comparison = new ComparisonAgent({ host, timeoutMs: 20, maxRepairAttempts: 0 });
  const comparisonResult = await comparison.compare({
    task: { caseId: 'case-1', summary: 'Task' },
    baseline: { summary: 'Baseline', evidenceRefs: ['event:baseline-1'] },
    candidates: [{ runId: 'run-1', summary: 'Candidate', evidenceRefs: ['artifact:run-1'] }],
    telemetry: [],
    fidelity: [],
    artifactRefs: [],
    allowModelText: true,
  });
  assert.equal(comparisonResult.usedFallback, true);

  const recovery = new RecoveryAgent({ host, timeoutMs: 20, maxRepairAttempts: 0 });
  const recoveryResult = await recovery.recover({
    stagingId: 'staging-1',
    clues: [{ summary: 'Workspace clue', evidenceRef: 'event:baseline-1' }],
    playbook: { version: 'fixture', content: 'Read only staging.' },
    availableEvidenceRefs: ['event:baseline-1'],
    allowModelText: true,
  });
  assert.deepEqual(recoveryResult.value, { status: 'unavailable', proposedSteps: [], evidenceRefs: [] });
  assert.deepEqual(capabilities, [['read_artifact'], ['write_staging']]);
});
