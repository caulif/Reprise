import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonStages } from '../../src/agents/comparison-stages.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';
import type { ComparisonCompareOptions } from '../../src/agents/comparison-agent.js';
import type { ComparisonWorkPass } from '../../src/agents/comparison-invocation-boundaries.js';
import type { AgentToolDefinition } from '../../src/infrastructure/agent/host.js';

const sources = ['read', 'ls', 'grep', 'shell_exec', 'render_artifact', 'register_evidence', 'quote_evidence'];
const updates = ['update_comparison_findings', 'update_comparison_findings_delta'];
const names = [...sources, ...updates, 'write', 'edit', 'submit_comparison_draft', 'inspect_comparison_draft', 'preview_report', 'extension'];
const options: ComparisonCompareOptions = { getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true, reviewFindings: true,
  getFindingsState: () => 'actual current binding', hasSavedFindings: () => true, findingsReady: () => true,
  hasReviewDraftMaterial: () => true, hasCurrentReviewInspection: () => true, isRepairRead: async () => true };

const stagesToTools: readonly [string, 'understand' | 'investigate' | 'compose' | 'review', ComparisonWorkPass | undefined, readonly string[]][] = [
  ['understand', 'understand', undefined, names.filter(name => !['shell_exec', 'render_artifact', 'register_evidence', 'submit_comparison_draft', 'preview_report'].includes(name))],
  ['investigate', 'investigate', undefined, names.filter(name => !['submit_comparison_draft', 'preview_report'].includes(name))],
  ['initial findings', 'investigate', 'initial-findings', [updates[0]!]],
  ['source checkpoint', 'investigate', 'source-save', [updates[1]!]],
  ['findings closure', 'investigate', 'findings', updates],
  ['decision author', 'compose', undefined, ['update_comparison_findings', 'submit_comparison_draft']],
  ['source review', 'review', 'sources', [...sources, ...updates]],
  ['source supplement', 'review', 'review-supplement', sources],
  ['review findings', 'review', 'review-findings', ['read', ...updates]],
  ['draft inspection', 'review', 'inspection', ['inspect_comparison_draft']],
  ['draft audit', 'review', 'audit', names.filter(name => name !== 'preview_report')],
  ['preview closure', 'review', 'preview', ['preview_report']],
  ['ordinary review', 'review', undefined, names],
];

for (const [label, phase, pass, expected] of stagesToTools) test(`${label}: one policy controls exposure, forced execution and completion callbacks`, async () => {
  const effects: string[] = [], callbacks: string[] = [];
  const tools: AgentToolDefinition[] = names.map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => { effects.push(name); return { content: 'status=accepted\nActual receipt' }; },
    onCompleted: async () => { callbacks.push(name); } }));
  const resources = new ComparisonResourceTracker({}), stages = new ComparisonStages(tools, resources, options);
  const bound = stages.bind(tools); resources.phase(phase, pass); stages.begin(phase, pass);
  assert.deepEqual(stages.toolNames(bound) ?? names, names.filter(name => expected.includes(name)));
  for (const tool of bound) {
    const result = await tool.execute({ path: 'INDEX.md' }, new AbortController().signal);
    await tool.onCompleted?.(result);
  }
  assert.deepEqual(effects, names.filter(name => expected.includes(name)));
  assert.deepEqual(callbacks, effects, 'denied tools cannot certify delivery through completion callbacks');
});

test('stage exits require actual observed accepted receipts and current state', async () => {
  let saved = false, ready = false, state = 'binding-1', accepted = false;
  const tools: AgentToolDefinition[] = updates.map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => ({ content: accepted ? 'status=accepted' : 'status=rejected' }) }));
  const resources = new ComparisonResourceTracker({});
  const stages = new ComparisonStages(tools, resources, { ...options, hasSavedFindings: () => saved, findingsReady: () => ready, getFindingsState: () => state });
  const bound = stages.bind(tools), signal = new AbortController().signal;
  stages.begin('investigate', 'initial-findings'); assert.equal(await stages.exit(), undefined);
  saved = true; await bound[0]!.execute({}, signal); assert.equal(await stages.exit(), undefined);
  accepted = true; await bound[0]!.execute({}, signal); assert.equal(await stages.exit(), 'initial_findings_saved');
  stages.begin('investigate', 'source-save'); await bound[1]!.execute({}, signal); assert.equal(await stages.exit(), 'findings_checkpoint_saved');
  state = 'binding-2'; assert.equal(await stages.exit(), undefined);
  stages.begin('review', 'sources'); assert.equal(await stages.exit(), undefined);
  await bound[1]!.execute({}, signal); assert.equal(await stages.exit(), 'independent_findings_pending');
  ready = true; assert.equal(await stages.exit(), 'independent_findings_ready');
  stages.begin('review', 'review-findings'); assert.equal(await stages.exit(), undefined);
  await bound[1]!.execute({}, signal); assert.equal(await stages.exit(), 'review_findings_ready');
});

test('parameter-dependent repair and preview guards also suppress completion callbacks', async () => {
  let effects = 0, callbacks = 0;
  const tools: AgentToolDefinition[] = ['read', 'preview_report'].map(name => ({ name, description: name, parameters: Type.Object({}),
    execute: async () => { effects++; return { content: 'ok' }; }, onCompleted: async () => { callbacks++; } }));
  const stages = new ComparisonStages(tools, new ComparisonResourceTracker({}), { ...options, isRepairRead: async () => false, hasCurrentReviewInspection: () => false });
  const bound = stages.bind(tools);
  for (const [index, pass] of [[0, 'review-findings'], [1, 'preview']] as const) {
    stages.begin('review', pass);
    const result = await bound[index]!.execute({}, new AbortController().signal); await bound[index]!.onCompleted?.(result);
  }
  assert.equal(effects, 0); assert.equal(callbacks, 0);
});
