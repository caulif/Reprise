import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { sha256 } from '../../src/core/identity.js';

const context: ComparisonContext = { task: { caseId: 'case', summary: 'Compare' }, attemptId: 'attempt', baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'original', candidate: 'original' }, reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' }, models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' }, delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' }, replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
const resultValue = { status: 'completed' as const, reportPath: 'report.html' as const, headline: 'Scoped result', evidenceRefs: [] };

test('soft yield closes findings, carries incomplete source scope and waits for genuine generation-bound final readiness', async () => {
  const events: AgentAuditEvent[] = []; const prompts: string[] = [];
  let findings = false, preview = false, inspected = false, inspectionInGeneration = false, reads = 0;
  let reviewTurns = 0;
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, signal, yieldAfterTurn }) => {
    prompts.push(content);
    if (inspected && preview) inspectionInGeneration = true;
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: prompts.length, images: [] });
    if (content.includes('bounded closure turn')) await input.tools.find(tool => tool.name === 'update_comparison_findings')!.execute({}, signal);
    else if (content.includes('independent source pass') && !content.includes('Now inspect')) await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
    else if (content.includes('Now inspect') || content.includes('Continue the current review turn')) {
      reviewTurns++;
      if (reviewTurns === 1) {
        await input.tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        await input.tools.find(tool => tool.name === 'preview_report')!.execute({}, signal);
      }
    } else if (!findings) await input.tools.find(tool => tool.name === 'read')!.execute({}, signal);
    await input.onModelUsage?.({ model: 'fixture', scope: 'generation', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
    const reason = await yieldAfterTurn?.();
    return reason ? { status: 'yielded' as const, reason } : 'done';
  }, cancel() {} }) });
  const tools = [
    { name: 'read', execute: async () => { reads++; return { content: 'Actual source observations' }; } },
    { name: 'update_comparison_findings', execute: async () => { findings = true; return { content: 'status=accepted' }; } },
    { name: 'inspect_comparison_draft', execute: async () => { inspected = true; return { content: 'Full actual inspection body' }; } },
    { name: 'preview_report', execute: async () => { preview = true; return { content: 'Validated preview' }; } },
  ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { investigationModelRequests: 1, maxModelRequests: 40 } });
  const result = await agent.compare(context, tools, { append: async event => { events.push(event); } }, undefined, {
    findingsReady: () => findings, getFindingsState: () => findings ? 'saved scoped findings' : 'missing findings',
    getSubmittedResult: async () => preview && inspectionInGeneration ? resultValue : undefined,
  });
  assert.equal(result.status, 'completed');
  assert.equal(reviewTurns, 2);
  assert.equal(inspectionInGeneration, true);
  assert.equal(reads, 0, 'soft model boundary denies more investigation before side effects');
  assert.match(prompts.find(prompt => prompt.includes('Now inspect'))!, /pass is incomplete[\s\S]*Unchecked guarantees remain unknown/);
  const phases = events.filter(event => event.type === 'comparison.phase_completed');
  assert.equal(phases.find(event => event.payload.phase === 'investigate')!.payload.outcome, 'yielded');
  assert.equal(phases.find(event => event.payload.pass === 'findings')!.payload.yieldReason, 'findings_turn_boundary');
  assert.equal(phases.find(event => event.payload.pass === 'sources')!.payload.outcome, 'yielded');
  assert.equal(phases.at(-1)!.payload.yieldReason, 'report_ready');
  assert.equal(events.filter(event => event.type === 'agent.invocation_yielded').length, 5);
  assert.equal(events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 6);
});

test('hard model exhaustion is failed, never a source yield or publishable result', async () => {
  const events: AgentAuditEvent[] = [];
  const host = new AgentHost({ createSession: input => ({ append: async ({ content, yieldAfterTurn }) => {
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(content), messageCount: 1, images: [] });
    const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : 'done';
  }, cancel() {} }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: { maxModelRequests: 2 } });
  const result = await agent.compare(context, [], { append: async event => { events.push(event); } }, undefined, { getSubmittedResult: async () => resultValue });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.match(result.failure.message, /maxModelRequests/);
  assert.equal(events.find(event => event.type === 'comparison.resources_completed')!.payload.modelRequests, 2);
});

test('cancellation during final asynchronous result validation cannot return completed', async () => {
  const controller = new AbortController();
  let turns = 0;
  const host = new AgentHost({ createSession: () => ({ append: async () => { turns++; return 'done'; }, cancel() {} }) });
  const agent = new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0 });
  const result = await agent.compare(context, [], undefined, controller.signal, { getSubmittedResult: async () => {
    controller.abort();
    return resultValue;
  } });
  assert.equal(turns, 4);
  assert.equal(result.status, 'cancelled');
});
