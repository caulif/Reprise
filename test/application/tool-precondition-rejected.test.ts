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

for (const oldText of ['absent', 'same']) test(`edit text precondition (${oldText}) rejects before journaling or mutation`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.work, 'notes.md'), 'same first\nsame second');
  await assert.rejects(f.get('edit').execute({ path: 'notes.md', oldText, newText: 'changed' }, new AbortController().signal),
    error => error instanceof ToolPreconditionRejected && error.reason === 'edit_text_mismatch');
  assert.equal(await readFile(join(f.work, 'notes.md'), 'utf8'), 'same first\nsame second');
  assert.deepEqual(f.counts(), { spawns: 0, writes: 0 });
});

for (const role of ['recovery', 'comparison'] as const) for (const oldText of ['absent', 'same']) {
  test(`${role} native edit (${oldText}) can read, correct and complete after text rejection`, async t => {
    const f = await fixture(t); const contexts: Context[] = [], events: AgentAuditEvent[] = [];
    await writeFile(join(f.work, 'notes.md'), 'same first\nsame second');
    const responses = [turn('edit', { path: 'notes.md', oldText, newText: 'changed' }), turn('read', { path: 'notes.md' }),
      turn('edit', { path: 'notes.md', oldText: 'same first', newText: 'changed first' }),
      message([{ type: 'text', text: role === 'recovery' ? '{"status":"ready"}' : 'Done' }], 'stop')];
    const session = await new AgentHost(new PiModelCaller(config, native(responses, contexts))).createSession({
      role, systemPrompt: 'Correct edit inputs', tools: f.tools, audit: { append: async event => { events.push(event); } },
    });
    const result = role === 'recovery'
      ? await session.request<{ status: 'ready' }>({ promptContent: 'Conclude recovery', schema: Type.Object({ status: Type.Literal('ready') }),
        allowTools: true, timeoutMs: 2_000, maxRepairAttempts: 0 })
      : await session.work({ promptContent: 'Update notes', timeoutMs: 2_000 });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(await readFile(join(f.work, 'notes.md'), 'utf8'), 'changed first\nsame second');
    assert.deepEqual(f.counts(), { spawns: 0, writes: 2 });
    assert.ok(events.some(event => event.type === 'agent.tool_failed' && event.payload.tool === 'edit'));
    const errorResult = contexts[1]!.messages.find(item => item.role === 'toolResult');
    assert.ok(errorResult && 'isError' in errorResult && errorResult.isError);
    assert.match(JSON.stringify(errorResult), /Read the current file and retry/);
    assert.match(JSON.stringify(contexts[2]!.messages), /same first/);
    assert.equal(events.some(event => event.type === 'agent.invocation_failed'), false);
  });
}

for (const mode of ['audit', 'persist', 'read'] as const) test(`edit rejection does not hide actual ${mode} failure`, async t => {
  const f = await fixture(t); const events: AgentAuditEvent[] = []; let failures = 0;
  await writeFile(join(f.work, 'notes.md'), 'current');
  const tools = workspaceTools(f.work, { onControlledWrite: async () => {
    if (mode === 'persist') { failures++; throw new Error('Actual edit journal failure'); }
  } });
  const responses = [turn('edit', { path: 'notes.md', oldText: 'absent', newText: 'changed' }),
    turn('edit', { path: mode === 'read' ? 'missing.md' : 'notes.md', oldText: 'current', newText: 'changed' }),
    message([{ type: 'text', text: 'Done' }], 'stop')];
  const session = await new AgentHost(new PiModelCaller(config, native(responses))).createSession({ role: 'recovery',
    systemPrompt: 'Correct edits', tools, audit: { append: async event => {
      events.push(event);
      if (mode === 'audit' && event.type === 'agent.tool_failed' && !event.payload.nativeHook) {
        failures++; throw new ToolPreconditionRejected('edit_text_mismatch', 'Actual edit failure audit failure');
      }
    } },
  });
  const result = await session.work({ promptContent: 'Update notes', timeoutMs: 2_000 });
  assert.equal(result.status, 'failed', JSON.stringify(result));
  if (mode !== 'read') assert.ok(failures > 0);
  else assert.ok(events.some(event => event.type === 'agent.tool_failed' && /ENOENT/.test(String(event.payload.message))));
  if (mode !== 'audit') assert.equal(await readFile(join(f.work, 'notes.md'), 'utf8'), 'current');
  assert.equal(events.some(event => event.type === 'agent.invocation_completed'), false);
});
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

