import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completedReviewedComparison } from '../../src/application/comparison-live-review.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { eventEnvelopeChecksum, sha256 } from '../../src/core/identity.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import type { ComparisonContext, ComparisonResult } from '../../src/agents/comparison-agent.js';

const content = { headline: 'Choice', comparisonHtml: '<p>Main</p>', detailsHtml: '<p>Limit</p>' };
const html = `<p data-agent-slot="headline">Choice</p><section data-agent-zone="comparison">${content.comparisonHtml}</section><section data-agent-zone="details">${content.detailsHtml}</section>`;
const result: ComparisonResult = { status: 'completed', headline: 'Choice', evidenceRefs: [], reportPath: 'report.html' };
function event(sequence: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  const body = { schemaVersion: 1 as const, sequence, eventId: `event-${sequence}`, occurredAt: '2026-10-05T00:00:00.000Z', type, payload };
  return { ...body, checksum: eventEnvelopeChecksum(body) };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-live-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'report.html'), html);
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const revision = catalog.snapshot().revision;
  const receipt = { schemaVersion: 1, status: 'available', draftDigest: sha256(html), catalogRevision: revision,
    bindingRevision: 1, decisionShape: 'single_difference', reviewInspectionRequired: true, semanticValidation: 'not_performed' };
  const events = [
    event(1, 'agent.session_started', { attemptId: 'attempt', sessionId: 'review', role: 'comparison', systemPrompt: 'Review', tools: [] }),
    event(2, 'agent.message_appended', { attemptId: 'attempt', sessionId: 'review', invocationId: 'invocation', requestIndex: 1,
      body: { schemaVersion: 1, encoding: 'inline', text: 'Review actual draft.' } }),
    event(3, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'compose', tool: 'submit_comparison_draft',
      details: { schemaVersion: 1, status: 'accepted', draftDigest: sha256(html), catalogRevision: revision,
        bindingRevision: 1, decisionShape: 'single_difference' } }),
    event(4, 'comparison.review_started', { schemaVersion: 1, attemptId: 'attempt', sessionId: 'review', inspectionRequired: true }),
    event(5, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'review', tool: 'inspect_comparison_draft', toolCallId: 'inspect',
      details: receipt, body: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ ...receipt, ...content }) } }),
    event(6, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'review', tool: 'preview_report',
      details: { status: 'ok', draftDigest: sha256(html), revision } }),
  ];
  const context: ComparisonContext = { task: { caseId: 'case', summary: 'Compare' }, baseline: { summary: '', evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true, replayScope: { historical: '', candidate: '' }, attemptId: 'attempt',
    reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
      models: { candidate: 'fixture' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'test' },
      delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
      replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } } };
  const input = { draft: { completedResult: async () => result }, store: { experimentId: 'experiment', events: () => events,
    readArtifact: async () => new Uint8Array() }, attemptId: 'attempt', attemptRoot: root, context, catalog };
  return { input, events };
}
test('live completion rejects a ready tool batch until generation contains the complete inspected draft', async t => {
  const f = await fixture(t);
  assert.equal(await completedReviewedComparison(f.input), undefined);
  f.events.push(event(7, 'agent.model_request', { attemptId: 'attempt', sessionId: 'review', scope: 'generation',
    invocationId: 'invocation', requestIndex: 1, model: 'fixture', digest: 'c'.repeat(64), images: [] }));
  assert.deepEqual(await completedReviewedComparison(f.input), result);
  f.events.push(event(8, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'review', tool: 'inspect_comparison_draft', toolCallId: 'inspect-again',
    ...(f.events[4]!.payload as Record<string, unknown>) }));
  assert.equal(await completedReviewedComparison(f.input), undefined);
});
test('live completion rejects summarized inspection and a required review that never started', async t => {
  const f = await fixture(t);
  f.events.push(event(7, 'agent.context_compacted', { attemptId: 'attempt', sessionId: 'review', summary: 'Choice checked',
    retainedTail: { schemaVersion: 1, encoding: 'inline', text: '[]' } }));
  f.events.push(event(8, 'agent.model_request', { attemptId: 'attempt', sessionId: 'review', scope: 'generation',
    invocationId: 'invocation', requestIndex: 1, model: 'fixture', digest: 'c'.repeat(64), images: [] }));
  assert.equal(await completedReviewedComparison(f.input), undefined);
  f.events.splice(3, 1, event(4, 'comparison.requested', { attemptId: 'attempt', reviewInspectionContractVersion: 1 }));
  assert.equal(await completedReviewedComparison(f.input), undefined);
  f.events.splice(3, 1);
  assert.deepEqual(await completedReviewedComparison(f.input), result);
});
