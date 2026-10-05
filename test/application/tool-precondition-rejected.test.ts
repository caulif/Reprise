import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from '@earendil-works/pi-ai';
import { ToolPreconditionRejected } from '../../src/core/tool-precondition-rejected.js';
import { AgentHost, type AgentAuditEvent, type AgentToolDefinition } from '../../src/infrastructure/agent/host.js';
import { PiModelCaller, type PiModels } from '../../src/infrastructure/agent/model-caller.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { PiProviderAdapter } from '../../src/infrastructure/agent/providers/pi/adapter.js';

const model: Model<'openai-completions'> = { id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'https://example.test', reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const config = { schemaVersion: 2 as const, provider: { kind: 'pi-catalog' as const, id: 'fixture' }, providerId: 'fixture', modelId: 'fixture', effort: 'low' as const };
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function turn(name: string, args: Record<string, unknown> = {}): AssistantMessage {
  return message([{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args }]);
}
function native(responses: AssistantMessage[], contexts: Context[] = []): PiModels {
  return { getModel: () => model, streamSimple: (_: unknown, context: Context) => {
    contexts.push({ ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}), messages: structuredClone(context.messages),
      ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters: structuredClone(parameters) })) } : {}) });
    const response = responses.shift();
    assert.ok(response, 'no unexpected generation after soft boundary');
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: response.stopReason as 'stop' | 'toolUse', message: response }); return stream;
  } } as unknown as PiModels;
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-policy-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'sealed'); const work = join(root, 'work');
  await mkdir(source); await mkdir(work); await writeFile(join(source, 'input.txt'), 'sealed');
  let spawns = 0, writes = 0;
  const tools = workspaceTools(work, { allowShell: true, mounts: { source }, denyDestructiveOnPrefix: ['source'],
    spawnProcess: () => { spawns++; throw new Error('A denied shell must not spawn'); },
    onControlledWrite: async () => { writes++; } });
  const get = (name: string) => { const tool = tools.find(item => item.name === name); assert.ok(tool); return tool; };
  return { source, work, tools, get, counts: () => ({ spawns, writes }) };
}

for (const role of ['comparison', 'recovery'] as const) test(`${role} readonly refusals precede every write, journal and shell spawn`, async t => {
  const f = await fixture(t); const signal = new AbortController().signal;
  const commands = [
    ['shell_exec', { command: 'Set-Content source/input.txt changed' }],
    ['shell_exec', { command: `Remove-Item '${f.source}'` }],
    ['write', { path: 'source/nested/new.txt', content: 'changed' }],
    ['edit', { path: 'source/input.txt', oldText: 'sealed', newText: 'changed' }],
  ] as const;
  for (const [name, params] of commands) await assert.rejects(f.get(name).execute(params, signal), error => error instanceof ToolPreconditionRejected && error.reason === 'read_only_mount');
  const policy = workspaceTools(f.work, { role, allowWrite: () => false }).find(item => item.name === 'write')!;
  await assert.rejects(policy.execute({ path: 'nested/new.txt', content: 'no' }, signal), error => error instanceof ToolPreconditionRejected && error.reason === 'host_write_policy');
  assert.deepEqual(f.counts(), { spawns: 0, writes: 0 });
  assert.deepEqual(await readdir(f.source), ['input.txt']); assert.deepEqual(await readdir(f.work), []);
  assert.equal(await readFile(join(f.source, 'input.txt'), 'utf8'), 'sealed');
});

test('actual readonly shell refusal remains audited and model-visible, then corrected write reaches a native safe-turn yield', async t => {
  const f = await fixture(t); const contexts: Context[] = [], events: AgentAuditEvent[] = [];
  const responses = [turn('shell_exec', { command: 'Set-Content source/input.txt changed' }), turn('write', { path: 'result.txt', content: 'corrected' })];
  const session = await new AgentHost(new PiModelCaller(config, native(responses, contexts))).createSession({ role: 'comparison', systemPrompt: 'Inspect sources', tools: f.tools,
    audit: { append: async event => { events.push(event); } } });
  let turns = 0;
  const result = await session.work({ promptContent: 'Read source and use writable work copy', timeoutMs: 2_000, yieldAfterTurn: () => ++turns === 2 ? 'reviewModelRequests' : undefined });
  assert.equal(result.status, 'yielded'); if (result.status === 'yielded') assert.equal(result.reason, 'reviewModelRequests');
  assert.equal(contexts.length, 2); assert.equal(await readFile(join(f.work, 'result.txt'), 'utf8'), 'corrected');
  assert.equal(await readFile(join(f.source, 'input.txt'), 'utf8'), 'sealed'); assert.deepEqual(f.counts(), { spawns: 0, writes: 2 });
  const failed = events.find(event => event.type === 'agent.tool_failed')!; assert.match(String(failed.payload.message), /write_denied/);
  const after = events.find(event => event.type === 'agent.tool_completed' && event.payload.nativeHook === 'after' && event.payload.tool === 'shell_exec')!;
  assert.equal(after.payload.isError, true);
  const errorResult = contexts[1]!.messages.find(item => item.role === 'toolResult'); assert.ok(errorResult && 'isError' in errorResult && errorResult.isError);
  assert.match(JSON.stringify(errorResult), /write_denied[\s\S]*Keep source inspection and work-copy mutation in separate shell calls/);
  assert.equal(events.some(event => event.type === 'agent.invocation_failed'), false);
});

