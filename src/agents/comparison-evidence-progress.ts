import { Value } from '@sinclair/typebox/value';
import { ComparisonEvidenceProgressSchema } from '../core/schema.js';
import type { AgentAuditEvent, AgentAuditSink } from '../infrastructure/agent/host.js';
import { COMPARISON_SOURCE_TOOLS } from './comparison-stage-policy.js';

/** References committed receipts; never synthesizes findings or claims an interrupted phase can resume. */
export async function checkpointComparisonEvidence(audit: AgentAuditSink | undefined, event: AgentAuditEvent, phase: string | undefined): Promise<void> {
  if (!audit || (phase !== 'investigate' && phase !== 'review') || event.type !== 'agent.tool_completed'
    || !COMPARISON_SOURCE_TOOLS.has(String(event.payload.tool)) || event.payload.nativeHook) return;
  const payload = { schemaVersion: 1, phase, sourceToolCallId: event.payload.toolCallId, tool: event.payload.tool,
    contentDigest: event.payload.contentDigest, byteLength: event.payload.byteLength, semanticAssessment: 'not_certified' };
  if (!Value.Check(ComparisonEvidenceProgressSchema, payload)) throw new Error('Invalid Comparison evidence checkpoint receipt.');
  await audit.append({ type: 'comparison.evidence_checkpoint', sessionId: event.sessionId, role: 'comparison', payload });
}
