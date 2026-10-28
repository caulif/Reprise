import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../../src/core/identity.js';
import type { TargetEvent, TargetRunner } from '../../src/core/runtime.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { createAcpPack } from '../../src/products/shared/acp/pack.js';
import { qwenCodePackDefinition, qwenCodeProductPack } from '../../src/products/packs/qwen-code/pack.js';

const MODEL = 'deepseek/deepseek-v4.1-flash';
const SESSION_ID = 'fake-qwen-session';

/** Newline-delimited JSON-RPC ACP agent: initialize, session/new, one prompt turn, one permission prompt. */
const FAKE_ACP = String.raw`
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'end_turn';
const sessionId = '${SESSION_ID}';
const logPath = process.env.QWEN_FAKE_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const log = (line) => { if (logPath) appendFileSync(logPath, line + '\n'); };
const PERMISSION_ID = 1000;
let pendingPromptId;
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === 'session/new') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
    } else if (message.method === 'session/cancel') {
      log('cancel');
    } else if (message.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'Wrote ping.txt.' } } } });
      if (mode === 'cancelled') {
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'cancelled' } });
      } else {
        pendingPromptId = message.id;
        send({
          jsonrpc: '2.0',
          id: PERMISSION_ID,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { toolCallId: 'call-1', title: 'Write ping.txt' },
            options: [
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            ],
          },
        });
      }
    } else if (message.id === PERMISSION_ID && pendingPromptId !== undefined) {
      const outcome = message.result?.outcome ?? {};
      log('permission:' + (outcome.outcome ?? 'missing') + ':' + (outcome.optionId ?? 'none'));
      const promptId = pendingPromptId;
      pendingPromptId = undefined;
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    }
  }
});
`;

test('Qwen Code pack declares a runtime-only ACP manifest', () => {
  const { manifest } = qwenCodeProductPack;
  assert.equal(manifest.productId, 'qwen-code');
  assert.equal(manifest.displayName, 'Qwen Code');
  assert.equal(manifest.packVersion, '0.1.0');
  assert.deepEqual(manifest.capabilities, ['runtime']);
  assert.equal(manifest.apiMajor, 3);
  assert.equal(qwenCodeProductPack.runtime.id, 'qwen-code');
});

test('Qwen Code starts the agent with the --acp flag and follows the locally configured model', () => {
  assert.deepEqual(qwenCodePackDefinition.acpArgs, ['--acp']);
  assert.equal(qwenCodePackDefinition.acpArgs.includes('acp'), false);
  assert.equal(qwenCodePackDefinition.executableEnvKey, 'REPRISE_QWEN_EXECUTABLE');
  assert.deepEqual(qwenCodeProductPack.defaultCandidate(), {
    candidateId: 'qwen-code-default',
    productId: 'qwen-code',
    requestedModel: MODEL,
  });
});

test('Qwen Code recovery playbook has stable provenance and ships with the pack', async () => {
  const playbook = qwenCodeProductPack.recoveryPlaybook();
  assert.equal(playbook.version, 'qwen-code-recovery/v1');
  assert.match(playbook.sha256, /^[0-9a-f]{64}$/);
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.ok(playbook.text.trim().length > 0);
  assert.match(playbook.text, /--acp/);
  assert.match(playbook.text, /catalog-unavailable/);
  const shipped = await readFile(new URL('../../src/products/packs/qwen-code/recovery/SKILL.md', import.meta.url), 'utf8');
  assert.equal(shipped, playbook.text);
});

test('Qwen Code auth probe reports local configuration presence only', async () => {
  const status = await qwenCodeProductPack.checkAuth?.();
  assert.ok(status);
  assert.equal(status.provider, 'qwen-code');
  if (status.configured) {
    assert.equal(status.source, 'settings.json');
    assert.equal(status.detail, 'local-configuration-present');
  } else {
    assert.equal(status.source, undefined);
    assert.match(status.detail ?? '', /No local credential or configuration file found/);
  }
});

test('Qwen Code history is explicitly unavailable instead of empty', async () => {
  const history = qwenCodeProductPack.history;
  assert.equal(history.defaultRoot, join(homedir(), '.qwen'));
  const page = await history.discover();
  assert.deepEqual(page.items, []);
  assert.equal(page.scanned, 0);
  assert.deepEqual(page.diagnostics.map((item) => item.code), ['catalog-unavailable']);
  await assert.rejects(history.inspect({ productId: 'qwen-code', sessionId: 'session-1' }), /history import is not implemented/);
  await assert.rejects(history.import({ productId: 'qwen-code', sessionId: 'session-1' }), /history import is not implemented/);
});

test('Qwen Code publishes its default candidate as the only catalog offer and reports executable discovery honestly', async () => {
  const offers = await qwenCodeProductPack.runtime.listCatalog();
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.value, qwenCodeProductPack.defaultCandidate().requestedModel);
  assert.equal(offers[0]?.displayName, 'Qwen Code default model');
  const injected = createAcpPack(qwenCodePackDefinition, { executable: process.execPath });
  const [available] = await injected.runtime.inspectAvailability();
  assert.equal(available?.status, 'available');
  assert.equal(available?.executable, process.execPath);
  const missing = createAcpPack(qwenCodePackDefinition, { env: {} });
  const [absent] = await missing.runtime.inspectAvailability();
  assert.equal(absent?.status, 'not_installed');
  assert.match(absent?.installHint ?? '', /REPRISE_QWEN_EXECUTABLE/);
  await assert.rejects(
    missing.runtime.resolve({ productId: 'qwen-code', requestedModel: MODEL }),
    /Install Qwen Code/,
  );
});

test('a Qwen Code turn settles natively and auto-answers the permission request', async (t) => {
  const { runner, events, logPath } = await fakeAcpRunner(t, 'end_turn');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Write ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  assert.equal(receipt.delivery, 'accepted');
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.confidence, 'native');
  assert.deepEqual(settlement.rawRefs, [{ type: 'session/prompt', stopReason: 'end_turn' }]);
  const output = await waitForEvent(events, 'runtime.visible_output');
  assert.equal(payloadText(output), 'Wrote ping.txt.');
  assert.ok(events.some((event) => event.type === 'runtime.session_started'));
  assert.match(await readFile(logPath, 'utf8'), /permission:selected:allow-once/);
  await runner.close();
  assert.ok(events.some((event) => event.type === 'runtime.session_closed'));
});

test('a cancelled stopReason maps to an aborted native settlement', async (t) => {
  const { runner } = await fakeAcpRunner(t, 'cancelled');
  await runner.start(
    { id: 'message-1', text: 'Write ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
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
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-qwen-'));
  const script = join(root, 'fake-qwen-acp.mjs');
  const logPath = join(root, 'protocol.log');
  await writeFile(script, FAKE_ACP);
  const pack = createAcpPack(qwenCodePackDefinition, {
    executable: process.execPath,
    args: [script, mode],
    env: { QWEN_FAKE_LOG: logPath },
  });
  const events: TargetEvent[] = [];
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const resolved = { productId: 'qwen-code', executable: process.execPath, requestedModel: MODEL, resolvedModel: 'unknown' };
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
      /* the test may already have closed the runner */
    }
  });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { runner, events, logPath };
}

async function waitForEvent(events: readonly TargetEvent[], type: string): Promise<TargetEvent> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = events.find((event) => event.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No ${type} event was recorded.`);
}

function payloadText(event: TargetEvent): string | undefined {
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null && 'text' in payload
    ? (payload as { text?: string }).text
    : undefined;
}
