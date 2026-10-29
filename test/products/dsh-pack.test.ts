import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/core/identity.js';
import type { TargetEvent, TargetRunner } from '../../src/core/runtime.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import type { ProductAuthStatus } from '../../src/products/contract.js';
import { dshPackDefinition, dshProductPack } from '../../src/products/packs/dsh/pack.js';

const CLIENT_MESSAGE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const FAKE_ACP_AGENT = `
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'end_turn';
const logPath = process.argv[3];
const sessionId = 'session-dsh-1';
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
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'Created ping.txt' } } } });
      send({ jsonrpc: '2.0', id: 9001, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'call-1', title: 'Write ping.txt', kind: 'edit' }, options: [{ optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }, { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }] } });
      continue;
    }
    if (message.id === 9001) {
      if (logPath) appendFileSync(logPath, JSON.stringify(message.result) + '\\n');
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn' } });
    }
  }
});
`;

test('DeepSeek Harness pack declares the ACP runtime capability only', () => {
  assert.equal(dshProductPack.manifest.productId, 'dsh');
  assert.equal(dshProductPack.manifest.displayName, 'DeepSeek Harness');
  assert.equal(dshProductPack.manifest.apiMajor, 3);
  assert.equal(dshProductPack.manifest.packVersion, '0.1.0');
  assert.deepEqual(dshProductPack.manifest.capabilities, ['runtime']);
  assert.equal(dshProductPack.runtime.id, 'dsh');
  assert.equal(dshPackDefinition.command, 'dsh');
  assert.equal(dshPackDefinition.executableEnvKey, 'REPRISE_DSH_EXECUTABLE');
  assert.deepEqual([...dshPackDefinition.acpArgs], ['--profile', 'acp']);
});

test('the declared default candidate is returned unchanged', () => {
  assert.deepEqual(dshProductPack.defaultCandidate(), {
    candidateId: 'dsh-deepseek',
    productId: 'dsh',
    requestedModel: 'deepseek-v4-flash',
  });
});

test('DeepSeek Harness recovery playbook has stable provenance and ships with the pack', async () => {
  const playbook = dshProductPack.recoveryPlaybook();
  assert.equal(playbook.version, 'dsh-recovery/v1');
  assert.ok(playbook.text.trim().length > 0);
  assert.match(playbook.sha256, /^[0-9a-f]{64}$/);
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.match(playbook.text, /~\/\.dsh/);
  assert.match(playbook.text, /sessions\//);
  assert.match(playbook.text, /History import is not implemented/);
  assert.match(playbook.text, /session\/request_permission/);
  assert.match(playbook.text, /stopReason/);
  assert.match(playbook.text, /configOptions/);
  assert.match(playbook.text, /sessionCapabilities/);
  const built = await readFile(new URL('../../src/products/packs/dsh/recovery/SKILL.md', import.meta.url), 'utf8');
  assert.equal(built, playbook.text);
});

test('checkAuth reports local dsh configuration without claiming a runnable account', async () => {
  const status: ProductAuthStatus | undefined = await dshProductPack.checkAuth?.();
  assert.ok(status);
  assert.equal(status.provider, 'dsh');
  assert.equal(typeof status.configured, 'boolean');
  if (status.configured) {
    assert.equal(status.source, '.credentials.yaml');
    assert.equal(status.detail, 'local-configuration-present');
  } else {
    assert.equal(status.source, undefined);
    assert.match(status.detail ?? '', /No local credential or configuration file found \(\.credentials\.yaml\)/);
  }
});

test('dsh history stays unimplemented instead of inventing a session catalog', async () => {
  const page = await dshProductPack.history.discover();
  assert.deepEqual(page.items, []);
  assert.equal(page.scanned, 0);
  assert.equal(page.skipped, 0);
  assert.deepEqual(page.diagnostics, [{ code: 'catalog-unavailable', count: 1 }]);
  assert.equal(dshProductPack.history.defaultRoot, join(homedir(), '.dsh'));
  const ref = { productId: 'dsh', sessionId: 'session-1' };
  await assert.rejects(dshProductPack.history.inspect(ref), /history import is not implemented/);
  await assert.rejects(dshProductPack.history.import(ref), /history import is not implemented/);
});

test('dsh publishes its default candidate as the only catalog offer and separates an injected executable from a missing CLI', async () => {
  const offers = await dshProductPack.runtime.listCatalog();
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.value, dshProductPack.defaultCandidate().requestedModel);
  assert.equal(offers[0]?.displayName, 'DeepSeek Harness default model');
  const installed = createAcpPack(dshPackDefinition, { executable: process.execPath });
  const [available] = await installed.runtime.inspectAvailability();
  assert.equal(available?.status, 'available');
  assert.equal(available?.executable, process.execPath);
  const resolved = await installed.runtime.resolve({ productId: 'dsh', requestedModel: 'deepseek-v4-flash' });
  assert.equal(resolved.resolvedModel, 'unknown');
  await assert.rejects(
    installed.runtime.resolve({ productId: 'claude-code', requestedModel: 'sonnet' }),
    /unavailable in DeepSeek Harness mode/,
  );
  const absent = createAcpPack(dshPackDefinition, { env: {} });
  const [missing] = await absent.runtime.inspectAvailability();
  assert.equal(missing?.status, 'not_installed');
  assert.match(missing?.installHint ?? '', /REPRISE_DSH_EXECUTABLE/);
});

test('a fake ACP agent settles natively, streams text, and gets its permission request answered', async (t) => {
  const { runner, events, logPath } = await fakeAcpRunner(t, 'end_turn');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: CLIENT_MESSAGE_ID },
  );
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(receipt.evidence, 'preflight');
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.confidence, 'native');
  assert.equal(settlement.turnId, CLIENT_MESSAGE_ID);
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'end_turn' }]);

  const answered = JSON.parse((await readFile(logPath, 'utf8')).trim()) as unknown;
  assert.deepEqual(answered, { outcome: { outcome: 'selected', optionId: 'allow_once' } });

  const output = events.find((event) => event.type === 'runtime.visible_output');
  assert.equal((output?.payload as { text?: string } | undefined)?.text, 'Created ping.txt');
  assert.ok(events.some((event) => event.type === 'runtime.session_started'));
  assert.equal(runner.session().sessionId, 'session-dsh-1');
  assert.equal(runner.capabilities().tokenTelemetry, 'none');
  assert.equal(runner.capabilities().reconnectSession, false);
  assert.equal(runner.capabilities().nativeTurnSettlement, true);

  await runner.close();
  assert.equal(events.at(-1)?.type, 'runtime.session_closed');
});

test('a cancelled stopReason settles the turn as aborted', async (t) => {
  const { runner } = await fakeAcpRunner(t, 'cancelled');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: CLIENT_MESSAGE_ID },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'aborted');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'cancelled' }]);
});

async function fakeAcpRunner(
  t: { after(fn: () => Promise<unknown>): void },
  mode: string,
): Promise<{ runner: TargetRunner; events: TargetEvent[]; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-dsh-'));
  const script = join(root, 'fake-acp-agent.mjs');
  const logPath = join(root, 'permission.log');
  await writeFile(script, FAKE_ACP_AGENT);
  const pack = createAcpPack(dshPackDefinition, { executable: process.execPath, args: [script, mode, logPath] });
  const events: TargetEvent[] = [];
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const resolved = { productId: 'dsh', executable: process.execPath, requestedModel: 'deepseek-v4-flash', resolvedModel: 'unknown' };
  const runner = await pack.runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event); } },
    candidateLaunchFor(resolved, environment),
  );
  t.after(async () => {
    await runner.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { runner, events, logPath };
}
