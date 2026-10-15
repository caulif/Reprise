import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Type } from '@sinclair/typebox';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProcessSession } from '../../src/infrastructure/process-session.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { workspaceProcessTools } from '../../src/infrastructure/workspace-process-tools.js';
import { AgentHost, type AgentToolDefinition, type ProviderAdapter } from '../../src/infrastructure/agent/host.js';
import { ToolPreconditionRejected } from '../../src/core/tool-precondition-rejected.js';
import type { ProcessSpawner } from '../../src/infrastructure/process-runner.js';
import { processOutputLog } from '../../src/infrastructure/process-output-log.js';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => child.emit('close', null)); return true; },
  });
  const spawnProcess = (() => child) as unknown as ProcessSpawner;
  const signal = new AbortController().signal;
  const process = startProcessSession({ command: 'fixture', args: [], cwd: '.', env: {}, signal, spawnProcess });
  const registry = workspaceProcessTools({ description: 'Fixture', start: async () => ({ process, cwd: '.' }) });
  const tools = Object.fromEntries(registry.tools.map(tool => [tool.name, tool]));
  const owner = { sessionId: 'session', invocationId: 'first' };
  return { child, signal, process, registry, tools, owner };
}

test('managed output is incremental, serialized, UTF-8 safe, and a nonzero exit is a command result', async () => {
  const { child, signal, tools, owner } = fixture();
  child.stdout.write('你好one');
  const first = await tools.exec_command!.execute({ cmd: 'test', yield_time_ms: 0, max_output_tokens: 1 }, signal, owner);
  const id = (first.details as { session_id: string }).session_id;
  assert.equal((first.details as { output: string }).output, '你');
  assert.equal((first.details as { state: string }).state, 'running');
  child.stderr.write('two'); child.emit('close', 7);
  const slices = await Promise.all([1, 2].map(() => tools.write_stdin!.execute({ session_id: id, yield_time_ms: 0 }, signal, owner)));
  assert.equal((slices[0]!.details as { output: string }).output, '好onetwo');
  assert.equal((slices[1]!.details as { output: string }).output, '');
  assert.equal((slices[0]!.details as { exitCode: number }).exitCode, 7);
  assert.equal((slices[0]!.details as { state: string }).state, 'completed');
  await tools.exec_command!.lifecycle!.finishInvocation(owner);
  await assert.rejects(tools.write_stdin!.execute({ session_id: id }, signal, owner), ToolPreconditionRejected);
});

test('background commands retain workspace ownership and reject foreign invocation handles', async () => {
  const { tools, signal, owner, registry } = fixture();
  const started = await tools.exec_command!.execute({ cmd: 'test', yield_time_ms: 0 }, signal, owner);
  const id = (started.details as { session_id: string }).session_id;
  assert.throws(() => registry.assertIdle(), (error: unknown) => error instanceof ToolPreconditionRejected && error.reason === 'workspace_busy');
  for (const foreign of [{ ...owner, sessionId: 'other' }, { ...owner, invocationId: 'other' }]) {
    await assert.rejects(tools.write_stdin!.execute({ session_id: id }, signal, foreign), ToolPreconditionRejected);
    await assert.rejects(tools.cancel_process!.execute({ session_id: id }, signal, foreign), ToolPreconditionRejected);
  }
  const cancelled = await tools.cancel_process!.execute({ session_id: id }, signal, owner);
  assert.equal((cancelled.details as { state: string }).state, 'cancelled');
  registry.assertIdle();
  await tools.exec_command!.lifecycle!.finishInvocation(owner);
});

test('invocation refuses completion and drains an unfinished command before returning', async () => {
  const { process, registry } = fixture();
  let tool!: AgentToolDefinition;
  const provider: ProviderAdapter = { createSession: input => {
    tool = input.tools.find(item => item.name === 'exec_command')!;
    return { append: async request => {
      await tool.execute({ cmd: 'test', yield_time_ms: 0 }, request.signal);
      return 'ready';
    }, cancel() {} };
  } };
  const session = await new AgentHost(provider).createSession({ role: 'recovery', systemPrompt: 'Fixture', tools: registry.tools });
  const result = await session.work({ promptContent: 'Start', timeoutMs: 1_000 });
  assert.equal(result.status, 'failed');
  assert.equal(process.running, false);
  registry.assertIdle();
  await session.close();
});

test('process artifact persistence failure stays fatal through the Host and is not retried during cleanup', async () => {
  let commits = 0;
  const { child, process } = fixture();
  child.emit('close', 0);
  const registry = workspaceProcessTools({ description: 'Failure fixture',
    start: async () => ({ process, cwd: '.', outputLog: 'process.log' }),
    onProcessLog: async () => { commits++; throw new Error('Artifact store unavailable'); },
  });
  const session = await new AgentHost({ createSession: input => ({ append: async request => {
    await input.tools.find(tool => tool.name === 'exec_command')!.execute({ cmd: 'test', yield_time_ms: 0 }, request.signal);
    return 'done';
  }, cancel() {} }) }).createSession({ role: 'comparison', systemPrompt: 'Fixture', tools: registry.tools });
  await assert.rejects(session.work({ promptContent: 'Start', timeoutMs: 1_000 }), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.match(String(error.errors[0].errors[0]), /Artifact store unavailable/);
    return true;
  });
  assert.equal(commits, 1);
  await session.close();
});

