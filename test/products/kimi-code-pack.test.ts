import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { sha256 } from '../../src/core/identity.js';
import { record } from '../../src/core/json.js';
import type { ResolvedRuntime, TargetEvent, TargetRunner } from '../../src/core/runtime.js';
import { kimiCodePackDefinition, kimiCodeProductPack } from '../../src/products/packs/kimi-code/pack.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';

const SESSION_ID = 'kimi-session-1';

/** Minimal ACP agent: one session, one assistant chunk, one permission round trip, one stop reason. */
const FAKE_KIMI = `
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'end_turn';
const logPath = process.argv[3];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const answers = new Map();
let nextRequestId = 100;
const askPermission = () => new Promise((resolve) => {
  const id = nextRequestId++;
  answers.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: '${SESSION_ID}',
    toolCall: { toolCallId: 'call-1', title: 'npm test', kind: 'execute', status: 'pending' },
    options: [
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    ],
  } });
});
const onPrompt = async (id) => {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: '${SESSION_ID}', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Kimi Code finished the turn.' } } } });
  const answer = await askPermission();
  if (logPath) appendFileSync(logPath, JSON.stringify(answer) + '\\n');
  reply(id, { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn' });
};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.method === undefined) {
      const resolve = answers.get(frame.id);
      if (resolve) { answers.delete(frame.id); resolve(frame); }
      continue;
    }
    if (frame.method === 'initialize') { reply(frame.id, { protocolVersion: 1, agentCapabilities: {} }); continue; }
    if (frame.method === 'session/new') { reply(frame.id, { sessionId: '${SESSION_ID}' }); continue; }
    if (frame.method === 'session/cancel') continue;
    if (frame.method === 'session/prompt') void onPrompt(frame.id);
  }
});
process.stdin.on('end', () => process.exit(0));
`;

test('Kimi Code pack declares a runtime-only ACP manifest', () => {
  assert.equal(kimiCodeProductPack.manifest.productId, 'kimi-code');
  assert.equal(kimiCodeProductPack.manifest.displayName, 'Kimi Code');
  assert.deepEqual(kimiCodeProductPack.manifest.capabilities, ['runtime']);
  assert.equal(kimiCodeProductPack.manifest.apiMajor, 3);
  assert.equal(kimiCodeProductPack.runtime.id, 'kimi-code');
});

test('Kimi Code default candidate is the declared spec', () => {
  assert.deepEqual(kimiCodeProductPack.defaultCandidate(), {
    candidateId: 'kimi-code-default',
    productId: 'kimi-code',
    requestedModel: 'kimi-k2.7-code',
  });
});

test('Kimi Code Recovery Playbook has stable provenance and is included in source', async () => {
  const playbook = kimiCodeProductPack.recoveryPlaybook();
  assert.equal(playbook.version, 'kimi-code-recovery/v1');
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.match(playbook.sha256, /^[0-9a-f]{64}$/);
  assert.ok(playbook.text.length > 0);
  assert.match(playbook.text, /\.kimi-code\/sessions/);
  const built = await readFile(new URL('../../src/products/packs/kimi-code/recovery/SKILL.md', import.meta.url), 'utf8');
  assert.equal(built, playbook.text);
});

test('Kimi Code auth status never claims more than local file presence', async () => {
  const status = await kimiCodeProductPack.checkAuth?.();
  assert.ok(status);
  assert.equal(status.provider, 'kimi-code');
  if (status.configured) {
    assert.equal(status.detail, 'local-configuration-present');
    assert.ok(['server.token', 'config.toml'].includes(status.source ?? ''), status.source);
  } else {
    assert.equal(status.source, undefined);
    assert.match(status.detail ?? '', /No local credential or configuration file found/);
  }
});

