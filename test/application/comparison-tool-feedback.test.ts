import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import { comparisonToolFeedback, comparisonSoftLimitFeedback } from '../../src/agents/comparison-tool-feedback.js';
import { toPiTool } from '../../src/infrastructure/agent/providers/pi/tool-adapter.js';
import { Type } from '@sinclair/typebox';

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
