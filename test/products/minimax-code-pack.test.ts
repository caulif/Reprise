import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { sha256 } from '../../src/core/identity.js';
import { record, text } from '../../src/core/json.js';
import type { TargetEvent, TargetRunner } from '../../src/core/runtime.js';
import type { ProductAuthStatus } from '../../src/products/contract.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import { minimaxCodeDefinition, minimaxCodeProductPack } from '../../src/products/packs/minimax-code/pack.js';

const DEFAULT_MODEL = 'custom_provider:local-anthropic-proxy/deepseek/deepseek-v4.1-flash';
const CLIENT_MESSAGE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const FAKE_MCODE = `
import { appendFileSync } from 'node:fs';

const mode = process.argv[2] ?? 'end_turn';
const logPath = process.argv[3];
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let buffer = '';
let promptId;

function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session-1' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'Fake ACP reply.' } } } });
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: 'fake-session-1', toolCall: { toolCallId: 'call-1', title: 'Write ping.txt', kind: 'edit' }, options: [{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }, { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' }] } });
    return;
  }
  if (message.method === 'session/cancel') {
    process.exit(0);
  }
  if (message.id === 900) {
    if (logPath) appendFileSync(logPath, JSON.stringify(message.result) + '\\n');
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: mode === 'cancelled' ? 'cancelled' : 'end_turn' } });
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

test('MiniMax Code pack declares the ACP argv, data root, and runtime-only capability', () => {
  assert.equal(minimaxCodeProductPack.manifest.productId, 'minimax-code');
  assert.equal(minimaxCodeProductPack.manifest.displayName, 'MiniMax Code');
  assert.deepEqual(minimaxCodeProductPack.manifest.capabilities, ['runtime']);
  assert.equal(minimaxCodeProductPack.manifest.apiMajor, 3);
  assert.equal(minimaxCodeProductPack.manifest.packVersion, '0.1.0');
  assert.equal(minimaxCodeProductPack.runtime.id, 'minimax-code');
  assert.equal(minimaxCodeDefinition.command, 'mcode');
  assert.deepEqual(minimaxCodeDefinition.acpArgs, ['acp']);
  assert.equal(minimaxCodeDefinition.executableEnvKey, 'REPRISE_MCODE_EXECUTABLE');
  assert.equal(minimaxCodeDefinition.envRole, 'acp');
  // The data root is `~/.minimax`, not `~/.mcode`; MINIMAX_DATA_DIR only overrides it at launch.
  assert.match(minimaxCodeProductPack.history.defaultRoot, /[\\/]\.minimax$/);
});

test('the default candidate follows the model mcode is locally configured with', () => {
  assert.deepEqual(minimaxCodeProductPack.defaultCandidate(), {
    candidateId: 'minimax-code-default',
    productId: 'minimax-code',
    requestedModel: DEFAULT_MODEL,
  });
});

test('the MiniMax Code recovery playbook is versioned, hashed, and shipped with the source', async () => {
  const playbook = minimaxCodeProductPack.recoveryPlaybook();
  assert.equal(playbook.version, 'minimax-code-recovery/v1');
  assert.ok(playbook.text.trim().length > 0);
  assert.match(playbook.sha256, /^[0-9a-f]{64}$/);
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.match(playbook.text, /MINIMAX_DATA_DIR/);
  assert.match(playbook.text, /~\/\.minimax/);
  assert.match(playbook.text, /request_permission/);
  const shipped = await readFile(new URL('../../src/products/packs/minimax-code/recovery/SKILL.md', import.meta.url), 'utf8');
  assert.equal(shipped, playbook.text);
});

test('checkAuth reports local configuration presence without claiming a runnable account', async () => {
  const status: ProductAuthStatus | undefined = await minimaxCodeProductPack.checkAuth?.();
  assert.ok(status);
  assert.equal(status.provider, 'minimax-code');
  assert.equal(typeof status.configured, 'boolean');
  if (status.configured) {
    assert.equal(status.source, 'config.yaml');
    assert.equal(status.detail, 'local-configuration-present');
  } else {
    assert.equal(status.source, undefined);
    assert.match(status.detail ?? '', /No local credential or configuration file found \(config\.yaml\)/);
  }
});

test('history discovery degrades to an empty page with an explicit diagnostic', async () => {
  const page = await minimaxCodeProductPack.history.discover();
  assert.deepEqual(page.items, []);
  assert.equal(page.scanned, 0);
  assert.equal(page.skipped, 0);
  assert.deepEqual(page.diagnostics, [{ code: 'catalog-unavailable', count: 1 }]);
  const ref = { productId: 'minimax-code', sessionId: 'fake-session-1' };
  await assert.rejects(minimaxCodeProductPack.history.inspect(ref), /history import is not implemented/);
  await assert.rejects(minimaxCodeProductPack.history.import(ref), /declares the runtime capability only/);
});

test('the runtime publishes the default candidate as the only catalog offer and reports executable discovery honestly', async () => {
  const offers = await minimaxCodeProductPack.runtime.listCatalog();
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.value, minimaxCodeProductPack.defaultCandidate().requestedModel);
  assert.equal(offers[0]?.displayName, 'MiniMax Code default model');

  const installed = createAcpPack(minimaxCodeDefinition, { executable: process.execPath });
  const [found] = await installed.runtime.inspectAvailability();
  assert.equal(found?.productId, 'minimax-code');
  assert.equal(found?.status, 'available');
  assert.equal(found?.executable, process.execPath);

  const missing = createAcpPack(minimaxCodeDefinition, { env: {} });
  const [absent] = await missing.runtime.inspectAvailability();
  assert.equal(absent?.status, 'not_installed');
  assert.equal(absent?.executable, undefined);
  assert.match(absent?.installHint ?? '', /REPRISE_MCODE_EXECUTABLE/);
  assert.deepEqual(await missing.runtime.inspectAvailable(), []);
});

test('an end_turn prompt settles natively and Reprise answers the permission request with the allow option', async (t) => {
  const { runner, events, permissionLog } = await fakeMcpRunner(t, 'end_turn');
  assert.equal(runner.capabilities().nativeTurnSettlement, true);
  assert.equal(runner.capabilities().tokenTelemetry, 'none');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: CLIENT_MESSAGE_ID },
  );
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(receipt.evidence, 'preflight');
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'end_turn' }]);

  assert.deepEqual(JSON.parse((await readFile(permissionLog, 'utf8')).trim()), {
    outcome: { outcome: 'selected', optionId: 'allow-always' },
  });

  await waitFor(() => events.some((event) => event.type === 'runtime.visible_output'));
  const output = events.find((event) => event.type === 'runtime.visible_output');
  assert.equal(text(record(output?.payload).text), 'Fake ACP reply.');
  assert.ok(events.some((event) => event.type === 'runtime.session_started'));

  await runner.close();
  assert.equal(events.at(-1)?.type, 'runtime.session_closed');
  assert.equal(events.some((event) => event.type === 'runtime.runtime_failed'), false);
});

test('a cancelled prompt settles as aborted instead of completed', async (t) => {
  const { runner } = await fakeMcpRunner(t, 'cancelled');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: CLIENT_MESSAGE_ID },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'aborted');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'cancelled' }]);
});

async function fakeMcpRunner(
  t: { after(fn: () => Promise<unknown>): void },
  mode: 'end_turn' | 'cancelled',
): Promise<{ runner: TargetRunner; events: TargetEvent[]; permissionLog: string }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-mcode-'));
  const script = join(root, 'fake-mcode.mjs');
  const permissionLog = join(root, 'permission.log');
  await writeFile(script, FAKE_MCODE);
  const pack = createAcpPack(minimaxCodeDefinition, { executable: process.execPath, args: [script, mode, permissionLog] });
  const events: TargetEvent[] = [];
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const resolved = { productId: 'minimax-code', executable: process.execPath, requestedModel: DEFAULT_MODEL, resolvedModel: 'unknown' };
  const runner = await pack.runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event); } },
    candidateLaunchFor(resolved, environment),
  );
  t.after(async () => {
    try {
      await runner.stop('shutdown');
    } catch {
      /* The test already closed this runner; the process is gone, so a second stop only fails on a dead pipe. */
    }
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { runner, events, permissionLog };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate());
}
