import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryReviewBinding } from '../../src/application/comparison-recovery-review.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { sha256, eventEnvelopeChecksum } from '../../src/core/identity.js';

const content = { headline: 'Choice', comparisonHtml: '<p>Main</p>', detailsHtml: '<details>Limit</details>' };
const store = { experimentId: 'experiment', readArtifact: async () => new Uint8Array() };
const digest = 'a'.repeat(64);
function event(sequence: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  const body = { schemaVersion: 1 as const, sequence: sequence * 10, eventId: `event-${sequence}`, occurredAt: '2026-10-05T00:00:00.000Z', type, payload };
  return { ...body, checksum: eventEnvelopeChecksum(body) };
}
const start = event(3, 'comparison.review_started', { schemaVersion: 1, attemptId: 'attempt', sessionId: 'review', inspectionRequired: true });
const accepted = event(4, 'comparison.draft_accepted', { schemaVersion: 1, attemptId: 'attempt', draftDigest: digest, catalogRevision: 1, findingsRevision: 2 });
const receipt = { schemaVersion: 1, status: 'available', draftDigest: digest, catalogRevision: 1,
  bindingRevision: 1, findingsRevision: 2, decisionShape: 'single_difference', reviewInspectionRequired: true, semanticValidation: 'not_performed' };
const submission = event(2, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'compose', tool: 'submit_comparison_draft',
  details: { schemaVersion: 1, status: 'accepted', draftDigest: digest, catalogRevision: 1, bindingRevision: 1,
    findingsRevision: 2, decisionShape: 'single_difference' } });
function inspect(sequence: number, overrides: Record<string, unknown> = {}, sessionId = 'review') {
  return event(sequence, 'agent.tool_completed', { attemptId: 'attempt', sessionId, tool: 'inspect_comparison_draft', toolCallId: `inspect-${sequence}`, details: { ...receipt, ...overrides }, body: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ ...receipt, ...overrides, ...content }) } });
}
function generation(sequence = 100, messages: unknown[] = []) {
  return event(sequence, 'agent.model_request', { attemptId: 'attempt', sessionId: 'review', scope: 'generation',
    invocationId: 'review-invocation', requestIndex: 1, model: 'fixture', digest: 'c'.repeat(64), images: [],
    generationInput: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ systemPrompt: 'Review', tools: [], messages }) } });
}
function check(events: EventEnvelope[], overrides: Partial<Parameters<typeof recoveryReviewBinding>[0]> = {}, includeRequest = true) {
  const bootstrap = [
    { ...event(0.1, 'agent.session_started', { attemptId: 'attempt', sessionId: 'review', role: 'comparison', systemPrompt: 'Review', tools: [] }), runId: 'run' },
    event(0.2, 'agent.message_appended', { attemptId: 'attempt', sessionId: 'review', invocationId: 'review-invocation', requestIndex: 1,
      body: { schemaVersion: 1, encoding: 'inline', text: 'Check the draft.' } }),
  ];
  const compacted = events.filter(e => e.type === 'agent.context_compacted').at(-1);
  const latest = events.filter(e => e.type === 'agent.tool_completed' && (e.payload as Record<string, unknown>).tool === 'inspect_comparison_draft'
    && !('nativeHook' in (e.payload as Record<string, unknown>))).at(-1);
  const latestBody = (latest?.payload as { body?: { encoding: string; text?: string } } | undefined)?.body;
  const messages = compacted ? JSON.parse(((compacted.payload as Record<string, unknown>).retainedTail as { text: string }).text) as unknown[]
    : latest ? [{ role: 'toolResult', toolName: 'inspect_comparison_draft', toolCallId: 'native-inspection-id',
      content: [{ type: 'text', text: latestBody?.encoding === 'artifact' ? JSON.stringify({ ...receipt, ...content }) : latestBody?.text ?? '' }] }] : [];
  const all = [...bootstrap, submission, ...events, ...(includeRequest ? [generation(100, messages)] : [])].sort((a, b) => a.sequence - b.sequence);
  return recoveryReviewBinding({ store, content, events: all, attemptId: 'attempt', draftDigest: digest, catalogRevision: 1,
    previewSessionId: 'review', acceptedAfterSequence: 40, ...overrides,
    ...(overrides.acceptedAfterSequence === undefined ? {} : { acceptedAfterSequence: overrides.acceptedAfterSequence * 10 }) });
}

