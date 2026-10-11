import test from 'node:test';
import assert from 'node:assert/strict';
import { eventEnvelopeChecksum } from '../../src/core/identity.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { autonomousComparisonBinding, autonomousComparisonRequested } from '../../src/application/comparison-autonomous-binding.js';

function event(sequence: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  const body = { schemaVersion: 1 as const, sequence, eventId: `event-${sequence}`, occurredAt: '2026-10-11T00:00:00.000Z', type,
    payload: { attemptId: 'attempt', sessionId: 'session', ...payload } };
  return { ...body, checksum: eventEnvelopeChecksum(body) };
}
const receipt = { status: 'ok', draftDigest: 'a'.repeat(64), revision: 1, previewDigest: 'b'.repeat(64) };
function fixture() {
  const events = [
    event(1, 'comparison.requested', { autonomousContractVersion: 1 }),
    event(2, 'agent.session_started', { role: 'comparison', systemPrompt: 'Compare', tools: [] }),
    event(3, 'agent.tool_completed', { tool: 'submit_report', details: { schemaVersion: 1, status: 'accepted', draftDigest: receipt.draftDigest,
      catalogRevision: 1, bindingRevision: 1, decisionShape: 'unknown' } }),
    event(4, 'agent.tool_completed', { tool: 'preview_report', details: receipt }),
    event(5, 'agent.model_request', { scope: 'generation', invocationId: 'invocation', requestIndex: 1, model: 'fixture', digest: 'c'.repeat(64), images: [],
      generationInput: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ systemPrompt: 'Compare', tools: [], messages: [
        { role: 'toolResult', toolName: 'preview_report', toolCallId: 'preview', content: [{ type: 'text', text: JSON.stringify(receipt) }] },
      ] }) } }),
    event(6, 'agent.invocation_completed', {}),
  ];
  return { events, attemptId: 'attempt', draftDigest: receipt.draftDigest, catalogRevision: 1,
    store: { experimentId: 'experiment', readArtifact: async () => new Uint8Array() } };
}

test('autonomous contract is explicit, versioned and cannot downgrade an independent review contract', () => {
  const f = fixture();
  assert.equal(autonomousComparisonRequested(f.events, 'attempt'), true);
  assert.equal(autonomousComparisonRequested([], 'attempt'), false);
  assert.throws(() => autonomousComparisonRequested([event(1, 'comparison.requested', { autonomousContractVersion: 2 })], 'attempt'), /Invalid/);
  assert.throws(() => autonomousComparisonRequested([event(1, 'comparison.requested', { autonomousContractVersion: 1, reviewInspectionContractVersion: 2 })], 'attempt'), /Conflicting/);
});

test('binding requires actual same-session preview input, current accepted version and normal completion', async () => {
  assert.equal(await autonomousComparisonBinding(fixture()), undefined);
  for (const index of [2, 3, 4, 5]) {
    const f = fixture();
    f.events.splice(index, 1);
    assert.ok(await autonomousComparisonBinding(f), `Missing event ${index} must reject`);
  }
  for (const replacement of [
    event(4, 'agent.tool_completed', { tool: 'preview_report', details: { ...receipt, revision: 2 } }),
    event(4, 'agent.tool_completed', { tool: 'preview_report', sessionId: 'other', details: receipt }),
    event(4, 'agent.tool_completed', { tool: 'preview_report', nativeHook: 'after', details: receipt }),
    event(6, 'agent.invocation_cancelled', {}),
  ]) {
    const f = fixture();
    f.events[replacement.sequence - 1] = replacement;
    assert.ok(await autonomousComparisonBinding(f));
  }
  for (const text of ['summary', JSON.stringify({ ...receipt, previewDigest: 'd'.repeat(64) })]) {
    const f = fixture();
    f.events[4] = event(5, 'agent.model_request', { scope: 'generation', invocationId: 'invocation', requestIndex: 1, model: 'fixture', digest: 'c'.repeat(64), images: [],
      generationInput: { schemaVersion: 1, encoding: 'inline', text: JSON.stringify({ systemPrompt: 'Compare', tools: [], messages: [
        { role: 'toolResult', toolName: 'preview_report', toolCallId: 'preview', content: [{ type: 'text', text }] },
      ] }) } });
    assert.ok(await autonomousComparisonBinding(f));
  }
  const changed = fixture();
  assert.ok(await autonomousComparisonBinding({ ...changed, draftDigest: 'd'.repeat(64) }));
  assert.ok(await autonomousComparisonBinding({ ...changed, catalogRevision: 2 }));
});
