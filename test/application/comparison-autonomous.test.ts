import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { AutonomousComparisonAgent } from '../../src/agents/comparison-autonomous.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import type { ComparisonContext, ComparisonResult } from '../../src/agents/comparison-agent.js';

const context: ComparisonContext = {
  attemptId: 'attempt', task: { caseId: 'case', summary: 'Compare text deliveries.' },
  baseline: { summary: 'Baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [],
  allowModelText: true, replayScope: { historical: '', candidate: '' },
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
    delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } },
};
const report: ComparisonResult = { status: 'completed', reportPath: 'report.html', evidenceRefs: [] };

test('autonomous Comparison uses one prompt and leaves all tools available without findings or stage callbacks', async () => {
  let sessions = 0;
  let calls = 0;
  const used: string[] = [];
  const events: AgentAuditEvent[] = [];
  const names = ['read', 'shell_exec', 'write', 'submit_report', 'preview_report'];
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession(input) {
    sessions++;
    assert.match(input.systemPrompt, /no mandatory findings snapshots/);
    return { append: async ({ content, signal }) => {
      calls++;
      assert.match(content, /Compare text deliveries/);
      for (const name of names) {
        const tool = input.tools.find(item => item.name === name)!;
        assert.equal((await tool.execute({}, signal)).content, name);
      }
      return '';
    }, cancel() {} };
  } }) });
  const result = await agent.compare(context, names.map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => { used.push(name); return { content: name }; } })), { append: async event => { events.push(event); } }, undefined,
  { getSubmittedResult: async () => report, onReviewStarted: () => { assert.fail('No separate reviewer'); },
    hasSavedFindings: () => { assert.fail('No mandatory findings'); }, enforcePhaseBoundaries: true });
  assert.equal(result.status, 'completed');
  assert.equal(sessions, 1);
  assert.equal(calls, 1);
  assert.deepEqual(used, names);
  assert.equal(events.at(-1)?.type, 'comparison.resources_completed');
  await agent.release('attempt');
});

test('autonomous Comparison refuses missing publication and propagates cancellation and provider failure', async () => {
  const agent = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({ append: async () => 'Done', cancel() {} }) }) });
  assert.equal((await agent.compare(context)).status, 'failed');
  await agent.release('attempt');
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await agent.compare(context, [], undefined, cancelled.signal)).status, 'cancelled');
  await agent.cancel('attempt');
  await agent.release('attempt');
  const failed = new AutonomousComparisonAgent({ timeoutMs: 0, host: new AgentHost({ createSession: () => ({
    append: async () => { throw new Error('Provider unavailable'); }, cancel() {} }) }) });
  assert.equal((await failed.compare(context)).status, 'failed');
  await failed.release('attempt');
});