test('recovery keeps legacy compatibility but new review requires a current receipt from its own session', async () => {
  assert.equal(await check([]), undefined);
  assert.match((await check([start, accepted]))!, /No inspection/);
  assert.match((await check([inspect(2), start, accepted]))!, /No inspection/);
  assert.match((await check([start, accepted, inspect(5, {}, 'compose')]))!, /No inspection/);
  assert.match((await check([start, accepted, inspect(5)], { previewSessionId: 'compose' }))!, /latest independent review/);
  assert.equal(await check([start, accepted, inspect(5)]), undefined);
  assert.match((await check([start, accepted, inspect(5), event(6, 'comparison.draft_accepted', accepted.payload as Record<string, unknown>)],
    { acceptedAfterSequence: 6 }))!, /No inspection/);
});

test('recovery rejects altered digest, catalog, findings, fake semantic approval and malformed new contracts', async () => {
  for (const overrides of [{ draftDigest: 'b'.repeat(64) }, { catalogRevision: 2 }, { reviewInspectionRequired: false }]) {
    assert.match((await check([start, accepted, inspect(5, overrides)]))!, /not bound/);
  }
  assert.match((await check([start, accepted, inspect(5, { findingsRevision: 3 })]))!, /latest accepted draft declaration/);
  await assert.rejects(() => check([start, accepted, inspect(5, { semanticValidation: 'approved' })]), /Invalid Comparison draft inspection receipt/);
  await assert.rejects(() => check([event(3, start.type, { attemptId: 'attempt' })]), /Invalid Comparison review contract/);
  const native = event(6, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'review', tool: 'inspect_comparison_draft', nativeHook: 'after' });
  assert.equal(await check([start, accepted, inspect(5), native]), undefined);
  const unavailable = event(6, 'agent.tool_completed', { attemptId: 'attempt', sessionId: 'review', tool: 'inspect_comparison_draft' });
  assert.match((await check([start, accepted, inspect(5), unavailable]))!, /No inspection/);
});

test('new attempts cannot recover before review starts or after changing declaration at the same digest', async () => {
  const requested = event(1, 'comparison.requested', { attemptId: 'attempt', reviewInspectionContractVersion: 1 });
  assert.match((await check([requested, accepted, inspect(5)]))!, /never started/);
  const changed = event(6, submission.type, { ...(submission.payload as Record<string, unknown>),
    details: { ...(submission.payload as { details: Record<string, unknown> }).details, bindingRevision: 2, decisionShape: 'multiple_differences' } });
  assert.match((await check([requested, start, accepted, inspect(5), changed]))!, /latest accepted draft declaration/);
  const noop = event(6, submission.type, submission.payload as Record<string, unknown>);
  assert.equal(await check([requested, start, accepted, inspect(5), noop]), undefined);
});

test('inspection audit must include full matching content and receipt, not details alone', async () => {
  const good = inspect(5);
  const payload = good.payload as Record<string, unknown>;
  for (const body of [undefined, { schemaVersion: 1, encoding: 'inline', text: JSON.stringify(receipt) },
    { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ ...receipt, ...content, detailsHtml: '' }) },
    { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ ...receipt, ...content, bindingRevision: 2 }) }]) {
    assert.match((await check([start, accepted, event(5, good.type, { ...payload, body })]))!, /content|full accepted draft|binding receipt/);
  }
});

test('v2 recovery requires inspection after the current draft audit boundary', async () => {
  const requested = event(1, 'comparison.requested', { attemptId: 'attempt', reviewInspectionContractVersion: 2 });
  const audit = event(6, 'comparison.draft_audit_started', start.payload as Record<string, unknown>);
  assert.match((await check([requested, start, accepted, inspect(5)]))!, /draft audit never started/);
  assert.match((await check([requested, start, accepted, inspect(5), audit]))!, /No inspection/);
  assert.equal(await check([requested, start, accepted, inspect(5), audit, inspect(7)]), undefined);
  const wrongSession = event(6, audit.type, { ...(start.payload as Record<string, unknown>), sessionId: 'author' });
  assert.match((await check([requested, start, accepted, wrongSession, inspect(7)]))!, /latest independent review session/);
  await assert.rejects(() => check([requested, start, accepted, event(6, audit.type, { attemptId: 'attempt' }), inspect(7)]), /Invalid Comparison draft audit contract/);
  const restart = event(8, start.type, start.payload as Record<string, unknown>);
  assert.match((await check([requested, start, accepted, audit, inspect(7), restart]))!, /draft audit never started/);
  assert.equal(await check([requested, start, accepted, audit, inspect(7), restart, event(9, audit.type, start.payload as Record<string, unknown>), inspect(10)]), undefined);
});

