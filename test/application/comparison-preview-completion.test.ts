import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonAgent, type ComparisonContext } from '../../src/agents/comparison-agent.js';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';

const context: ComparisonContext = {
  task: { caseId: 'case', summary: 'Compare actual deliveries' }, attemptId: 'preview-completion',
  baseline: { summary: 'baseline', evidenceRefs: [] }, candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
  replayScope: { historical: 'original', candidate: 'original' },
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
    models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } },
};

for (const reason of ['bounded_preview_timeout', 'output_limit', 'report_ready'] as const) {
  test(`strict preview ${reason} preserves the actual invocation completion boundary`, async () => {
    let material = false, formal = false, previews = 0, sourceUpdates = 0, audits = 0;
    const events: AgentAuditEvent[] = [];
    const host = new AgentHost({ createSession: input => ({ append: async ({ content, allowedToolNames, signal, maxOutputTokens }) => {
      const execute = async (name: string) => input.tools.find(tool => tool.name === name)!.execute({}, signal);
      if (allowedToolNames?.length === 1 && allowedToolNames[0] === 'preview_report') {
        assert.equal(maxOutputTokens, 4_096);
        await execute('preview_report');
        return { status: 'yielded' as const, reason };
      }
      if (allowedToolNames?.length === 1 && allowedToolNames[0] === 'inspect_comparison_draft') {
        assert.equal(maxOutputTokens, 4_096);
        await execute('inspect_comparison_draft');
        return { status: 'yielded' as const, reason: 'review_draft_material_ready' };
      }
      if (content.includes('This is the independent source pass')) {
        await execute('read');
        await execute('update_comparison_findings');
        return { status: 'yielded' as const, reason: 'independent_findings_ready' };
      }
      if (allowedToolNames?.includes('inspect_comparison_draft')) {
        await execute('inspect_comparison_draft');
        return { status: 'yielded' as const, reason: 'final_inspection_ready' };
      }
      return 'Actual completed investigation or provisional author turn';
    }, cancel() {} }) });
    const tools = [
      { name: 'read', execute: async () => ({ content: 'Actual source material for the recorded task' }) },
      { name: 'update_comparison_findings', execute: async () => { sourceUpdates++; return { content: 'status=accepted\nActual unchanged findings binding' }; } },
      { name: 'submit_comparison_draft', execute: async () => ({ content: 'status=accepted\nActual provisional draft' }) },
      { name: 'inspect_comparison_draft', execute: async () => ({ content: 'Actual current complete draft' }),
        onCompleted: async () => { material = true; formal = true; } },
      { name: 'preview_report', execute: async () => { previews++; return { content: 'Actual matching current preview receipt' }; } },
    ].map(tool => ({ ...tool, description: tool.name, parameters: Type.Object({}) }));
    const result = await new ComparisonAgent({ host, timeoutMs: 1_000, maxRepairAttempts: 0, resources: {} }).compare(context, tools,
      { append: async event => { events.push(event); } }, undefined, {
        enforcePhaseBoundaries: true, reviewFindings: true, findingsReady: () => true,
        getFindingsState: () => 'Actual saved findings and current binding',
        hasReviewDraftMaterial: () => material, hasCurrentReviewInspection: () => formal,
        onDraftAuditStarted: () => { audits++; formal = false; },
        getSubmittedResult: async () => formal && previews > 0
          ? { status: 'completed', reportPath: 'report.html', evidenceRefs: [] } : undefined,
      });
    assert.equal(result.status, reason === 'report_ready' ? 'completed' : 'failed', JSON.stringify(result));
    if (result.status === 'failed' && reason === 'bounded_preview_timeout') {
      assert.equal(result.failure.code, 'agent_timeout');
      assert.equal(result.failure.kind, 'timeout');
      assert.equal(result.failure.retryable, false);
    }
    assert.equal(sourceUpdates, 1, 'a real current source save avoids duplicate findings closure');
    assert.equal(audits, 1, 'source acceptance still requires a new actual draft audit');
    assert.equal(previews, reason === 'output_limit' ? 2 : 1, 'output-limit continuation remains bounded within the preview pass');
    assert.equal(events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report').length, previews,
      'the failure occurs despite actual completed preview tool receipts');
    assert.equal(events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings').length, 0);
  });
}
