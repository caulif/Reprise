import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { createCandidateRuntimeSink } from '../../src/application/candidate-run-events.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import type { TargetRunner } from '../../src/core/runtime.js';
import type { ProductPack } from '../../src/products/contract.js';
import { acpSessionUpdateEvents } from '../../src/products/shared/acp/events.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import { dshPackDefinition } from '../../src/products/packs/dsh/pack.js';
import { acpProjection } from '../../src/products/shared/acp/projection.js';

/** Answers every prompt with the same `toolCallId`, which is what a per-turn numbering agent sends. */
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
      update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read ping.txt', kind: 'read', status: 'completed' });
      // A second terminal report of the same id inside one turn must not reach the Journal twice.
      if (turns === 2) update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read ping.txt', kind: 'read', status: 'completed' });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
  }
});
`;

const DEAD_AGENT = 'process.exit(3);\n';

test('an ACP tool update settles once and never re-announces a running tool', () => {
  const map = (update: Record<string, unknown>) => acpSessionUpdateEvents('s1', { sessionId: 's1', update }).map((event) => event.type);
  assert.deepEqual(map({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'read', status: 'pending' }), ['runtime.tool_started']);
  assert.deepEqual(map({ sessionUpdate: 'tool_call', toolCallId: 'c2', kind: 'read', status: 'completed' }), ['runtime.tool_started', 'runtime.tool_finished']);
  assert.deepEqual(map({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'in_progress' }), []);
  assert.deepEqual(map({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed' }), ['runtime.tool_finished']);
});

test('a chunk without text never reaches the Journal', () => {
  const events = acpSessionUpdateEvents('s1', { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA' } } });
  assert.deepEqual(events, []);
});

test('a plan update persists the entry text and never the agent JSON', () => {
  const events = acpSessionUpdateEvents('s1', {
    sessionId: 's1',
    update: {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Read ping.txt', priority: 'high', status: 'pending' },
        { content: '   ', priority: 'low', status: 'completed' },
        { content: 'Write pong.txt', priority: 'medium', status: 'pending' },
      ],
    },
  });
  assert.deepEqual(events.map((event) => event.payload), [
    { sessionId: 's1', kind: 'plan', text: 'Read ping.txt\nWrite pong.txt' },
  ]);
  assert.deepEqual(acpSessionUpdateEvents('s1', {
    sessionId: 's1',
    update: { sessionUpdate: 'plan', entries: [{ priority: 'high', status: 'pending' }] },
  }), []);
});

test('ACP text and settlement reach the real Journal sink across three turns', async (t) => {
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
  for (const [index, turn] of ['second', 'third'].entries()) {
    await runner.send({ id: turn, text: `${turn} prompt` }, { runId: 'run-1', turnIndex: index + 1, clientMessageId: `client-${index + 2}` });
    assert.equal((await runner.waitForTurn()).status, 'completed');
  }

  const recorded = store.events('run-1');
  assert.deepEqual(
    recorded.filter((event) => event.type === 'runtime.visible_output').map((event) => (event.payload as { text?: string }).text),
    ['reply to first prompt', 'reply to second prompt', 'reply to third prompt'],
  );
  // The agent reuses `call-1` every turn: each turn's tool is still recorded, once per turn.
  const callIds = (type: string) => recorded.filter((event) => event.type === type).map((event) => (event.payload as { callId?: string }).callId);
  assert.deepEqual(callIds('runtime.tool_started'), ['client-1:call-1', 'client-2:call-1', 'client-3:call-1']);
  assert.deepEqual(callIds('runtime.tool_finished'), ['client-1:call-1', 'client-2:call-1', 'client-3:call-1']);
  assert.equal(recorded.filter((event) => event.type === 'runtime.runtime_failed').length, 0);
  const temporaryDirectory = await readFile(marker, 'utf8');
  await access(temporaryDirectory);

  await runner.close();
  assert.deepEqual(store.events('run-1').slice(-2).map((event) => event.type), ['runtime.session_stopped', 'runtime.session_closed']);
  await assert.rejects(access(temporaryDirectory), { code: 'ENOENT' });
});

test('an agent that dies before session/new leaves a session_failed row instead of silence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-dead-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'dead-acp-agent.mjs');
  await writeFile(script, DEAD_AGENT);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script] });
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-journal-1' });
  const runner = await pack.runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());

  await assert.rejects(runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' }), /ACP agent/);
  await runner.close();
  assert.deepEqual(store.events('run-1').map((event) => event.type), ['runtime.session_failed']);
});

/** Prints a credential on stderr, which is persisted into the run journal unless the client redacts it first. */
const LEAKING_AGENT = "process.stderr.write('fatal: Authorization: Bearer ' + 'A'.repeat(40) + '\\n', () => process.exit(9));\n";

test('stderr reaches the Journal redacted, never as the credential the agent printed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-stderr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'leaky-acp-agent.mjs');
  await writeFile(script, LEAKING_AGENT);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script] });
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-journal-1' });
  const runner = await pack.runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());

  await assert.rejects(runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' }), /ACP agent/);
  await runner.close();
  const journal = JSON.stringify(store.events('run-1'));
  assert.match(journal, /\[REDACTED\]/);
  assert.doesNotMatch(journal, /A{40}/);
});

/** Offers only a reject option, so the client must answer `cancelled` instead of blocking the turn. */
const DENYING_AGENT = `
import { appendFileSync } from 'node:fs';
const logPath = process.argv[2];
const sessionId = 'session-deny-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
let promptId;
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      promptId = message.id;
      const update = (body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'call-deny', title: 'Write ping.txt', kind: 'edit', status: 'pending' });
      send({ jsonrpc: '2.0', id: 7001, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-deny', title: 'Write ping.txt', kind: 'edit' }, options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
      continue;
    }
    if (message.id === 7001) {
      appendFileSync(logPath, JSON.stringify(message.result) + '\\n');
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

test('a permission request without an allow option is answered cancelled and counts as one rejected approval', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-deny-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'denying-acp-agent.mjs');
  const logPath = join(root, 'permission.log');
  await writeFile(script, DENYING_AGENT);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script, logPath] });
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-deny-1' });
  const runner = await pack.runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());

  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  assert.equal((await runner.waitForTurn()).status, 'completed');
  assert.deepEqual(JSON.parse((await readFile(logPath, 'utf8')).trim()), { outcome: { outcome: 'cancelled' } });

  const events = store.events('run-1');
  const denials = events.filter((event) => event.type === 'runtime.tool_finished'
    && (event.payload as { permissionDecision?: string }).permissionDecision === 'cancelled');
  assert.equal(denials.length, 1);
  assert.equal((denials[0]?.payload as { callId?: string }).callId, 'client-1:call-deny');
  assert.equal(acpProjection.inspectRunFacts(events).rejectedApprovals, 1);
  // A denied approval is not a runtime failure: the turn settled normally and nothing was attributed to a failure.
  assert.equal(events.filter((event) => event.type === 'runtime.runtime_failed').length, 0);

  await runner.close();
});

