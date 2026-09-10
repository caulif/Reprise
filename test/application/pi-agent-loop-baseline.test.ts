import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import {
  Agent,
  AgentHarness,
  InMemorySessionRepo,
  convertToLlm,
  type AgentEvent,
} from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Models } from '@earendil-works/pi-ai';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';

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

test('installed Pi Agent loop keeps native blocks, tool pairing, and event order', async () => {
  const events: AgentEvent['type'][] = [];
  const agent = new Agent({
    sessionId: 'baseline-loop',
    streamFn: queuedStreams([
      assistant('toolUse', [{ type: 'toolCall', id: 'call-1', name: 'inspect', arguments: { x: 1 } }]),
      assistant('stop', [{ type: 'text', text: 'finished' }]),
    ]),
    convertToLlm,
    initialState: {
      systemPrompt: 'Stay in the loop.',
      model,
      thinkingLevel: 'off',
      tools: [{
        name: 'inspect',
        label: 'inspect',
        description: 'Return a native text block.',
        parameters: Type.Object({ x: Type.Integer() }),
        async execute() {
          return { content: [{ type: 'text', text: 'native-tool-block' }], details: { ok: true } };
        },
      }],
    },
  });
  agent.subscribe((event) => { events.push(event.type); });
  await agent.prompt('inspect the sample');
  await agent.waitForIdle();
  const transcript = agent.state.messages;
  const toolCall = transcript.find((message) => message.role === 'assistant');
  const toolResult = transcript.find((message) => message.role === 'toolResult');
  assert.equal(toolCall && 'content' in toolCall && Array.isArray(toolCall.content) ? toolCall.content[0]?.type : undefined, 'toolCall');
  assert.equal(toolResult && 'toolCallId' in toolResult ? toolResult.toolCallId : undefined, 'call-1');
  assert.deepEqual(toolResult && 'content' in toolResult ? toolResult.content : undefined, [{ type: 'text', text: 'native-tool-block' }]);
  const significant = events.filter((type) => type !== 'message_update');
  assert.deepEqual(significant, [
    'agent_start',
    'turn_start',
    'message_start',
    'message_end',
    'message_start',
    'message_end',
    'tool_execution_start',
    'tool_execution_end',
    'message_start',
    'message_end',
    'turn_end',
    'turn_start',
    'message_start',
    'message_end',
    'turn_end',
    'agent_end',
  ]);
});

test('Pi Agent abort stops a hanging provider stream', async () => {
  const agent = new Agent({
    sessionId: 'baseline-cancel',
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      const abort = () => {
        stream.push({
          type: 'error',
          reason: 'aborted',
          error: assistant('aborted', [], 'provider aborted'),
        });
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
      return stream;
    },
    convertToLlm,
    initialState: { systemPrompt: 'test', model, thinkingLevel: 'off', tools: [] },
  });
  let started = false;
  agent.subscribe((event) => { if (event.type === 'agent_start') started = true; });
  const pending = agent.prompt('hang');
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!started) return;
      clearInterval(timer);
      resolve();
    }, 1);
  });
  agent.abort();
  await pending;
  await agent.waitForIdle();
  const last = agent.state.messages.at(-1);
  assert.equal(last && 'stopReason' in last ? last.stopReason : undefined, 'aborted');
});

test('PiModelCaller forwards native tool content blocks instead of the text fallback', async () => {
  const seen: string[] = [];
  const responses = [
    assistant('toolUse', [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]),
    assistant('stop', [{ type: 'text', text: 'ok' }]),
  ];
  const models = {
    getModel: () => model,
    streamSimple: (_unused: unknown, context: unknown) => {
      seen.push(JSON.stringify(context));
      const message = responses.shift();
      if (!message) throw new Error('Unexpected extra request.');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
      return stream;
    },
    completeSimple: () => { throw new Error('Unexpected summary request.'); },
  } as unknown as PiModels;
  const session = new PiModelCaller(
    { schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' },
    models,
  ).createSession({
    sessionId: 'native-wrapper',
    systemPrompt: 'test',
    tools: [{
      name: 'read',
      description: 'read',
      parameters: Type.Object({}),
      execute: async () => ({ content: 'fallback-text', contentBlocks: [{ type: 'text', text: 'native-block-body' }] }),
    }],
  });
  assert.equal(await session.append({ content: 'go', signal: new AbortController().signal }), 'ok');
  assert.match(seen[1] ?? '', /native-block-body/);
  assert.doesNotMatch(seen[1] ?? '', /fallback-text/);
});

test('AgentHarness prompt, compact and resume are unimplemented in Pi 0.84.1', async () => {
  const session = await new InMemorySessionRepo().create();
  const { harness } = await AgentHarness.create({
    session,
    models: {} as Models,
    model,
  });
  await assert.rejects(harness.prompt('hello'), /AgentHarness\.prompt is not implemented yet/);
  await assert.rejects(harness.compact(), /AgentHarness\.compact is not implemented yet/);
  await assert.rejects(harness.resume(), /AgentHarness\.resume is not implemented yet/);
});

test('Reprise source does not take Pi JSONL or AgentHarness as a second fact owner', async () => {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      const text = await readFile(path, 'utf8');
      if (/\bAgentHarness\b|\bJsonlSessionRepo\b/.test(text)) hits.push(path);
    }
  }
  await walk(join(process.cwd(), 'src'));
  assert.deepEqual(hits, []);
});
