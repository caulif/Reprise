import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import { comparisonToolFeedback, comparisonSoftLimitFeedback } from '../../src/agents/comparison-tool-feedback.js';
import { toPiTool } from '../../src/infrastructure/agent/providers/pi/tool-adapter.js';
import { Type } from '@sinclair/typebox';
import { prunePiMessagesForBudget } from '../../src/infrastructure/agent/compaction.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

test('progress feedback preserves JSON outcomes and binary delivery metadata without approving semantics', () => {
  const tracker = new ComparisonResourceTracker({ maxModelRequests: 40 });
  tracker.phase('review');
  tracker.observe({ type: 'agent.model_request', sessionId: 'review', role: 'comparison', payload: {} });
  const result = { content: JSON.stringify({ status: 'ok', renderedCheck: { status: 'motion_not_proven' } }), details: { images: ['delivered-hash'] } };
  const updated = comparisonToolFeedback(result, tracker, '{"accepted":{"digest":"new"},"previewed":{"digest":"old"}}');
  const payload = JSON.parse(updated.content) as { status: string; renderedCheck: unknown; hostProgress: { remainingRequests: number; submissionState: string; meaning: string } };
  assert.equal(payload.status, 'ok');
  assert.deepEqual(payload.renderedCheck, { status: 'motion_not_proven' });
  assert.equal(updated.details, result.details);
  assert.equal(payload.hostProgress.remainingRequests, 39);
  assert.match(payload.hostProgress.submissionState, /new.*old/);
  assert.match(payload.hostProgress.meaning, /not semantic approval/);
});

test('oversized rejection feedback cannot stub a bounded full inspection after final wrapping', () => {
  const content = JSON.stringify({ status: 'available', headline: 'Decision', comparisonHtml: '<p>Main</p>', detailsHtml: 'x'.repeat(11_000) });
  for (const state of ['unknown reference '.repeat(20_000), '问题😀\\"\u0000'.repeat(20_000)]) {
    const updated = comparisonToolFeedback({ content, contentBlocks: [{ type: 'text', text: content }] }, new ComparisonResourceTracker({}), state);
    const payload = JSON.parse(updated.content) as { detailsHtml: string; hostProgress: { submissionState: string; submissionStateTruncated: boolean } };
    assert.equal(payload.detailsHtml, 'x'.repeat(11_000));
    assert.equal(payload.hostProgress.submissionStateTruncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(updated.contentBlocks)) < 16_384);
    const messages: AgentMessage[] = [{ role: 'toolResult', toolCallId: 'inspection', toolName: 'inspect_comparison_draft',
      content: [{ type: 'text', text: updated.content }], isError: false, timestamp: 0 }];
    assert.equal(prunePiMessagesForBudget(messages).changed, false);
  }
});

test('native-image tools deliver progress through the actual Pi content blocks without changing images', async () => {
  const tracker = new ComparisonResourceTracker({ maxModelRequests: 40 });
  const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' };
  const original = { content: '{"status":"ok"}', contentBlocks: [{ type: 'text' as const, text: '{"status":"ok"}' }, image] };
  const updated = comparisonToolFeedback(original, tracker);
  const pi = toPiTool({ name: 'render_artifact', description: 'render', parameters: Type.Object({}), execute: async () => updated });
  const delivered = await pi.execute('call', {}, new AbortController().signal);
  const text = delivered.content[0];
  assert.equal(text?.type, 'text');
  if (text?.type !== 'text') throw new Error('Missing delivered text');
  assert.equal(text.text, updated.content);
  assert.match(text.text, /"remainingRequests":40/);
  assert.equal(delivered.content[1], image);
  const separate = comparisonToolFeedback({ content: 'status=ok', contentBlocks: [image] }, tracker);
  assert.equal(separate.contentBlocks?.[0], image);
  assert.match(separate.contentBlocks?.[1]?.type === 'text' ? separate.contentBlocks[1].text : '', /Host progress feedback/);
});

