import test from "node:test";
import assert from "node:assert/strict";
import { ComparisonAgent, COMPARISON_TURN_PROMPTS, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { AgentHost, type AgentAuditEvent } from "../../src/infrastructure/agent/host.js";
import { Type } from "@sinclair/typebox";

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId: "attempt-1",
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: { run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" }, models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" }, delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" }, replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" } },
  };
}

test('findings convergence rejects no progress and always records resource completion', async () => {
  const events: AgentAuditEvent[] = [];
  const prompts: string[] = [];
  const agent = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, host: new AgentHost({
    createSession: () => ({ append: async ({ content }) => { prompts.push(content); return 'done'; }, cancel() {} }),
  }) });
  const result = await agent.compare(context(), [], { append: async (event) => { events.push(event); } }, undefined, {
    getSubmittedResult: async () => undefined, findingsReady: () => false, getFindingsState: () => 'unchanged pending question',
  });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.failure.code, 'draft_invalid');
    assert.equal(result.failure.attempts, 2);
  }
  assert.equal(prompts.length, 3);
  assert.match(prompts[2]!, /previous closure call did not produce an actually accepted ready findings update/);
  assert.ok(prompts.every(prompt => !prompt.includes(COMPARISON_TURN_PROMPTS.compose)));
  assert.equal(events.filter(event => event.type === 'comparison.resources_completed').length, 1);
});

test('remaining elapsed budget cancels active investigation without composing', async () => {
  const events: AgentAuditEvent[] = [];
  let calls = 0;
  const agent = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, resources: { maxElapsedMs: 50 }, host: new AgentHost({
    createSession: () => ({ append: async () => { calls++; return new Promise<string>(() => {}); }, cancel() {} }),
  }) });
  const result = await agent.compare(context(), [], { append: async (event) => { events.push(event); } }, undefined, {
    getSubmittedResult: async () => undefined,
  });
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  assert.equal(events.filter(event => event.type === 'comparison.resources_completed').length, 1);
});

test('phase rejection gives a return instruction without executing premature publication tools', async () => {
  const observed: string[][] = [];
  let submitted = 0;
  let previewed = 0;
  const agent = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, host: new AgentHost({
    createSession: input => ({ append: async () => {
      const results: string[] = [];
      for (const name of ['update_comparison_findings', 'submit_comparison_draft', 'preview_report']) {
        results.push((await input.tools.find(tool => tool.name === name)!.execute({}, new AbortController().signal)).content);
      }
      observed.push(results);
      return observed.length === 4 ? JSON.stringify({ status: 'completed', evidenceRefs: [] }) : 'done';
    }, cancel() {} }),
  }) });
  const result = await agent.compare(context(), [
    { name: 'update_comparison_findings', description: 'findings', parameters: Type.Object({}), execute: async () => ({ content: 'status=accepted\n{"readyToCompose":true}' }) },
    { name: 'submit_comparison_draft', description: 'submit', parameters: Type.Object({}), execute: async () => { submitted++; return { content: 'status=accepted' }; } },
    { name: 'preview_report', description: 'preview', parameters: Type.Object({}), execute: async () => { previewed++; return { content: 'previewed' }; } },
  ], undefined, undefined, { enforcePhaseBoundaries: true });
  assert.equal(result.status, 'completed');
  assert.equal(submitted, 2);
  assert.equal(previewed, 1);
  assert.match(observed[1]![0]!, /readyToCompose=true.*finish this turn/);
  assert.match(observed[1]![1]!, /"currentPhase":"investigate".*"nextLegalPhase":"compose".*do not retry/);
  assert.match(observed[2]![2]!, /"currentPhase":"compose".*"nextLegalPhase":"review".*do not retry/);
});