test('a fatal lifecycle failure waits for all other cleanup before publishing the failed invocation', async () => {
  let release!: () => void, entered!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [];
  const tools: AgentToolDefinition[] = [
    { name: 'first', description: 'Early failure', parameters: Type.Object({}), execute: async () => ({ content: 'ok' }),
      lifecycle: { finishInvocation: async (_owner, requireCompleted) => { if (requireCompleted) throw new Error('early cleanup failure'); } } },
    { name: 'second', description: 'Delayed cleanup', parameters: Type.Object({}), execute: async () => ({ content: 'ok' }),
      lifecycle: { finishInvocation: async () => { entered(); await gate; } } },
  ];
  const session = await new AgentHost({ createSession: () => ({ append: async () => 'ready', cancel() {} }) }).createSession({
    role: 'recovery', systemPrompt: 'Fixture', tools, audit: { append: async event => { events.push(event.type); } },
  });
  const work = session.work({ promptContent: 'Finish', timeoutMs: 1_000 }).then(result => { settled = true; return result; });
  await start; await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(events.includes('agent.invocation_completed'), false);
  assert.equal(events.includes('agent.invocation_failed'), false);
  release();
  assert.equal((await work).status, 'failed');
  assert.equal(events.includes('agent.invocation_completed'), false);
  assert.equal(events.includes('agent.invocation_failed'), true);
  await session.close();
});

test('process buffering is bounded and truncation is explicit', async () => {
  const { child, process } = fixture();
  child.stdout.write(Buffer.alloc(1_048_580, 'x'));
  child.emit('close', 0);
  const result = await process.poll(0, 262_144);
  assert.equal(result.output.length, 262_144);
  assert.equal(result.truncated, true);
  assert.equal(result.remainingOutput, true);
});

test('workspace managed execution keeps file tools parallel and excludes legacy shell from default exposure', () => {
  const tools = workspaceTools('.', { allowShell: true, managedExecution: true });
  assert.equal(tools.some(tool => tool.name === 'shell_exec'), false);
  for (const name of ['read', 'ls', 'grep', 'find']) assert.equal(tools.find(tool => tool.name === name)?.executionMode, 'parallel');
  assert.equal(workspaceTools('.', { allowShell: true }).some(tool => tool.name === 'shell_exec'), true);
});

test('real pipe process can yield, receive input, exit, and drain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const process = startProcessSession({ command: globalThis.process.execPath,
    args: ['-e', 'process.stdout.write("ready"); process.stdin.once("data", c => { process.stdout.write(c); process.exit(0); });'],
    cwd: root, env: globalThis.process.env, signal: new AbortController().signal });
  const first = await process.poll(0, 100);
  assert.equal(first.state, 'running');
  const completed = await process.poll(5_000, 100, 'done');
  assert.equal(completed.state, 'completed');
  assert.equal(first.output + completed.output, 'readydone');
  await process.cancel();
});

test('managed process lifetime is independent from the old sixty-second shell timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { child, process } = fixture();
  const waiting = process.poll(10_000, 100);
  await Promise.resolve();
  t.mock.timers.tick(65_000);
  assert.equal((await waiting).state, 'running');
  assert.equal(process.running, true);
  child.emit('close', 0);
  assert.equal((await process.poll(0, 100)).state, 'completed');
});

test('diagnostic logs redact split credentials and omit oversized lines', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-process-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'output.log');
  const log = processOutputLog(path);
  log.append(Buffer.from('token=abc'));
  log.append(Buffer.from('def\nordinary\n'));
  log.append(Buffer.from('x'.repeat(70_000)));
  log.append(Buffer.from('secret-tail\nlast line'));
  await log.finish();
  const text = await readFile(path, 'utf8');
  assert.equal(text, 'token=[REDACTED]\nordinary\n[oversized output line omitted]\nlast line');
  assert.equal(log.truncated, true);
});

test('log ceiling is distinct from incremental-output buffer truncation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-log-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = processOutputLog(join(root, 'output.log'));
  for (let i = 0; i < 257; i++) log.append(Buffer.from('x'.repeat(65_535) + '\n'));
  await log.finish();
  assert.equal(log.truncated, true);
  assert.equal((await readFile(join(root, 'output.log'))).byteLength, 16_777_216);
});

test('failed diagnostic persistence is fatal before a process can be reported completed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-log-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const process = startProcessSession({ command: globalThis.process.execPath, args: ['-e', 'console.log("done")'], cwd: root,
    env: globalThis.process.env, signal: new AbortController().signal, outputLogPath: root });
  await assert.rejects(process.poll(5_000, 100), /log persistence failed/);
  await assert.rejects(process.cancel(), /log persistence failed/);
});

test('missing and directory editable targets are correctable preconditions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-edit-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const edit = workspaceTools(root).find(tool => tool.name === 'edit')!;
  const signal = new AbortController().signal;
  await assert.rejects(edit.execute({ path: 'absent.txt', oldText: 'x', newText: 'y' }, signal), ToolPreconditionRejected);
  await assert.rejects(edit.execute({ path: '.', oldText: 'x', newText: 'y' }, signal), error => error instanceof ToolPreconditionRejected && error.reason === 'not_regular_file');
});

test('aborting a real process tree drains child writes before the caller proceeds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-process-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'writes.txt');
  const script = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e', ${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(output)},'x'),10)`) }],{stdio:'inherit'}); console.log('started'); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const process = startProcessSession({ command: globalThis.process.execPath, args: ['-e', script], cwd: root,
    env: globalThis.process.env, signal: controller.signal });
  await process.poll(1_000, 100);
  assert.ok((await readFile(output, 'utf8')).length > 0, 'nested child must have written before testing tree cancellation');
  controller.abort(); await process.cancel();
  const read = async () => readFile(output, 'utf8').catch(() => '');
  const before = await read();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await read(), before);
  assert.equal((await process.poll(0, 100)).state, 'cancelled');
});
