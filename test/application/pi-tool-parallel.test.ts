import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import {
  convertToLlm,
} from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createPiAgent, toPiTool } from '../../src/infrastructure/agent/providers/pi/tool-adapter.js';

const model: Model<'openai-completions'> = {
  id: 'fixture',
  name: 'fixture',
  api: 'openai-completions',
  provider: 'fixture',
  baseUrl: 'https://example.test',
  reasoning: false,
  input: ['text'],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistant(stopReason: AssistantMessage['stopReason'], content: AssistantMessage['content'], errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function queuedStreams(messages: AssistantMessage[]) {
  return () => {
    const message = messages.shift();
    if (!message) throw new Error('Unexpected extra provider request.');
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else {
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
    }
    return stream;
  };
}


for (const parallel of [true, false]) test(`actual Pi batch ${parallel ? 'overlaps explicit reads' : 'orders mixed effects'}`, async () => {
  let active = 0, peak = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const names = ['first', 'second'];
  const tools = names.map((name, index) => toPiTool({ name, description: name, parameters: Type.Object({}),
    ...(parallel || index === 0 ? { executionMode: 'parallel' as const } : {}),
    execute: async () => {
      active++; peak = Math.max(peak, active);
      if (parallel) { if (active === 2) release(); await gate; }
      else { assert.equal(active, 1); await Promise.resolve(); }
      active--; return { content: name };
    },
  }));
  assert.equal(tools[1]!.executionMode, parallel ? 'parallel' : 'sequential');
  const agent = createPiAgent({ streamFn: queuedStreams([
    assistant('toolUse', names.map((name, index) => ({ type: 'toolCall', id: `call-${index}`, name, arguments: {} }))),
    assistant('stop', []),
  ]), convertToLlm, initialState: { model, tools, systemPrompt: 'test', thinkingLevel: 'off' } });
  await agent.prompt('test'); await agent.waitForIdle();
  assert.equal(peak, parallel ? 2 : 1);
  assert.equal(agent.state.messages.filter(message => message.role === 'toolResult').length, 2);
});

test('Pi cancellation after preparation cannot start the earlier prepared parallel tool', async () => {
  let effects = 0;
  const tool = toPiTool({ name: 'read', executionMode: 'parallel', description: 'read', parameters: Type.Object({}),
    execute: async () => { effects++; return { content: 'effect' }; } });
  let prepared = 0;
  const agent = createPiAgent({ streamFn: queuedStreams([assistant('toolUse', [
    { type: 'toolCall', id: 'one', name: 'read', arguments: {} }, { type: 'toolCall', id: 'two', name: 'read', arguments: {} },
  ])]), convertToLlm, beforeToolCall: async () => { if (++prepared === 2) agent.abort(); return undefined; },
  initialState: { model, tools: [tool], systemPrompt: 'test', thinkingLevel: 'off' } });
  await agent.prompt('test'); await agent.waitForIdle();
  assert.equal(effects, 0);
  const results = agent.state.messages.filter(message => message.role === 'toolResult');
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map(message => message.toolCallId)).size, 2);
});