test('invalid workspace paths reject before filesystem reads, writes, journals or process creation', async t => {
  const f = await fixture(t); let reads = 0;
  const tools = workspaceTools(f.work, { mounts: { source: f.source }, filesystem: {
    readDirectory: async () => { reads++; throw new Error('Invalid path must not reach directory access'); },
    readRegularFile: async () => { reads++; throw new Error('Invalid path must not reach file access'); },
  }, onControlledWrite: async () => { throw new Error('Invalid path must not reach persistence'); } });
  for (const path of ['../../', join(f.source, 'input.txt')]) {
    for (const [name, params] of [
      ['ls', { path }], ['read', { path }], ['write', { path, content: 'changed' }],
      ['edit', { path, oldText: 'sealed', newText: 'changed' }],
    ] as const) await assert.rejects(tools.find(tool => tool.name === name)!.execute(params, new AbortController().signal),
      error => error instanceof ToolPreconditionRejected && error.reason === 'invalid_path');
  }
  assert.equal(reads, 0); assert.deepEqual(f.counts(), { spawns: 0, writes: 0 });
  assert.deepEqual(await readdir(f.work), []); assert.equal(await readFile(join(f.source, 'input.txt'), 'utf8'), 'sealed');
});

for (const mode of ['corrected', 'audit', 'persist'] as const) test(`native invalid ls path allows correction but preserves ${mode} outcome`, async t => {
  const f = await fixture(t); const contexts: Context[] = [], events: AgentAuditEvent[] = [];
  let persistenceFailures = 0;
  const responses = [turn('ls', { path: '../../' }), turn('ls', { path: f.source }), turn('read', { path: 'source/input.txt' }),
    ...(mode === 'persist' ? [turn('write', { path: 'result.txt', content: 'corrected' })] : []), message([{ type: 'text', text: 'Done' }], 'stop')];
  const tools = mode === 'persist' ? workspaceTools(f.work, { mounts: { source: f.source },
    onControlledWrite: async () => { persistenceFailures++; throw new Error('Actual correction persistence failure'); } }) : f.tools;
  const session = await new AgentHost(new PiModelCaller(config, native(responses, contexts))).createSession({
    role: 'comparison', systemPrompt: 'Use virtual workspace paths', tools, audit: { append: async event => {
      events.push(event);
      if (mode === 'audit' && event.type === 'agent.tool_failed') { persistenceFailures++; throw new Error('Actual invalid-path audit persistence failure'); }
    } },
  });
  const result = await session.work({ promptContent: 'Inspect the sealed source', timeoutMs: 2_000 });
  assert.equal(result.status, mode === 'corrected' ? 'completed' : 'failed', JSON.stringify(result));
  assert.equal(await readFile(join(f.source, 'input.txt'), 'utf8'), 'sealed');
  assert.deepEqual(await readdir(f.work), []);
  if (mode !== 'corrected') {
    assert.ok(persistenceFailures > 0, 'the fixture actually triggers the audited or controlled-write persistence failure');
    assert.ok(events.some(event => event.type === 'agent.invocation_failed'));
    assert.equal(events.some(event => event.type === 'agent.invocation_completed'), false);
  }
  assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'read' && !event.payload.nativeHook));
  assert.match(JSON.stringify(contexts[3]!.messages), /sealed/);
  const denied = events.filter(event => event.type === 'agent.tool_failed' && String(event.payload.message).includes('relative path within the workspace'));
  assert.equal(denied.length, 2, 'both traversal and absolute ls attempts are refused and audited');
  for (const context of contexts.slice(1, 3)) assert.ok(context.messages.some(item => item.role === 'toolResult' && 'isError' in item && item.isError));
  if (mode === 'corrected') assert.equal(events.some(event => event.type === 'agent.invocation_failed'), false);
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