/** Reports turn 1's tool as finished only after turn 2 started, then reuses the same `toolCallId` inside turn 2. */
const LATE_TOOL_AGENT = `
const sessionId = 'session-late-1';
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      turns += 1;
      const update = (body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
      if (turns === 1) {
        update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read ping.txt', kind: 'read', status: 'pending' });
      } else {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
        update({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read pong.txt', kind: 'read', status: 'pending' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' });
      }
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      continue;
    }
  }
});
`;

test('a tool update that arrives after its turn settled never hides the next turn reusing the same id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-late-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'late-acp-agent.mjs');
  await writeFile(script, LATE_TOOL_AGENT);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script] });
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-late-1' });
  const runner = await pack.runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());

  try {
    await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
    assert.equal((await runner.waitForTurn()).status, 'completed');
    await runner.send({ id: 'second', text: 'second prompt' }, { runId: 'run-1', turnIndex: 1, clientMessageId: 'client-2' });
    assert.equal((await runner.waitForTurn()).status, 'completed');

    const events = store.events('run-1');
    const calls = (type: string) => events
      .filter((event) => event.type === type)
      .map((event) => event.payload as { callId?: string; title?: string });
    // The turn-2 announcement survives even though a late turn-1 update reused its id first.
    assert.deepEqual(calls('runtime.tool_started').map((payload) => payload.callId), ['client-1:call-1', 'client-2:call-1']);
    assert.deepEqual(calls('runtime.tool_started').map((payload) => payload.title), ['Read ping.txt', 'Read pong.txt']);
    // Exactly one settle: the late update for the settled turn is dropped instead of finishing turn 2's call.
    assert.deepEqual(calls('runtime.tool_finished').map((payload) => payload.callId), ['client-2:call-1']);
  } finally {
    await runner.close();
  }
});

type JournalRun = {
  store: ExperimentStore;
  runner: TargetRunner;
  root: string;
  script: string;
};

/** Opens a real Journal-backed ACP run; `buildPack` may replace the pack to pin how the agent is spawned. */
async function openJournalRun(
  t: TestContext,
  agent: string,
  buildPack: (script: string, root: string) => ProductPack = (script) =>
    createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script] }),
): Promise<JournalRun> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-acp-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-acp-agent.mjs');
  await writeFile(script, agent);
  const store = await ExperimentStore.open(join(root, 'experiment'), 'exp-1');
  await store.acquireWriter();
  t.after(() => store.close());
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const sink = createCandidateRuntimeSink({ journal: store, runId: 'run-1', sessionId: () => 'session-journal-1' });
  const runner = await buildPack(script, root).runtime.createRunner(resolved, environment, sink, candidateLaunchFor(resolved, environment));
  t.after(() => runner.close());
  return { store, runner, root, script };
}

