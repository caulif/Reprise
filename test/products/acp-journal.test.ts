import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { createCandidateRuntimeSink } from '../../src/application/candidate-run-events.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { acpSessionUpdateEvents } from '../../src/products/shared/acp/events.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import { dshPackDefinition } from '../../src/products/packs/dsh/pack.js';

const FAKE_AGENT = `
import { writeFileSync } from 'node:fs';
const marker = process.argv[2];
const sessionId = 'session-journal-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
let turns = 0;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      continue;
    }
    if (message.method === 'session/new') {
      writeFileSync(marker, process.env.TEMP ?? '');
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      turns += 1;
      const update = (body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'message-' + turns, content: { type: 'text', text: 'reply to ' + message.params.prompt[0].text } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'call-' + turns, title: 'Read ping.txt', kind: 'read', status: 'completed' });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
  }
});
`;

test('an ACP tool update settles once instead of leaving a tool running forever', () => {
  const map = (update: Record<string, unknown>) => acpSessionUpdateEvents('s1', { sessionId: 's1', update }).map((event) => event.type);
  assert.deepEqual(map({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', status: 'completed' }), ['runtime.tool_finished']);
  assert.deepEqual(map({ sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'read', status: 'pending' }), ['runtime.tool_started']);
  assert.deepEqual(map({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress' }), []);
  assert.deepEqual(map({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed' }), ['runtime.tool_finished']);
});

test('ACP text and settlement reach the real Journal sink across two turns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-acp-agent.mjs');
  const marker = join(root, 'temporary-directory.txt');
  await writeFile(script, FAKE_AGENT);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script, marker] });
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-journal-1' });
  const runner = await pack.runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());

  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  assert.equal((await runner.waitForTurn()).status, 'completed');
  await runner.send({ id: 'second', text: 'second prompt' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'client-2' });
  assert.equal((await runner.waitForTurn()).status, 'completed');

  const recorded = store.events('run-1');
  assert.deepEqual(
    recorded.filter((event) => event.type === 'runtime.visible_output').map((event) => (event.payload as { text?: string }).text),
    ['reply to first prompt', 'reply to second prompt'],
  );
  assert.equal(recorded.filter((event) => event.type === 'runtime.runtime_failed').length, 0);
  assert.deepEqual(
    recorded.filter((event) => event.type === 'runtime.tool_finished').map((event) => (event.payload as { callId?: string }).callId),
    ['call-1', 'call-2'],
  );
  const temporaryDirectory = await readFile(marker, 'utf8');
  await access(temporaryDirectory);

  await runner.close();
  assert.deepEqual(store.events('run-1').slice(-2).map((event) => event.type), ['runtime.session_stopped', 'runtime.session_closed']);
  await assert.rejects(access(temporaryDirectory), { code: 'ENOENT' });
});
