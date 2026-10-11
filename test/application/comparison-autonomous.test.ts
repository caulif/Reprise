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
      assert.match(content, /Total remaining session budget: \d+ ms/);
      assert.ok(content.indexOf('Task: Compare text deliveries.') < content.indexOf('Deliverable:'));
      assert.ok(content.indexOf('Deliverable:') < content.indexOf('Optional Host metrics'));
      for (const name of names) {
        const tool = input.tools.find(item => item.name === name)!;
        const result = await tool.execute({}, signal);
        assert.equal(result.content, name);
        assert.match(JSON.stringify(result.contentBlocks), /Host total-time budget remaining: \d+ ms/);
      }
      return '';
    }, cancel() {} };
  } }) });
  const result = await agent.compare(context, names.map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => { used.push(name); return { content: name }; } })), { append: async event => { events.push(event); } }, undefined,
  { getSubmittedResult: async () => report, onReviewStarted: () => { assert.fail('No separate reviewer'); },
    hasSavedFindings: () => { assert.fail('No mandatory findings'); }, enforcePhaseBoundaries: true });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(sessions, 1);
  assert.equal(calls, 1);
  assert.deepEqual(used, names);
  assert.equal(events.at(-1)?.type, 'comparison.resources_completed');
  assert.ok(events.some(event => event.type === 'agent.tool_completed' && JSON.stringify(event.payload.body).includes('Host total-time budget remaining')));
  await agent.release('attempt');
});

test('autonomous budget feedback respects a shorter invocation timeout and preserves structured tool results', async () => {
  const agent = new AutonomousComparisonAgent({ timeoutMs: 5000, host: new AgentHost({ createSession(input) {
    return { append: async ({ content, signal }) => {
      const initial = Number(/Total remaining session budget: (\d+) ms/.exec(content)?.[1]);
      assert.ok(initial > 0 && initial <= 5000);
      const result = await input.tools[0]!.execute({}, signal);
      assert.equal(result.content, '{"status":"ok"}');
      assert.deepEqual(result.contentBlocks?.[0], { type: 'text', text: '{"status":"ok"}' });
      const remaining = Number(/remaining: (\d+) ms/.exec(JSON.stringify(result.contentBlocks))?.[1]);
      assert.ok(remaining > 0 && remaining <= initial);
      return '';
    }, cancel() {} };
  } }) });
  assert.equal((await agent.compare(context, [{ name: 'read', description: 'read', parameters: Type.Object({}),
    execute: async () => ({ content: '{"status":"ok"}', contentBlocks: [{ type: 'text', text: '{"status":"ok"}' }] }) }],
  undefined, undefined, { getSubmittedResult: async () => report })).status, 'completed');
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
