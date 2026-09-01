import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { compactPiMessages, needsPiCompaction } from '../src/infrastructure/pi-compaction.js';
import { PiAgentHost, type AgentAuditEvent } from '../src/infrastructure/pi-agent-host.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Models } from '@earendil-works/pi-ai';

const tinyWindowModel = { contextWindow: 1_000 } as Model<Api>;

test('needsPiCompaction is false for a short transcript', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 },
  ];
  assert.equal(needsPiCompaction(messages, 128_000), false);
});

test('needsPiCompaction follows Pi shouldCompact against provider usage', () => {
  const messages: AgentMessage[] = [{
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'test',
    model: 'm',
    usage: { input: 120_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 120_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1,
  }];
  assert.equal(needsPiCompaction(messages, tinyWindowModel.contextWindow), true);
});

test('compactPiMessages uses Pi completeSimple to replace history with a summary plus tail', async () => {
  const chunk = 'x'.repeat(2_000);
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 80; index += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: chunk }], timestamp: index + 1 });
  }
  const models = {
    completeSimple: async () => ({
      role: 'assistant',
      content: [{ type: 'text', text: '## Goal\nKeep going.' }],
      api: 'openai-completions',
      provider: 'test',
      model: 'm',
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop',
      timestamp: 4,
    }),
  } as unknown as Pick<Models, 'completeSimple'>;
  const model = { id: 'm', name: 'm', api: 'openai-completions', provider: 'test', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 } as Model<Api>;
  const compacted = await compactPiMessages({ messages, models, model, thinkingLevel: 'low' });
  assert.ok(compacted);
  assert.equal(compacted.messages[0]?.role, 'compactionSummary');
  assert.match(compacted.audit.summary, /Keep going/);
  assert.ok(compacted.audit.retainedCount >= 1);
});

test('Host records agent.context_compacted from the Pi session compact hook', async () => {
  const events: AgentAuditEvent[] = [];
  let compact: ((payload: { summary: string; tokensBefore: number; retainedCount: number }) => Promise<void>) | undefined;
  const host = new PiAgentHost({
    createSession: (input) => {
      compact = input.onContextCompact;
      return {
        append: async () => JSON.stringify({ ok: true }),
        cancel() {},
      };
    },
  });
  const result = await host.request({
    role: 'recovery',
    systemPrompt: 'fixed prompt',
    context: {},
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
    allowModelText: true,
    audit: {
      append: async (event) => {
        events.push(event);
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(typeof compact, 'function');
  await compact!({ summary: '## Goal\nDone', tokensBefore: 12_000, retainedCount: 3 });
  assert.ok(events.some((event) => event.type === 'agent.context_compacted'));
});
