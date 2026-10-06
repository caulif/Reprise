import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { AgentHost, type AgentAuditEvent } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { ComparisonResourceTracker } from '../../src/agents/comparison-resources.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function response(content: AssistantMessage['content'], stopReason: 'toolUse' | 'stop' = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

for (const mode of ['schema', 'duplicate_schema', 'unknown', 'audit_failure'] as const) test(`native SDK pre-execution ${mode} rejection is counted without argument disclosure`, async () => {
  const events: AgentAuditEvent[] = [], resources = new ComparisonResourceTracker({});
  let executions = 0, generations = 0;
  const messages = [
    response([{ type: 'toolCall', id: 'private-rejected-call-id', name: mode === 'unknown' ? 'private-unknown-tool-name' : 'save',
      arguments: { value: { authorization: 'private-received-argument' } } }]),
    response([{ type: 'toolCall', id: 'good-call', name: 'save', arguments: { value: 'corrected' } }]),
    response([{ type: 'text', text: 'Done' }], 'stop'),
  ];
  if (mode === 'duplicate_schema') messages[0]!.content.push({ type: 'toolCall', id: 'private-rejected-call-id', name: 'save', arguments: { value: { second: 'invalid-object' } } });
  const models = { getModel: () => model, streamSimple: () => {
    generations++;
    const message = messages.shift(); assert.ok(message, 'rejection correction is bounded by this fixture');
    const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); return stream;
  } } as unknown as PiModels;
  const caller = new PiModelCaller({ schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' }, models);
  const session = await new AgentHost(caller).createSession({ role: 'comparison', systemPrompt: 'Correct malformed tool arguments using actual feedback.',
    tools: [{ name: 'save', description: 'Save a value', parameters: Type.Object({ value: Type.String() }), execute: async () => {
      executions++; return { content: 'Saved corrected value' };
    } }], audit: { append: async event => {
      events.push(event); resources.observe(event);
      if (mode === 'audit_failure' && event.type === 'agent.tool_failed' && event.payload.nativeHook === 'sdk_rejected') throw new Error('Actual rejection audit persistence failed');
    } },
  });
  const result = await session.work({ promptContent: 'Save the recorded value.', timeoutMs: 1_000 });
  const rejected = events.filter(event => event.payload.nativeHook === 'sdk_rejected');
  assert.deepEqual(rejected.map(event => event.type), mode === 'duplicate_schema'
    ? ['agent.tool_called', 'agent.tool_failed', 'agent.tool_called', 'agent.tool_failed'] : ['agent.tool_called', 'agent.tool_failed']);
  assert.equal(rejected[0]!.payload.toolCallId, rejected[1]!.payload.toolCallId);
  if (mode === 'duplicate_schema') assert.notEqual(rejected[0]!.payload.toolCallId, rejected[2]!.payload.toolCallId, 'repeated SDK IDs cannot hide a second rejected attempt');
  assert.equal(rejected[0]!.payload.tool, mode === 'unknown' ? 'unregistered_tool' : 'save');
  assert.equal(rejected[1]!.payload.code, 'sdk_pre_execution_rejected');
  assert.doesNotMatch(JSON.stringify(rejected), /private-|Received arguments|authorization/);
  if (mode === 'audit_failure') {
    assert.equal(result.status, 'failed'); assert.equal(executions, 0); assert.equal(generations, 1);
    assert.equal(resources.snapshot().toolCalls, 1, 'the failed audit cannot silently drop the actual rejected attempt');
  } else {
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(executions, 1); assert.equal(generations, 3);
    assert.equal(resources.snapshot().toolCalls, mode === 'duplicate_schema' ? 3 : 2, 'SDK rejections and one Host execution are counted exactly once');
    assert.equal(events.filter(event => event.type === 'agent.tool_called' && event.payload.nativeHook === 'before').length, 1);
    assert.equal(events.filter(event => event.type === 'agent.tool_completed' && !event.payload.nativeHook).length, 1);
  }
});