test('artifact-backed inspection checks run ownership, hash and byte length before parsing complete content', async () => {
  const bytes = Buffer.from(JSON.stringify({ ...receipt, ...content }));
  const good = inspect(5);
  const artifact = { ...event(5, good.type, { ...(good.payload as Record<string, unknown>),
    body: { schemaVersion: 1, encoding: 'artifact', artifactId: 'body', contentHash: sha256(bytes), byteLength: bytes.byteLength } }), runId: 'run' };
  const reader = { experimentId: 'experiment', readArtifact: async (ref: Parameters<Parameters<typeof recoveryReviewBinding>[0]['store']['readArtifact']>[0]) => { assert.ok('runId' in ref); assert.equal(ref.runId, 'run'); return bytes; } };
  assert.equal(await check([start, accepted, artifact], { store: reader }), undefined);
  await assert.rejects(() => check([start, accepted, artifact], { store: { ...reader, readArtifact: async () => Buffer.from('altered') } }), /integrity/);
  const { runId: _runId, ...missingRun } = artifact;
  await assert.rejects(() => check([start, accepted, missingRun]), /run identity/);
});

test('a content audit followed by failure cannot certify delivery, while a later successful inspection can', async () => {
  const failed = event(6, 'agent.tool_failed', { attemptId: 'attempt', sessionId: 'review',
    tool: 'inspect_comparison_draft', toolCallId: 'inspect-5', message: 'cancelled after audit' });
  assert.match((await check([start, accepted, inspect(5), failed]))!, /failed after its content audit/);
  assert.equal(await check([start, accepted, inspect(5), failed, inspect(7)]), undefined);
  const other = event(6, failed.type, { ...(failed.payload as Record<string, unknown>), toolCallId: 'unrelated-call' });
  assert.equal(await check([start, accepted, inspect(5), other]), undefined);
  const missing = inspect(5);
  const { toolCallId: _toolCallId, ...payload } = missing.payload as Record<string, unknown>;
  assert.match((await check([start, accepted, event(5, missing.type, payload)]))!, /tool call identity/);
});

test('recovery requires the complete inspection in a later generation input, not a compaction summary', async () => {
  assert.match((await check([start, accepted, inspect(5)], {}, false))!, /No generation input/);
  assert.equal(await check([start, accepted, inspect(5)]), undefined);
  const compacted = event(6, 'agent.context_compacted', { attemptId: 'attempt', sessionId: 'review',
    invocationId: 'review-invocation', summary: JSON.stringify({ ...receipt, ...content }),
    retainedTail: { schemaVersion: 1, encoding: 'inline', text: '[]' } });
  assert.match((await check([start, accepted, inspect(5), compacted]))!, /No generation input/);
  const compactionOnly = event(6, 'agent.model_request', { attemptId: 'attempt', sessionId: 'review', scope: 'compaction',
    invocationId: 'review-invocation', requestIndex: 1, model: 'fixture', images: [] });
  assert.match((await check([start, accepted, inspect(5), compactionOnly], {}, false))!, /No generation input/);
  const retained = { role: 'toolResult', toolName: 'inspect_comparison_draft', toolCallId: 'pi-upstream-different-id',
    content: [{ type: 'text', text: JSON.stringify({ ...receipt, ...content }) }] };
  const fullTail = event(6, compacted.type, { ...(compacted.payload as Record<string, unknown>),
    retainedTail: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify([retained]) } });
  assert.equal(await check([start, accepted, inspect(5), fullTail]), undefined);
});

test('legacy projected inspection cannot certify actual generation delivery, and snapshot content takes precedence', async () => {
  const snapshot = generation(6, []);
  const { generationInput: _generationInput, ...legacy } = snapshot.payload as Record<string, unknown>;
  assert.match((await check([start, accepted, inspect(5), event(6, snapshot.type, legacy)], {}, false))!, /Legacy event projections.*cannot certify/);
  assert.match((await check([start, accepted, inspect(5), snapshot], {}, false))!, /No generation input snapshot/);
  const actual = [{ role: 'toolResult', toolName: 'inspect_comparison_draft', toolCallId: 'upstream-native-id',
    content: [{ type: 'text', text: JSON.stringify({ ...receipt, ...content }) }] }];
  assert.equal(await check([start, accepted, inspect(5), generation(6, actual)], {}, false), undefined);
  const summary = [{ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ ...receipt, ...content }) }] }];
  assert.match((await check([start, accepted, inspect(5), generation(6, summary)], {}, false))!, /No generation input snapshot/);
});