test('Kimi Code history is runtime-only and degrades discovery instead of guessing', async () => {
  assert.equal(kimiCodeProductPack.history.defaultRoot, join(homedir(), '.kimi-code'));
  const page = await kimiCodeProductPack.history.discover();
  assert.deepEqual(page.items, []);
  assert.equal(page.scanned, 0);
  assert.ok(page.diagnostics.some((diagnostic) => diagnostic.code === 'catalog-unavailable'));
  const ref = { productId: 'kimi-code', sessionId: 'session-1' };
  await assert.rejects(kimiCodeProductPack.history.inspect(ref), /history import is not implemented/);
  await assert.rejects(kimiCodeProductPack.history.import(ref), /history import is not implemented/);
});

test('Kimi Code runtime exposes no catalog and reports availability from executable discovery', async () => {
  assert.deepEqual(await kimiCodeProductPack.runtime.listCatalog(), []);

  const injected = createAcpPack(kimiCodePackDefinition, { executable: process.execPath, version: '2.1.1' });
  const [available] = await injected.runtime.inspectAvailability();
  assert.equal(available?.status, 'available');
  assert.equal(available?.executable, process.execPath);
  assert.equal(available?.observedVersion, '2.1.1');
  assert.equal((await injected.runtime.inspectAvailable())[0]?.executable, process.execPath);

  const undiscoverable = createAcpPack(kimiCodePackDefinition, { env: { PATH: '' } });
  const [missing] = await undiscoverable.runtime.inspectAvailability();
  assert.equal(missing?.status, 'not_installed');
  assert.match(missing?.installHint ?? '', /REPRISE_KIMI_EXECUTABLE/);
  await assert.rejects(
    undiscoverable.runtime.resolve({ productId: 'kimi-code', requestedModel: 'kimi-k2.7-code' }),
    /Install Kimi Code/,
  );
});

test('a Kimi Code ACP turn settles natively, auto-answers the permission request, and closes', async (t) => {
  const { runner, events, logPath } = await kimiRunner(t, 'end_turn');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Run the test suite.' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'message-1' },
  );
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(receipt.evidence, 'preflight');

  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'end_turn' }]);

  const output = events.find((event) => event.type === 'runtime.visible_output');
  assert.ok(output);
  assert.equal(record(output.payload).text, 'Kimi Code finished the turn.');
  assert.equal(record(output.payload).sessionId, SESSION_ID);
  assert.ok(events.some((event) => event.type === 'runtime.session_started'));

  const answers = await readFile(logPath, 'utf8');
  assert.match(answers, /"outcome":"selected"/);
  assert.match(answers, /"optionId":"allow-once"/);
  assert.doesNotMatch(answers, /reject-once/);

  await runner.close();
  assert.ok(events.some((event) => event.type === 'runtime.session_closed'));
  assert.equal(events.some((event) => event.type === 'runtime.runtime_failed'), false);
});

test('a cancelled Kimi Code stopReason maps to an aborted turn', async (t) => {
  const { runner } = await kimiRunner(t, 'cancelled');
  await runner.start(
    { id: 'message-1', text: 'Run the test suite.' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'message-1' },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'aborted');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'cancelled' }]);
});

async function kimiRunner(
  t: { after(fn: () => Promise<unknown>): void },
  mode: string,
): Promise<{ runner: TargetRunner; events: TargetEvent[]; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-kimi-pack-'));
  const script = join(root, 'fake-kimi.mjs');
  const logPath = join(root, 'permission-answers.jsonl');
  await writeFile(script, FAKE_KIMI);
  const pack = createAcpPack(kimiCodePackDefinition, {
    executable: process.execPath,
    args: [script, mode, logPath],
  });
  const events: TargetEvent[] = [];
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const resolved: ResolvedRuntime = {
    productId: 'kimi-code',
    executable: process.execPath,
    requestedModel: 'kimi-k2.7-code',
    resolvedModel: 'unknown',
  };
  const runner = await pack.runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event); } },
    candidateLaunchFor(resolved, environment),
  );
  t.after(async () => { await runner.close().catch(() => undefined); });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { runner, events, logPath };
}
