import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { ComparisonCompositionTools, COMPARISON_COMPOSITION_BOUNDARY_PROMPT } from '../../src/agents/comparison-composition-tools.js';
import type { AgentToolDefinition } from '../../src/infrastructure/agent/host.js';

const strict = { getSubmittedResult: async () => undefined, enforcePhaseBoundaries: true };
const signal = () => new AbortController().signal;
function tool(name: string, effects: string[]): AgentToolDefinition {
  return { name, description: name, parameters: Type.Object({}), execute: async () => { effects.push(name); return { content: 'ok' }; },
    onCompleted: async () => { effects.push(`${name}:completed`); } };
}

test('strict composer advertises authoring tools and denies forced investigation effects and callbacks', async () => {
  const effects: string[] = [], names = ['read', 'quote_evidence', 'write', 'edit', 'submit_comparison_draft', 'update_comparison_findings',
    'shell_exec', 'render_artifact', 'register_evidence', 'inspect_comparison_draft', 'preview_report', 'unknown_extension'];
  const tools = names.map(name => tool(name, effects)), composition = new ComparisonCompositionTools(strict, () => 'compose');
  assert.deepEqual(composition.allowedToolNames(tools), names.slice(0, 6));
  // A caller that ignores allowedToolNames still cannot execute the omitted tools.
  for (const bound of composition.bind(tools).slice(6)) {
    const result = await bound.execute({ command: 'forced', path: 'report.html' }, signal());
    assert.match(result.content, /"code":"composition_only"/);
    await bound.onCompleted?.(result);
  }
  assert.deepEqual(effects, []);
});

test('composer preserves real full and delta corrections without an update quota', async () => {
  const params = [{ criteria: ['task'], findings: [], decisionQuestions: [] }, { kind: 'delta', binding: { revision: 1 }, findingDecisions: [], questionDecisions: [] }];
  const received: unknown[] = [], completed: unknown[] = [], abortSignal = signal(), receipt = { content: 'status=accepted\n{"readyToCompose":true}' };
  const update: AgentToolDefinition = { name: 'update_comparison_findings', description: 'update', parameters: Type.Object({}),
    execute: async (actual, actualSignal) => { assert.equal(actualSignal, abortSignal); received.push(actual); return receipt; },
    onCompleted: async result => { completed.push(result); } };
  const composition = new ComparisonCompositionTools(strict, () => 'compose'), bound = composition.bind([update])[0]!;
  for (const input of params) { const result = await bound.execute(input, abortSignal); assert.equal(result, receipt); await bound.onCompleted?.(result); }
  assert.equal(received[0], params[0]); assert.equal(received[1], params[1]); assert.deepEqual(completed, [receipt, receipt]);
});

test('composer forwards permitted source reading, quoting, report authoring and submission', async () => {
  const effects: string[] = [], tools = ['read', 'quote_evidence', 'write', 'edit', 'submit_comparison_draft'].map(name => tool(name, effects));
  const composition = new ComparisonCompositionTools(strict, () => 'compose');
  for (const bound of composition.bind(tools)) {
    const result = await bound.execute({}, signal()); assert.equal(result.content, 'ok'); await bound.onCompleted?.(result);
  }
  assert.deepEqual(effects, tools.flatMap(item => [item.name, `${item.name}:completed`]));
});

test('phase transition preserves investigation and fresh review capabilities', async () => {
  let phase: 'investigate' | 'compose' | 'review' = 'investigate';
  const effects: string[] = [], raw = tool('shell_exec', effects), composition = new ComparisonCompositionTools(strict, () => phase), bound = composition.bind([raw])[0]!;
  assert.equal(composition.allowedToolNames([raw]), undefined); assert.equal(composition.prompt(), '');
  await bound.execute({}, signal());
  phase = 'compose'; assert.deepEqual(composition.allowedToolNames([raw]), []); assert.equal(composition.prompt(), COMPARISON_COMPOSITION_BOUNDARY_PROMPT);
  await bound.execute({}, signal());
  phase = 'review'; assert.equal(composition.allowedToolNames([raw]), undefined); assert.equal(composition.prompt(), '');
  await bound.execute({}, signal());
  assert.deepEqual(effects, ['shell_exec', 'shell_exec']);
});

test('legacy callers with either strict option absent retain original tools and callbacks', async () => {
  for (const options of [undefined, { enforcePhaseBoundaries: true }, { getSubmittedResult: strict.getSubmittedResult }, { ...strict, enforcePhaseBoundaries: false }]) {
    const effects: string[] = [], raw = tool('register_evidence', effects), composition = new ComparisonCompositionTools(options, () => 'compose');
    const bound = composition.bind([raw])[0]!; assert.equal(bound, raw);
    assert.equal(composition.allowedToolNames([raw]), undefined); assert.equal(composition.prompt(), '');
    const result = await bound.execute({}, signal()); await bound.onCompleted?.(result); assert.deepEqual(effects, ['register_evidence', 'register_evidence:completed']);
  }
});

test('strict composer cancellation and permitted tool failures propagate without replacement findings', async () => {
  const effects: string[] = [], composition = new ComparisonCompositionTools(strict, () => 'compose'), controller = new AbortController();
  const bound = composition.bind([tool('read', effects), tool('render_artifact', effects)]); controller.abort(new Error('cancelled'));
  for (const item of bound) await assert.rejects(item.execute({}, controller.signal), /cancelled/);
  assert.deepEqual(effects, []);
  const failure = new Error('write failed');
  const broken: AgentToolDefinition = { ...tool('write', effects), execute: async () => { throw failure; } };
  await assert.rejects(composition.bind([broken])[0]!.execute({}, signal()), error => error === failure);
});
