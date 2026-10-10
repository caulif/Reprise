import test from 'node:test';
import assert from 'node:assert/strict';
import { checkpointComparisonEvidence } from '../../src/agents/comparison-evidence-progress.js';
import type { AgentAuditEvent, AgentAuditSink } from '../../src/infrastructure/agent/host.js';

const receipt: AgentAuditEvent = { type: 'agent.tool_completed', sessionId: 'session', role: 'comparison', payload: {
  tool: 'render_artifact', toolCallId: 'invocation:tool:1', contentDigest: 'a'.repeat(64), byteLength: 100,
} };

test('host evidence progress references an actual receipt without model saving or semantic approval', async () => {
  const events: AgentAuditEvent[] = [], audit: AgentAuditSink = { append: async event => { events.push(event); } };
  await checkpointComparisonEvidence(audit, receipt, 'investigate');
  await checkpointComparisonEvidence(audit, receipt, 'review');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, 'comparison.evidence_checkpoint');
  assert.equal(events[0]!.payload.sourceToolCallId, receipt.payload.toolCallId);
  assert.equal(events[0]!.payload.semanticAssessment, 'not_certified');
  for (const phase of [undefined, 'compose', 'understand']) await checkpointComparisonEvidence(audit, receipt, phase);
  for (const event of [{ ...receipt, type: 'agent.tool_failed' as const }, { ...receipt, payload: { ...receipt.payload, nativeHook: 'after' } },
    { ...receipt, payload: { ...receipt.payload, tool: 'submit_comparison_draft' } }]) await checkpointComparisonEvidence(audit, event, 'review');
  await checkpointComparisonEvidence(undefined, receipt, 'review');
  assert.equal(events.length, 2);
});

test('malformed progress and persistence failure cannot silently pass', async () => {
  const audit: AgentAuditSink = { append: async () => { throw new Error('progress persistence failed'); } };
  await assert.rejects(checkpointComparisonEvidence(audit, receipt, 'review'), /progress persistence failed/);
  await assert.rejects(checkpointComparisonEvidence(audit, { ...receipt, payload: { ...receipt.payload, contentDigest: 'bad' } }, 'review'), /Invalid Comparison evidence/);
});
