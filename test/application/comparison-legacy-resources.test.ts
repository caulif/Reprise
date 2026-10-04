import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';

const context: ComparisonContext = {
  task: { caseId: 'case-legacy', summary: 'Compare' }, attemptId: 'legacy-1', baseline: { summary: 'baseline', evidenceRefs: [] },
  candidates: [], telemetry: [], artifactRefs: [], allowModelText: true, replayScope: { historical: 'baseline', candidate: 'candidate' },
  reportFacts: { run: { runId: 'run-1', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } },
};

test('legacy compose tools remain usable after the investigation soft budget', async () => {
  let calls = 0;
  let writes = 0;
  const agent = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, resources: { investigationModelRequests: 1 },
    host: new AgentHost({ createSession: input => ({
      append: async ({ signal }) => {
        calls++;
        await input.onModelRequest?.({ model: 'fixture', digest: 'a'.repeat(64), messageCount: 1, images: [] });
        if (calls === 2) assert.match((await input.tools.find(tool => tool.name === 'read')!.execute({}, signal)).content, /investigation_limit/);
        if (calls === 3) assert.equal((await input.tools.find(tool => tool.name === 'write')!.execute({}, signal)).content, 'written');
        return JSON.stringify({ status: 'completed', reportPath: 'report.html', evidenceRefs: [] });
      }, cancel() {},
    }) }),
  });
  const tools = [{ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => ({ content: 'read' }) },
    { name: 'write', description: 'write', parameters: Type.Object({}), execute: async () => { writes++; return { content: 'written' }; } }];
  assert.equal((await agent.compare(context, tools)).status, 'completed');
  assert.equal(writes, 1);
});

test('legacy calls inherit the attempt hard timeout even when the per-call timeout is disabled', async () => {
  let requests = 0;
  const agent = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, resources: { maxElapsedMs: 25 },
    host: new AgentHost({ createSession: () => ({ append: async () => { requests++; return new Promise<string>(() => {}); }, cancel() {} }) }),
  });
  const result = await agent.compare({ ...context, attemptId: 'legacy-timeout' });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.failure.code, 'agent_timeout');
  assert.equal(requests, 1);
});