/** Asks for permission before announcing the call: the one order `#startedCalls` cannot have observed. */
const UNANNOUNCED_PERMISSION_AGENT = `
const sessionId = 'session-journal-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
let promptId;
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      promptId = message.id;
      send({ jsonrpc: '2.0', id: 7002, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-silent', title: 'Write ping.txt', kind: 'edit' }, options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
      continue;
    }
    if (message.id === 7002) send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
});
`;

test('a permission request that arrives before any tool_call still records the denial', async (t) => {
  const { store, runner } = await openJournalRun(t, UNANNOUNCED_PERMISSION_AGENT);
  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  assert.equal((await runner.waitForTurn()).status, 'completed');
  const events = store.events('run-1');
  // The Host answered the request itself, so the denial is evidence even though no tool_call preceded it.
  assert.equal(events.filter((event) => event.type === 'runtime.tool_started').length, 0);
  const denials = events.filter((event) => event.type === 'runtime.tool_finished'
    && (event.payload as { permissionDecision?: string }).permissionDecision === 'cancelled');
  assert.equal(denials.length, 1);
  assert.equal((denials[0]?.payload as { callId?: string }).callId, 'client-1:call-silent');
  assert.equal(acpProjection.inspectRunFacts(events).rejectedApprovals, 1);
  await runner.close();
});

/** Answers the denial, then reports the same call as failed: the Host already recorded that terminal state. */
const DENY_THEN_FAIL_AGENT = `
const sessionId = 'session-journal-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
let promptId;
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      promptId = message.id;
      const update = (body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'call-deny', title: 'Write ping.txt', kind: 'edit', status: 'pending' });
      send({ jsonrpc: '2.0', id: 7003, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-deny', title: 'Write ping.txt', kind: 'edit' }, options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }] } });
      continue;
    }
    if (message.id === 7003) {
      // What a real agent does after a cancelled approval: it reports the call as failed a second time.
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-deny', status: 'failed' } } });
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

test('a denied call reported as failed a second time never duplicates the denial row', async (t) => {
  const { store, runner } = await openJournalRun(t, DENY_THEN_FAIL_AGENT);
  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  assert.equal((await runner.waitForTurn()).status, 'completed');
  const events = store.events('run-1');
  const finished = events.filter((event) => event.type === 'runtime.tool_finished');
  assert.equal(finished.length, 1);
  assert.equal((finished[0]?.payload as { permissionDecision?: string }).permissionDecision, 'cancelled');
  assert.equal(events.filter((event) => event.type === 'runtime.runtime_failed').length, 0);
  assert.equal(acpProjection.inspectRunFacts(events).rejectedApprovals, 1);
  await runner.close();
});

test('the declared ACP argv reaches the agent when the pack configures no explicit argv', async (t) => {
  const { store, runner } = await openJournalRun(t, FAKE_AGENT, (script, root) => createAcpPack(
    { ...dshPackDefinition, command: 'node', acpArgs: [script, join(root, 'temporary-directory.txt')], executableEnvKey: 'REPRISE_TEST_ACP_ARGV' },
    { executable: process.execPath },
  ));
  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  assert.equal((await runner.waitForTurn()).status, 'completed');
  assert.deepEqual(
    store.events('run-1').filter((event) => event.type === 'runtime.visible_output').map((event) => (event.payload as { text?: string }).text),
    ['reply to first prompt'],
  );
  await runner.close();
});

/** Fails the prompt with an upstream error that echoes a credential. */
const CREDENTIAL_ERROR_AGENT = `
const sessionId = 'session-journal-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'upstream 401: invalid api key sk-' + 'B'.repeat(32) } });
    }
  }
});
`;

test('an agent error frame reaches the run outcome redacted', async (t) => {
  const { runner } = await openJournalRun(t, CREDENTIAL_ERROR_AGENT);
  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  await assert.rejects(runner.waitForTurn(), (error: unknown) => {
    assert.match(String(error), /\[REDACTED\]/);
    assert.doesNotMatch(String(error), /B{32}/);
    return true;
  });
  await runner.close();
});

/** Settles the prompt with a stopReason the client cannot map, carrying a credential. */
const CREDENTIAL_STOP_AGENT = `
const sessionId = 'session-journal-1';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
      continue;
    }
    if (message.method === 'session/cancel') continue;
    if (message.method === 'session/prompt') {
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'sk-' + 'C'.repeat(32) } });
    }
  }
});
`;

test('an unrecognized stopReason is redacted in the Journal and in the error', async (t) => {
  const { store, runner } = await openJournalRun(t, CREDENTIAL_STOP_AGENT);
  await runner.start({ id: 'first', text: 'first prompt' }, { runId: 'run-1', turnIndex: 0, clientMessageId: 'client-1' });
  await assert.rejects(runner.waitForTurn(), (error: unknown) => {
    assert.doesNotMatch(String(error), /C{32}/);
    return true;
  });
  // `close()` flushes the in-flight append the failed settlement left behind.
  await runner.close();
  const failed = store.events('run-1').filter((event) => event.type === 'runtime.runtime_failed');
  assert.equal(failed.length, 1);
  assert.equal((failed[0]?.payload as { stopReason?: string }).stopReason, '[REDACTED]');
});
