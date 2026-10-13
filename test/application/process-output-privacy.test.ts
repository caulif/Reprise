import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { startProcessSession } from '../../src/infrastructure/process-session.js';
import { processOutputRedactor } from '../../src/infrastructure/process-output-redactor.js';
import { instrumentTools } from '../../src/infrastructure/agent/tools.js';
import { workspaceProcessTools } from '../../src/infrastructure/workspace-process-tools.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/types.js';
import type { ProcessSpawner } from '../../src/infrastructure/process-runner.js';

function fixture(outputLogPath?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => child.emit('close', null)); return true; },
  });
  const signal = new AbortController().signal;
  const process = startProcessSession({ command: 'fixture', args: [], cwd: '.', env: {}, signal,
    spawnProcess: (() => child) as unknown as ProcessSpawner, ...(outputLogPath ? { outputLogPath } : {}) });
  return { child, process, signal };
}

test('split UTF-8 stays intact across polls, independent pipes, and the memory ceiling', async () => {
  const { child, process } = fixture();
  const bytes = Buffer.from('你');
  child.stdout.write(bytes.subarray(0, 1));
  assert.equal((await process.poll(0, 100)).output, '');
  child.stderr.write('error\n');
  assert.equal((await process.poll(0, 100)).output, 'error\n');
  child.stdout.write(bytes.subarray(1));
  assert.equal((await process.poll(0, 100)).output, '你');
  child.stdout.write('x'.repeat(1_048_575) + '好');
  child.emit('close', 0);
  const result = await process.poll(0, 1_048_576);
  assert.equal(result.output, 'x'.repeat(1_048_575));
  assert.equal(result.truncated, true);
});

test('credential formats stay redacted at every possible stream split', () => {
  for (const text of ['token=synthetic-secret\n', '{"api_key":"synthetic-secret"}\n',
    'fetch https://alice:synthetic-secret@example.invalid/repo\n', 'Authorization: Bearer synthetic-secret\n',
    '{\\"password\\":\\"synthetic-secret\\"}\n', 'token=\n synthetic-secret\n',
    '{"client_secret":\n "synthetic-secret"}\n']) {
    for (let split = 0; split <= text.length; split++) {
      const parts: string[] = [];
      const redactor = processOutputRedactor(part => parts.push(part));
      redactor.append(text.slice(0, split));
      assert.ok(!parts.join('').includes('synthetic-secret'), `${split}: ${text}`);
      redactor.append(text.slice(split)); redactor.finish();
      assert.ok(!parts.join('').includes('synthetic-secret'), `${split}: ${text}`);
      assert.match(parts.join(''), /REDACTED/);
    }
  }
});

test('safe interactive prompts are delivered without a newline; incomplete and oversized secrets are omitted', () => {
  const parts: string[] = [];
  const redactor = processOutputRedactor(text => parts.push(text));
  redactor.append('ready> ');
  assert.equal(parts.join(''), 'ready> ');
  redactor.append('token=' + 'x'.repeat(70_000));
  redactor.append('synthetic-secret\nordinary\n');
  redactor.append('{"api_key":"synthetic-secret');
  redactor.finish();
  assert.equal(redactor.truncated, true);
  assert.ok(!parts.join('').includes('synthetic-secret'));
  assert.match(parts.join(''), /oversized output line omitted/);
  assert.match(parts.join(''), /ordinary/);
  assert.match(parts.join(''), /incomplete sensitive output omitted/);
});

for (const sensitivePipe of ['stdout', 'stderr'] as const) test(`${sensitivePipe} secrets survive interleaved output before pagination, model results, audit, and logs`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-output-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, 'output.log');
  const { child, process, signal } = fixture(logPath);
  const events: AgentAuditEvent[] = [];
  const registry = workspaceProcessTools({ description: 'Fixture', start: async () => ({ process, cwd: '.' }) });
  const tools = instrumentTools(registry.tools, 'session', 'recovery', { requestIndex: 0, invocationId: 'invocation' },
    { append: async event => { events.push(event); } });
  child[sensitivePipe].write('token=');
  const first = await tools[0]!.execute({ cmd: 'fixture', yield_time_ms: 0, max_output_tokens: 1 }, signal);
  const id = (first.details as { session_id: string }).session_id;
  child[sensitivePipe === 'stdout' ? 'stderr' : 'stdout'].write('progress\n');
  child[sensitivePipe].write('synthetic-secret\n'); child.emit('close', 0);
  let output = (first.details as { output: string }).output;
  let result;
  do {
    result = await tools[1]!.execute({ session_id: id, yield_time_ms: 100, max_output_tokens: 1 }, signal);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    output += (result.details as { output: string }).output;
  } while ((result.details as { remainingOutput: boolean; state: string }).remainingOutput || (result.details as { state: string }).state === 'running');
  assert.equal(output, 'progress\ntoken=[REDACTED]\n');
  await tools[0]!.lifecycle!.finishInvocation({ sessionId: 'session', invocationId: 'invocation' });
  assert.ok(!JSON.stringify(events).includes('synthetic-secret'));
  assert.equal(await readFile(logPath, 'utf8'), 'progress\ntoken=[REDACTED]\n');
});

test('tool parameter and completion audits redact JSON credentials and URL userinfo', async () => {
  for (const name of ['exec_command', 'write_stdin']) {
    const events: AgentAuditEvent[] = [];
    const value = '{"api_key":"synthetic-secret"}\nhttps://alice:synthetic-secret@example.invalid/repo';
    const [tool] = instrumentTools([{ name, description: 'Fixture', parameters: Type.Object({}),
      execute: async () => ({ content: 'ok', details: { command: value } }) }], 'session', 'recovery', { requestIndex: 0 },
    { append: async event => { events.push(event); } });
    await tool!.execute({ [name === 'write_stdin' ? 'chars' : 'cmd']: value }, new AbortController().signal);
    assert.ok(!JSON.stringify(events).includes('synthetic-secret'));
    assert.match(JSON.stringify(events), /REDACTED/);
  }
});