test('denied review investigation keeps explicit unresolved closure and real remaining budget', () => {
  const tracker = new ComparisonResourceTracker({ investigationModelRequests: 1, maxModelRequests: 40 });
  tracker.phase('review');
  tracker.observe({ type: 'agent.model_request', sessionId: 'review', role: 'comparison', payload: {} });
  const reason = tracker.beforeTool('read');
  assert.equal(reason, 'reviewModelRequests');
  const result = comparisonToolFeedback(comparisonSoftLimitFeedback(reason, 'review'), tracker);
  assert.match(result.content, /status=review_investigation_limit/);
  assert.match(result.content, /unresolved question explicitly/);
  assert.match(result.content, /"remainingRequests":39/);
  assert.equal(tracker.beforeTool('submit_comparison_draft'), undefined);
  assert.equal(tracker.beforeTool('preview_report'), undefined);
  assert.match(comparisonSoftLimitFeedback('investigationMs', 'investigate').content, /return to compose/);
});

test('read coverage reaches actual Pi content from whitelisted metadata without private details', async () => {
  const tracker = new ComparisonResourceTracker({ maxModelRequests: 40 });
  const original = { content: '[{"sequence":1}]', details: { available: true, truncated: false, offset: 0, path: 'C:/private/source/host-trace.json', error: 'private diagnostic' } };
  const updated = comparisonToolFeedback(original, tracker, undefined, 'read');
  const pi = toPiTool({ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => updated });
  const delivered = await pi.execute('read-call', {}, new AbortController().signal);
  const text = delivered.content.find(block => block.type === 'text');
  assert.ok(text && text.type === 'text');
  assert.match(text.text, /"readCoverage":\{"available":true,"truncated":false,"offset":0\}/);
  assert.doesNotMatch(text.text, /private|host-trace\.json/);
  assert.ok(text.text.startsWith(original.content));
  assert.equal(updated.details, original.details);
  const ranged = comparisonToolFeedback({ content: 'part', details: { available: true, truncated: true, offset: 10, nextCursor: 20 } }, tracker, undefined, 'read');
  assert.match(ranged.content, /"readCoverage":\{"available":true,"truncated":true,"offset":10,"nextCursor":20\}/);
  const other = comparisonToolFeedback(original, tracker, undefined, 'shell_exec');
  assert.doesNotMatch(other.content, /readCoverage/);
});

test('read coverage does not fabricate missing fields and is delivered alongside native image blocks', async () => {
  const tracker = new ComparisonResourceTracker({ maxModelRequests: 40 });
  const absent = comparisonToolFeedback({ content: 'body', details: { path: 'C:/private', truncated: 'false', available: 1, offset: -1, nextCursor: Number.NaN, totalBytes: Number.POSITIVE_INFINITY } }, tracker, undefined, 'read');
  assert.match(absent.content, /"readCoverage":\{\}/);
  assert.doesNotMatch(absent.content, /"truncated":false|C:\/private/);
  const image = { type: 'image' as const, data: 'AA==', mimeType: 'image/png' };
  const original = { content: 'Image file', contentBlocks: [image], details: { available: true, truncated: false, offset: 0, byteLength: 20, returnedBytes: 20, totalBytes: 20, path: 'C:/private/image.png' } };
  const updated = comparisonToolFeedback(original, tracker, undefined, 'read');
  const pi = toPiTool({ name: 'read', description: 'read', parameters: Type.Object({}), execute: async () => updated });
  const delivered = await pi.execute('image-call', {}, new AbortController().signal);
  assert.equal(delivered.content[0], image);
  const text = delivered.content[1];
  assert.ok(text?.type === 'text');
  assert.match(text.text, /"readCoverage":\{"available":true,"truncated":false,"offset":0,"byteLength":20,"returnedBytes":20,"totalBytes":20\}/);
  assert.doesNotMatch(text.text, /private|image\.png/);
});