for (const failure of ['Actual ordinary tool execution failure', '400 context_length_exceeded: Your input exceeds the context window of this model.']) test(`a Host tool failure (${failure}) remains fatal after the native SDK produces a normal stop`, async () => {
  const events: AgentAuditEvent[] = [], contexts: Context[] = [];
  const session = await new AgentHost(new PiModelCaller(config, native([turn('check'), message([{ type: 'text', text: 'Done' }], 'stop')], contexts))).createSession({
    role: 'comparison', systemPrompt: 'Check', tools: [{ name: 'check', description: 'Actual failing check', parameters: Type.Object({}),
      execute: async () => { throw new Error(failure); } }], audit: { append: async event => { events.push(event); } },
  });
  const result = await session.work({ promptContent: 'Check the actual source', timeoutMs: 2_000 });
  assert.equal(contexts.length, 2, 'the SDK actually continues to the normal final stop after its error tool result');
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.ok(events.some(event => event.type === 'agent.tool_failed' && event.payload.message === failure));
  assert.equal(events.some(event => event.type === 'agent.invocation_completed'), false);
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

for (const mismatch of ['missing', 'ambiguous'] as const) test(`native edit ${mismatch} match can be corrected without failing the invocation`, async t => {
  const f = await fixture(t); const contexts: Context[] = [], events: AgentAuditEvent[] = [];
  await writeFile(join(f.work, 'edit.txt'), 'alpha alpha');
  const responses = [turn('edit', { path: 'edit.txt', oldText: mismatch === 'missing' ? 'absent' : 'alpha', newText: 'wrong' }),
    turn('edit', { path: 'edit.txt', oldText: 'alpha alpha', newText: 'beta' }), message([{ type: 'text', text: 'Done' }], 'stop')];
  const session = await new AgentHost(new PiModelCaller(config, native(responses, contexts))).createSession({
    role: 'recovery', systemPrompt: 'Edit precisely', tools: f.tools, audit: { append: async event => { events.push(event); } },
  });
  const result = await session.work({ promptContent: 'Edit the file', timeoutMs: 2_000 });
  await session.close();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(await readFile(join(f.work, 'edit.txt'), 'utf8'), 'beta');
  assert.equal(f.counts().writes, 2, 'only the corrected edit reaches its before/after journal');
  assert.ok(contexts[1]!.messages.some(item => item.role === 'toolResult' && 'isError' in item && item.isError));
  assert.equal(events.filter(event => event.type === 'agent.tool_failed').length, 1);
  assert.equal(events.some(event => event.type === 'agent.invocation_failed'), false);
});

for (const name of ['edit', 'write'] as const) test(`timeout then concurrent close drains a paused native ${name} without late writes`, async t => {
  const f = await fixture(t); const events: AgentAuditEvent[] = [], phases: string[] = [];
  await writeFile(join(f.work, 'edit.txt'), 'alpha');
  let resume!: () => void, started!: () => void;
  const paused = new Promise<void>(done => { started = done; });
  const gate = new Promise<void>(done => { resume = done; });
  const tools = workspaceTools(f.work, { onControlledWrite: async entry => {
    phases.push(entry.phase);
    if (entry.phase === 'before') { started(); await gate; }
  } });
  const args = name === 'edit' ? { path: 'edit.txt', oldText: 'alpha', newText: 'beta' } : { path: 'edit.txt', content: 'beta' };
  const session = await new AgentHost(new PiModelCaller(config, native([turn(name, args)]))).createSession({
    role: 'recovery', systemPrompt: 'Write', tools, audit: { append: async event => { events.push(event); } },
  });
  const pending = session.work({ promptContent: 'Write the file', timeoutMs: 100 });
  await paused;
  const result = await pending;
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.failure.code, 'agent_timeout');
  let closed = 0;
  const first = session.close().then(() => { closed++; });
  const second = session.close().then(() => { closed++; });
  await new Promise(done => setImmediate(done));
  assert.equal(closed, 0);
  assert.equal(events.some(event => event.type === 'agent.session_completed'), false);
  resume();
  await Promise.all([first, second]);
  assert.equal(closed, 2);
  assert.equal(await readFile(join(f.work, 'edit.txt'), 'utf8'), 'alpha');
  assert.deepEqual(phases, ['before', 'failed']);
  assert.equal(events.at(-1)?.type, 'agent.session_completed');
  assert.equal(events.filter(event => event.type === 'agent.session_completed').length, 1);
});

for (const name of ['edit', 'write'] as const) test(`already aborted ${name} never begins a controlled write`, async t => {
  const f = await fixture(t);
  await writeFile(join(f.work, 'edit.txt'), 'alpha');
  const controller = new AbortController(); controller.abort();
  const args = name === 'edit' ? { path: 'edit.txt', oldText: 'alpha', newText: 'beta' } : { path: 'new/nested.txt', content: 'beta' };
  await assert.rejects(f.get(name).execute(args, controller.signal), { name: 'AbortError' });
  assert.equal(f.counts().writes, 0);
  assert.deepEqual(await readdir(f.work), ['edit.txt']);
  assert.equal(await readFile(join(f.work, 'edit.txt'), 'utf8'), 'alpha');
});
