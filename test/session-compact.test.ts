import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@sinclair/typebox';
import { compactPiMessages, needsPiCompaction, prunePiMessagesForBudget, shrinkWorkingSetMessage, stripThinkMarkup } from '../src/infrastructure/agent/compaction.js';
import { PiAgentHost, type AgentAuditEvent } from '../src/infrastructure/agent/host.js';
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

test('compactPiMessages forwards phase-specific summary instructions', async () => {
  const seen: string[] = [];
  const models = {
    completeSimple: async (_model: unknown, context: { messages: Array<{ content: string | Array<{ type: string; text?: string }> }> }) => {
      seen.push(JSON.stringify(context));
      return {
        role: 'assistant', content: [{ type: 'text', text: 'keep the cited evidence and unresolved questions' }],
        api: 'openai-completions', provider: 'test', model: 'm',
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 4,
      };
    },
  } as never;
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: 'user' as const, content: `message ${index} ${'x'.repeat(4000)}`, timestamp: index + 1 }));
  const model = { id: 'm', name: 'm', api: 'openai-completions', provider: 'test', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 } as Model<Api>;
  await compactPiMessages({ messages, models, model, thinkingLevel: 'low', customInstructions: 'Preserve evidence refs for the report phase.' });
  assert.match(seen.join('\n'), /Preserve evidence refs for the report phase/);
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

test('summary failure is explicit and cancellation keeps its abort identity', async () => {
  const messages: AgentMessage[] = Array.from({ length: 80 }, (_, index) => ({ role: 'user', content: 'x'.repeat(2000), timestamp: index + 1 }));
  const model = { contextWindow: 128_000, maxTokens: 16_384 } as Model<Api>;
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let requests = 0;
    const models = { completeSimple: async () => {
      requests += 1;
      if (cancel) controller.abort();
      return { role: 'assistant', content: [], stopReason: 'error', errorMessage: '401 unauthorized' };
    } } as unknown as Pick<Models, 'completeSimple'>;
    await assert.rejects(compactPiMessages({ messages, models, model, thinkingLevel: 'low', signal: controller.signal }), cancel ? { name: 'AbortError' } : /Context budget: summary request failed/);
    assert.equal(requests, 1);
    assert.equal(messages.length, 80);
    assert.equal(messages[0]?.role, 'user');
  }
});

test('the first long tool turn can summarize its prefix while retaining recent tool results', async () => {
  const messages: AgentMessage[] = [{ role: 'user', content: 'Inspect the evidence.', timestamp: 1 }];
  for (let index = 0; index < 16; index += 1) {
    messages.push({
      role: 'assistant', api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: index + 2,
      content: [{ type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { path: `evidence-${index}` } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }, { role: 'toolResult', toolCallId: `call-${index}`, toolName: 'read', content: [{ type: 'text', text: `evidence-${index} ${'x'.repeat(10_000)}` }], isError: false, timestamp: index + 2 });
  }
  let summaries = 0;
  const models = { completeSimple: async () => {
    summaries += 1;
    return { role: 'assistant', content: [{ type: 'text', text: 'Inspected early evidence.' }], stopReason: 'stop' };
  } } as unknown as Pick<Models, 'completeSimple'>;
  const result = await compactPiMessages({ messages, models, model: { contextWindow: 128_000, maxTokens: 16_384 } as Model<Api>, thinkingLevel: 'low' });
  assert.ok(result);
  assert.equal(summaries, 1);
  assert.equal(result.messages[0]?.role, 'compactionSummary');
  assert.match(JSON.stringify(result.messages.at(-1)), /evidence-15/);
  assert.ok(result.messages.length < messages.length);
});

test('stripThinkMarkup drops think blocks including MiniMax closures', () => {
  assert.equal(stripThinkMarkup('keep <think>hidden</think> going'), 'keep  going');
  assert.match(stripThinkMarkup('a <mm:think>x</mm:think> b'), /^a\s+b$/);
});

test('prunePiMessagesForBudget stubs oversized tool bodies and can shrink a working set', () => {
  const messages: AgentMessage[] = [
    {
      role: 'user',
      content: JSON.stringify({
        investigationPacket: { candidatePaths: Array.from({ length: 20 }, (_, index) => `path-${index}.html`), laterUserTurns: ['later'] },
        playbook: { text: 'full playbook', version: 'v1' },
        resolved: { catalog: [{ ref: 'event:transcript-0-aaaaaaaaaaaaaaaa' }], evidenceRefs: Array.from({ length: 20 }, (_, index) => `event:transcript-${index}-aaaaaaaaaaaaaaaa`) },
      }),
      timestamp: 1,
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'visible <think>hidden chain</think> next' }],
      timestamp: 2,
    } as AgentMessage,
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'x'.repeat(20_000) }],
      isError: false,
      timestamp: 3,
    },
  ];
  const pruned = prunePiMessagesForBudget(messages, false);
  assert.equal(pruned.changed, true);
  assert.match(pruned.summary, /stripped thinking/);
  const tool = messages[2] as { content: Array<{ text: string }> };
  assert.match(tool.content[0]?.text ?? '', /"stub":true/);
  const aggressive = prunePiMessagesForBudget(messages, true);
  assert.equal(aggressive.changed, true);
  assert.equal(shrinkWorkingSetMessage(messages, true), false);
  const working = JSON.parse((messages[0] as { content: string }).content) as {
    investigationPacket: { candidatePaths: string[]; laterUserTurns: string[] };
    playbook: { text?: string };
    resolved: { catalog?: unknown; evidenceRefs: string[] };
  };
  assert.equal(working.investigationPacket.candidatePaths.length, 0);
  assert.deepEqual(working.investigationPacket.laterUserTurns, []);
  assert.equal('text' in working.playbook, false);
  assert.equal('catalog' in working.resolved, false);
  assert.ok(working.resolved.evidenceRefs.length <= 8);
});
