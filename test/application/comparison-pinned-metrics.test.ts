import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { experimentAgentAuditSink, experimentModelInputResolver } from '../../src/application/experiment-helpers.js';
import { reconstructModelRequests } from '../../src/infrastructure/agent/model-input.js';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test',
  reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function response(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason,
    timestamp: Date.now(), usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test('fresh Comparison source session retains Host metrics after actual Pi compaction and replays them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-pinned-metrics-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const store = await ExperimentStore.open(root, 'experiment');
  await store.acquireWriter();
  t.after(() => store.close());
  const seen: Context[] = [];
  let summaries = 0;
  let reads = 0;
  const responses = [response('stop', [{ type: 'text', text: 'Investigated.' }]),
    response('stop', [{ type: 'text', text: 'Author finished.' }]),
    ...Array.from({ length: 16 }, (_, index) => {
      const item = response('toolUse', [{ type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { index } }]);
      if (index === 15) { item.usage.input = 110_000; item.usage.totalTokens = 110_010; }
      return item;
    }), response('stop', [{ type: 'text', text: 'Source review ended.' }]),
    response('stop', [{ type: 'text', text: 'Audit ended.' }])];
  const models = {
    getModel: () => model,
    streamSimple: (_model: unknown, context: Context) => {
      seen.push(JSON.parse(JSON.stringify(context)) as Context);
      const message = responses.shift();
      assert.ok(message, 'No unexpected Provider request');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      return stream;
    },
    completeSimple: () => { summaries++; return response('stop', [{ type: 'text', text: 'COMPACTED_SOURCES_WITHOUT_METRICS' }]); },
  } as unknown as PiModels;
  const comparison = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0,
    host: new AgentHost(new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' },
      providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models)) });
  const context: ComparisonContext = {
    task: { caseId: 'case', summary: 'Compare the actual output.' }, attemptId: 'attempt',
    baseline: { summary: 'Historical output.', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [],
    allowModelText: true, replayScope: { historical: 'baseline', candidate: 'candidate' },
    reportFacts: {
      run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
      models: { candidate: 'candidate-model' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
      delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
      replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' },
      metrics: {
        baseline: { elapsedMs: 90000, tokens: { total: 7000 }, costUsd: 0.2, usageStatus: 'collected',
          pricingStatus: 'collected', pricingSource: 'fixture-snapshot', pricingVersion: 'v1' },
        candidate: { elapsedMs: 40000, tokens: { total: 5000 }, usageStatus: 'collected', pricingStatus: 'pricing_unavailable' },
      },
    },
  };
  const result = await comparison.compare(context, [{ name: 'read', description: 'Inspect source.',
    parameters: Type.Object({ index: Type.Integer() }), execute: async params => {
      reads++; return { content: `evidence-${(params as { index: number }).index}: ${'x'.repeat(10000)}` };
    } }], experimentAgentAuditSink(store, 'run'), undefined, {
    getFindingsState: () => 'AUTHOR_FINDINGS_MUST_NOT_ENTER_FRESH_SOURCE', hasAcceptedDraft: () => true,
    getSubmittedResult: async () => seen.length >= 20 ? { status: 'completed', reportPath: 'report.html', evidenceRefs: [] } : undefined,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(reads, 16);
  assert.equal(summaries, 1);
  const sessions = store.events().filter(event => event.type === 'agent.session_started');
  assert.equal(sessions.length, 2);
  const reviewPrompt = (sessions[1]!.payload as { systemPrompt: string }).systemPrompt;
  assert.match(reviewPrompt, /"baseline":\{"elapsedMs":90000,"totalTokens":7000,"costUsd":0.2/);
  assert.match(reviewPrompt, /"candidate":\{"elapsedMs":40000,"totalTokens":5000,"costUsd":"unknown"/);
  assert.match(reviewPrompt, /"pricingStatus":"pricing_unavailable"/);
  assert.doesNotMatch(reviewPrompt, /AUTHOR_FINDINGS_MUST_NOT_ENTER_FRESH_SOURCE/);
  assert.doesNotMatch(JSON.stringify(seen[2]), /AUTHOR_FINDINGS_MUST_NOT_ENTER_FRESH_SOURCE/);
  for (const sent of seen.slice(-2)) {
    assert.equal(sent.systemPrompt, reviewPrompt);
    assert.match(JSON.stringify(sent.messages), /COMPACTED_SOURCES_WITHOUT_METRICS/);
    assert.doesNotMatch(JSON.stringify(sent.messages), /evidence-0:/);
  }
  assert.equal(store.events().filter(event => event.type === 'agent.context_compacted').length, 1);
  const replay = await reconstructModelRequests(store.events(), experimentModelInputResolver(store, 'run'));
  assert.equal(replay.diagnostic, undefined);
  assert.equal(replay.requests.at(-1)?.systemPrompt, reviewPrompt);
  assert.equal(replay.requests.at(-1)?.contextSource, 'generation_snapshot');
  assert.match(JSON.stringify(replay.requests.at(-1)?.messages), /COMPACTED_SOURCES_WITHOUT_METRICS/);
});