for (const mode of ['execute', 'persist', 'delivery', 'audit', 'before_hook', 'after_hook', 'cancel', 'hard'] as const) test(`a readonly refusal cannot hide subsequent ${mode} failure behind a safe-turn yield`, async t => {
  const f = await fixture(t); const events: AgentAuditEvent[] = []; const contexts: Context[] = [];
  const controller = new AbortController(); let turns = 0;
  const fail = () => { throw new Error(`Actual ${mode} failure`); };
  const correction: AgentToolDefinition = mode === 'persist'
    ? workspaceTools(f.work, { onControlledWrite: async () => { fail(); } }).find(item => item.name === 'write')!
    : { name: 'check', description: 'Actual correction', parameters: Type.Object({}), execute: async () => { if (mode === 'execute') fail(); return { content: 'Corrected' }; },
      onCompleted: async () => { if (mode === 'delivery') throw new ToolPreconditionRejected('read_only_mount', 'A typed callback error must remain fatal'); } };
  const responses = [turn('shell_exec', { command: 'Set-Content source/input.txt changed' }), turn(correction.name, mode === 'persist' ? { path: 'result.txt', content: 'corrected' } : {})];
  const session = await new AgentHost(new PiModelCaller(config, native(responses, contexts))).createSession({ role: 'comparison', systemPrompt: 'Test', tools: [f.get('shell_exec'), correction], audit: { append: async event => {
    events.push(event);
    if (mode === 'audit' && event.type === 'agent.tool_failed') fail();
    if (mode === 'before_hook' && event.type === 'agent.tool_called' && event.payload.nativeHook === 'before' && event.payload.tool === correction.name) fail();
    if (mode === 'after_hook' && event.type === 'agent.tool_completed' && event.payload.nativeHook === 'after' && event.payload.tool === correction.name) fail();
    if (mode === 'cancel' && event.type === 'agent.usage_reported' && contexts.length === 2) controller.abort();
  } } });
  const result = await session.work({ promptContent: 'Correct denied operation', timeoutMs: 2_000, signal: controller.signal,
    yieldAfterTurn: () => { turns++; if (turns !== 2) return undefined; if (mode === 'hard') fail(); return 'reviewModelRequests'; } });
  assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed');
  assert.equal(events.some(event => event.type === 'agent.invocation_yielded'), false);
  assert.equal(await readFile(join(f.source, 'input.txt'), 'utf8'), 'sealed'); assert.equal(f.counts().spawns, 0);
  if (mode === 'persist') await assert.rejects(readFile(join(f.work, 'result.txt')), { code: 'ENOENT' });
});

test('same denial message or name on an ordinary error does not exempt actual execute failures', async () => {
  for (const fake of [new Error('write_denied: path is a read-only mount.'), Object.assign(new Error('write_denied'), { name: 'ToolPreconditionRejected' })]) {
    const provider = new PiProviderAdapter({ models: native([turn('check')]), model, config }).createSession({ sessionId: 'fake', systemPrompt: 'Test', tools: [
      { name: 'check', description: 'Actual failing tool', parameters: Type.Object({}), execute: async () => { throw fake; } },
    ] });
    await assert.rejects(provider.append({ content: 'Check', signal: new AbortController().signal, yieldAfterTurn: () => 'reviewModelRequests' }), error => error === fake);
  }
});

for (const hook of ['onBeforeToolCall', 'onAfterToolCall'] as const) test(`typed ${hook} failure remains fatal after actual guard denial`, async t => {
  const f = await fixture(t); let hookCalls = 0;
  const provider = new PiProviderAdapter({ models: native([turn('shell_exec', { command: 'Set-Content source/input.txt changed' }), turn('read', { path: 'source/input.txt' })]), model, config }).createSession({
    sessionId: 'hook', systemPrompt: 'Test', tools: [f.get('shell_exec'), f.get('read')],
    [hook]: async () => { if (++hookCalls === 2) throw new ToolPreconditionRejected('read_only_mount', 'Actual hook failure'); },
  });
  let turns = 0;
  await assert.rejects(provider.append({ content: 'Inspect', signal: new AbortController().signal, yieldAfterTurn: () => ++turns === 2 ? 'reviewModelRequests' : undefined }), /Actual hook failure/);
});

for (const auditType of ['agent.tool_called', 'agent.tool_failed', 'agent.tool_completed'] as const) test(`typed ${auditType} persistence failure never becomes a recoverable guard refusal`, async t => {
  const f = await fixture(t); const events: AgentAuditEvent[] = [];
  const session = await new AgentHost(new PiModelCaller(config, native([turn('shell_exec', { command: 'Set-Content source/input.txt changed' }), turn('read', { path: 'source/input.txt' })]))).createSession({
    role: 'comparison', systemPrompt: 'Test', tools: f.tools,
    audit: { append: async event => {
      events.push(event);
      if (event.type === auditType && !event.payload.nativeHook) throw new ToolPreconditionRejected('read_only_mount', 'Actual typed audit persistence failure');
    } },
  });
  let turns = 0;
  const result = await session.work({ promptContent: 'Inspect', timeoutMs: 2_000, yieldAfterTurn: () => ++turns === 2 ? 'reviewModelRequests' : undefined });
  assert.equal(result.status, 'failed'); assert.equal(events.some(event => event.type === 'agent.invocation_yielded'), false);
});
