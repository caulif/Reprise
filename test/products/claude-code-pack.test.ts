import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema, type EventEnvelope } from '../../src/core/schema.js';
import { resolvedRecoveryFacts } from '../../src/infrastructure/recovery-tools.js';
import type { TargetRunner } from '../../src/core/runtime.js';
import { candidateLaunchFor } from '../../src/application/recovery/launch-context.js';
import { isEligibleSession } from '../../src/products/contract.js';
import { freezeCase } from '../../src/products/shared/freeze.js';
import { freezeBlockedReason, importVerifiedSession } from '../../src/products/shared/session-recovery.js';
import { claudeCodeProductPack, checkClaudeAuth } from '../../src/products/packs/claude-code/pack.js';
import { claudeProjection } from '../../src/products/packs/claude-code/projection.js';
import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_REQUIRED_ARGS,
} from '../../src/products/packs/claude-code/protocol.js';
import {
  ClaudeCodeProductRuntime,
  clearClaudeCatalogCache,
} from '../../src/products/packs/claude-code/runtime.js';
import { ClaudeStreamClient } from '../../src/products/packs/claude-code/runner.js';
import { importClaudeSession, discoverClaudeSessions, claudeSessionAdapter, defaultClaudeSessionsRoot } from '../../src/products/packs/claude-code/sessions.js';
import { validSessionTimestamp } from '../../src/products/shared/session-files.js';
import {
  assertClaudeSmokeAcceptanceRecord,
  checkClaudeSmokeGate,
  ClaudeSmokeAcceptanceRecordSchema,
} from '../../src/products/packs/claude-code/smoke-gate.js';
import { productPacks } from '../../src/products/index.js';
import { sha256 } from '../../src/core/identity.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const STARTED = '2026-08-14T00:00:00.000Z';

const FAKE_CLAUDE = `
import { appendFileSync } from 'node:fs';
const mode = process.argv[2] ?? 'success';
const logPath = process.env.CLAUDE_FAKE_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
if (mode === 'no_verbose' && !process.argv.includes('--verbose')) process.exit(1);
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.type === 'control_request') {
      if (mode === 'timeout') continue;
      if (logPath) appendFileSync(logPath, (message.request?.subtype ?? 'control') + '\\n');
      const models = [{ value: 'sonnet', resolvedModel: 'claude-fable-5', supportedEffortLevels: ['high'] }];
      const account = { apiProvider: 'firstParty', tokenSource: 'oauth' };
      send(mode === 'nested'
        ? { type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { models, account } } }
        : { type: 'control_response', request_id: message.request_id, response: { models, account } });
      if (mode === 'catalog' || mode === 'nested') process.exit(0);
      continue;
    }
    if (message.type !== 'user') continue;
    if (mode === 'exit') { process.exit(1); continue; }
    if (mode === 'never' || mode === 'timeout') continue;
    send({ type: 'system', subtype: 'init', model: 'claude-fable-5[1M]', permissionMode: 'bypassPermissions', claude_code_version: '2.1.221', apiKeySource: 'none' });
    if (mode === 'keep_alive') {
      send({ type: 'keep_alive' });
      send({ type: 'unknown_future', note: 'ignore' });
    }
    if (mode !== 'no_replay') send({ type: 'user', uuid: message.uuid, isReplay: true, message: message.message });
    send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    if (mode === 'auth_error') {
      send({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', api_error_status: 403, stop_reason: 'stop_sequence', result: 'Current user is in debt.' });
    } else if (mode === 'unrecognized') {
      send({ type: 'result', subtype: 'somethingNew', is_error: false });
    } else {
      send({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 4 } });
    }
  }
});
`;

test('Claude Code Recovery Playbook has stable provenance and is included in source', async () => {
  const playbook = claudeCodeProductPack.recoveryPlaybook();
  assert.equal(playbook.version, 'claude-code-recovery/v1');
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.match(playbook.text, /is_error/);
  assert.match(playbook.text, /permission-prompt-tool/);
  const built = await readFile(new URL('../../src/products/packs/claude-code/recovery/SKILL.md', import.meta.url), 'utf8');
  assert.equal(built, playbook.text);
});

test('Claude Code and Codex packs are both statically registered', () => {
  assert.equal(productPacks.length, 2);
  assert.equal(productPacks[1], claudeCodeProductPack);
  assert.equal(claudeCodeProductPack.runtime.id, 'claude-code');
  assert.deepEqual(claudeCodeProductPack.manifest.sessionSchemaVersions, ['claude-code-session-jsonl/v1']);
  assert.equal(claudeCodeProductPack.defaultCandidate().productId, 'claude-code');
});

test('required Claude spawn args include isolation switches and never pass prompt or fallback flags', () => {
  assert.ok(CLAUDE_REQUIRED_ARGS.includes('--verbose'));
  assert.ok(CLAUDE_REQUIRED_ARGS.includes('--replay-user-messages'));
  assert.ok(CLAUDE_REQUIRED_ARGS.includes('--no-session-persistence'));
  assert.ok(CLAUDE_REQUIRED_ARGS.includes('bypassPermissions'));
  assert.equal(CLAUDE_REQUIRED_ARGS.includes('--permission-prompt-tool'), false);
  assert.equal(CLAUDE_REQUIRED_ARGS.includes('--fallback-model'), false);
  assert.ok(CLAUDE_DISALLOWED_TOOLS.includes('CronCreate'));
  assert.ok(CLAUDE_DISALLOWED_TOOLS.includes('SendMessage'));
});

test('Claude session import covers all observed row types and never reads session_id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-session-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const source = await writeSession(root, SESSION_ID, cwd, fullSessionRows(cwd));
  const imported = await importClaudeSession(source);
  assert.equal(imported.source.sessionId, SESSION_ID);
  assert.equal(imported.source.productId, 'claude-code');
  assert.equal(imported.provenance.packVersion, 'claude-code-session-jsonl/v1');
  assert.equal(imported.initialInput.text, 'Create ping.txt with secret-token');
  assert.equal(imported.sourceRuntimeEvidence.model, 'deepseek-v4-flash');
  assert.equal(imported.taskContext?.compaction, true);
  assert.equal(imported.taskContext?.gitBranch, 'main');
  assert.deepEqual(imported.taskContext?.historicalBehavior, { commands: [], touchedPaths: ['ping.txt'] });
  assert.equal(imported.signals.completedTurns, 1);
  assert.equal(imported.signals.toolCalls, 1);
  assert.ok(imported.signals.userMessages >= 2);
  assert.equal(imported.signals.assistantMessages, 2);
  assert.equal(imported.transcript.some((message) => message.text.includes('API error')), false);
  assert.ok(imported.diagnostics.some((item) => item.code === 'compact-boundary'));
  assert.ok(imported.diagnostics.some((item) => item.code === 'unknown-types'));
  assert.equal(JSON.stringify(imported.historicalEvents).includes('"session_id":"OTHER-ID"'), true);
  assert.equal(imported.source.sessionId.includes('OTHER'), false);
  assert.equal(isEligibleSession({
    productId: 'claude-code',
    sessionId: imported.source.sessionId,
    sourcePath: source,
    startedAt: STARTED,
    signals: imported.signals,
  }), true);
});

test('session timestamp validation rejects calendar-invalid ISO values', () => {
  assert.equal(validSessionTimestamp('2026-02-29T00:00:00.000Z'), undefined);
  assert.equal(validSessionTimestamp('2026-02-30T00:00:00.000Z'), undefined);
  assert.equal(validSessionTimestamp('2026-08-14T01:02:03.000Z'), '2026-08-14T01:02:03.000Z');
});

test('Claude discovery ignores untimestamped metadata rows instead of fabricating an epoch start time', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-discovery-timestamp-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await writeSession(root, SESSION_ID, cwd, [
    { type: 'mode', sessionId: SESSION_ID, cwd },
    { type: 'user', sessionId: SESSION_ID, cwd, timestamp: '2026-08-14T01:02:03.000Z', message: { role: 'user', content: 'Fix the timestamp.' } },
    { type: 'assistant', sessionId: SESSION_ID, cwd, timestamp: '2026-08-14T01:02:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed.' }], stop_reason: 'end_turn' } },
  ]);

  const [session] = await discoverClaudeSessions(root);
  assert.equal(session?.startedAt, '2026-08-14T01:02:03.000Z');
  assert.notEqual(session?.startedAt, new Date(0).toISOString());
});

test('Claude history-only sessions enter the same inspect, freeze, and recovery intake path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-history-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, 'projects');
  await mkdir(join(sessionsRoot, 'C--demo'), { recursive: true });
  const sessionId = SESSION_ID;
  const historyOnlyId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  await writeFile(join(sessionsRoot, 'C--demo', 'renamed-transcript.jsonl'), fullSessionRows('C:\\demo').map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(root, 'history.jsonl'), [
    { sessionId, display: 'This transcript wins over duplicate history.', project: 'C:\\demo', timestamp: 1 },
    { sessionId: historyOnlyId, display: 'Repair the missing migration.', project: 'C:\\demo', timestamp: 2 },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  const page = await claudeSessionAdapter.discover({ root: sessionsRoot, limit: 50 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items.filter((item) => item.sessionId === sessionId).length, 1);
  const transcript = page.items.find((item) => item.sessionId === sessionId);
  assert.ok(transcript);
  assert.equal(transcript.evidenceLevel, 'transcript');
  assert.match(transcript.sourcePath, /renamed-transcript\.jsonl$/);
  const history = page.items.find((item) => item.sessionId === historyOnlyId);
  assert.ok(history);
  assert.equal(history.evidenceLevel, 'history');
  assert.equal(history.availability, 'catalog-only');
  assert.equal(history.signals.completedTurns, 0);
  assert.equal(isEligibleSession(history), true);
  assert.match(history.sourcePath, /#reprise-history=/);
  assert.equal(freezeBlockedReason(history), 'history-only');
  await assert.rejects(
    importVerifiedSession(claudeSessionAdapter, history, history.sourcePath),
    /history-only/,
  );
  assert.equal(freezeBlockedReason(transcript), undefined);

  const inspection = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: history.sessionId, sourcePath: history.sourcePath });
  assert.equal(inspection.evidenceLevel, 'history');
  assert.equal(inspection.transcript.length, 1);
  const imported = await claudeSessionAdapter.import({ productId: 'claude-code', sessionId: history.sessionId, sourcePath: history.sourcePath });
  assert.equal(imported.baseline.status, 'unavailable');
  assert.deepEqual(imported.historicalEvents, []);
  const frozen = await freezeCase(imported, join(root, 'cases'), { allowModelText: true, allowBinary: false, redactions: [] }, STARTED);
  assert.equal(frozen.taskCase.evidenceLevel, 'history');
  assert.equal(frozen.taskCase.transcript.length, 1);
});

test('Claude discovery builds the complete catalog without requiring a continuation key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-full-catalog-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 151; index += 1) {
    const suffix = index.toString(16).padStart(12, '0');
    const id = `aaaaaaaa-bbbb-4ccc-8ddd-${suffix}`;
    await writeSession(root, id, 'C:\\demo', [
      { type: 'user', sessionId: id, cwd: 'C:\\demo', timestamp: '2026-08-14T01:02:03.000Z', message: { role: 'user', content: `Task ${index}` } },
      { type: 'assistant', sessionId: id, cwd: 'C:\\demo', timestamp: '2026-08-14T01:02:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } },
    ]);
  }
  const page = await claudeSessionAdapter.discover({ root });
  assert.equal(page.items.length, 151);
  assert.equal(page.nextCursor, undefined);
  assert.equal(page.items.every((item) => item.sourceKind === 'rollout-only'), true);
});

test('Claude default root honors an explicit config directory without reading credentials', () => {
  assert.equal(defaultClaudeSessionsRoot('C:\\Users\\demo\\.claude-alt'), 'C:\\Users\\demo\\.claude-alt\\projects');
});

test('Claude discovery keeps a session whose cwd is excluded and still rejects incomplete freeze', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-discover-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const owned = join(root, 'owned-workspace');
  const other = join(root, 'other-project');
  await writeSession(root, SESSION_ID, owned, fullSessionRows(owned));
  const incompleteId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await writeSession(root, incompleteId, other, [
    baseRow('user', other, { sessionId: incompleteId, message: { role: 'user', content: 'Hello' } }),
    baseRow('assistant', other, { sessionId: incompleteId, message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'tool_use' } }),
  ]);
  const found = await discoverClaudeSessions(root, 20, [owned]);
  assert.equal(found.some((item) => item.sessionId === SESSION_ID), true);
  assert.equal(found.some((item) => item.sessionId === incompleteId), true);
  const incomplete = found.find((item) => item.sessionId === incompleteId);
  assert.ok(incomplete);
  const imported = await importClaudeSession(incomplete.sourcePath);
  assert.equal(imported.signals.completedTurns, 0);
  const cases = join(root, 'cases');
  await assert.rejects(
    freezeCase(imported, cases, { allowModelText: true, allowBinary: false, redactions: [] }, STARTED),
    /no completed turn/,
  );
});

test('Claude import freezes idempotently and redacts secrets through the shared path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-freeze-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const source = await writeSession(root, SESSION_ID, cwd, fullSessionRows(cwd));
  const imported = await importClaudeSession(source);
  const first = await freezeCase(imported, join(root, 'cases'), { allowModelText: true, allowBinary: false, redactions: ['secret-token'] }, STARTED);
  assert.ok(Value.Check(TaskCaseSchema, first.taskCase));
  assert.match(first.taskCase.initialInput.text, /\[REDACTED\]/);
  assert.doesNotMatch(first.taskCase.initialInput.text, /secret-token/);
  const second = await freezeCase(imported, join(root, 'cases'), { allowModelText: true, allowBinary: false, redactions: ['secret-token'] }, STARTED);
  assert.equal(second.reused, true);
  assert.equal(second.taskCase.caseId, first.taskCase.caseId);
  const recoveryFacts = await resolvedRecoveryFacts(root, first.taskCase);
  assert.equal(recoveryFacts.catalog.length, first.taskCase.transcript.length + first.taskCase.historicalEvents.length);
  assert.ok(recoveryFacts.catalog.some((entry) => entry.source === 'transcript'));
  assert.ok(recoveryFacts.catalog.some((entry) => entry.source === 'historical_events'));
  assert.ok(recoveryFacts.evidenceRefs.some((ref) => ref.startsWith('event:transcript-')));
  assert.ok(recoveryFacts.evidenceRefs.some((ref) => ref.startsWith('event:history-')));
});

test('Claude projection records bash commands and assistant text from settled events', () => {
  const events: EventEnvelope[] = [
    envelope('runtime.session_started', { permissionMode: 'bypassPermissions', model: 'claude-fable-5[1M]', claude_code_version: '2.1.221' }),
    envelope('runtime.visible_output', {
      message: {
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'tool-0', name: 'Bash', input: { command: 'echo' } },
        ],
      },
    }),
    envelope('runtime.usage_reported', { usage: { input_tokens: 3, output_tokens: 2 } }),
  ];
  const facts = claudeProjection.inspectRunFacts(events);
  assert.equal(facts.finalMessage, 'working');
  assert.deepEqual(facts.commands, ['echo']);
});

test('a successful Claude turn settles only after result and records native admission from replay', async (t) => {
  const { runner, events } = await fakeClaudeRunner(t, 'success');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  assert.equal(receipt.delivery, 'accepted');
  assert.equal(receipt.evidence, 'native_event');
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
  assert.equal(settlement.confidence, 'native');
  assert.ok(events.includes('runtime.session_started'));
  assert.ok(events.includes('runtime.usage_reported'));
});

test('subtype success plus is_error settles as failed', async (t) => {
  const { runner } = await fakeClaudeRunner(t, 'auth_error');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'failed');
  assert.equal(settlement.confidence, 'native');
});

test('keep_alive and unknown frames do not block settlement', async (t) => {
  const { runner } = await fakeClaudeRunner(t, 'keep_alive');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');
});

test('an unrecognized result subtype fails immediately instead of waiting', async (t) => {
  const { runner, events } = await fakeClaudeRunner(t, 'unrecognized');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  await assert.rejects(runner.waitForTurn(), /unrecognized turn settlement/);
  assert.ok(events.includes('runtime.runtime_failed'));
});

test('an unexpectedly exited Claude process fails waitForTurn and records one process_exited event', async (t) => {
  const { runner, events } = await fakeClaudeRunner(t, 'exit');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  await assert.rejects(runner.waitForTurn(), /exited/);
  assert.equal(await runner.inspect(), 'stopped');
  assert.equal(events.filter((type) => type === 'runtime.runtime_failed').length, 1);
});

test('a control request that never responds times out and closes the process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-timeout-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  const client = new ClaudeStreamClient({
    executable: process.execPath,
    args: [script, 'timeout'],
    cwd: root,
    requestTimeoutMs: 150,
  });
  await client.start();
  try {
    await assert.rejects(client.request('initialize'), /timed out/);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test('cancelWait releases an abandoned Claude turn so a late settlement cannot leak', async (t) => {
  const { runner } = await fakeClaudeRunner(t, 'never');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  const abandoned = runner.waitForTurn();
  runner.cancelWait?.('Harness stopped waiting for this turn.');
  await assert.rejects(abandoned, /Harness stopped waiting/);
});

test('Claude model catalog cache is shared by identical executable configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-catalog-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  const count = join(root, 'calls.log');
  await writeFile(script, FAKE_CLAUDE);
  clearClaudeCatalogCache();
  const first = new ClaudeCodeProductRuntime({ executable: process.execPath, args: [script, 'catalog'], env: { CLAUDE_FAKE_LOG: count } });
  const second = new ClaudeCodeProductRuntime({ executable: process.execPath, args: [script, 'catalog'], env: { CLAUDE_FAKE_LOG: count } });
  assert.equal((await first.listModels())[0]?.value, 'sonnet');
  assert.equal((await second.listModels())[0]?.resolvedModel, 'claude-fable-5');
  assert.equal((await readFile(count, 'utf8')).trim().split(/\r?\n/).length, 1);
  await assert.rejects(
    first.validateCandidate({ productId: 'claude-code', requestedModel: 'deepseek-v4-flash' }),
    /historical session|does not expose/,
  );
});

test('missing replay degrades admission evidence and missing --verbose exits the fake CLI', async (t) => {
  const { runner } = await fakeClaudeRunner(t, 'no_replay');
  const receipt = await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  assert.equal(receipt.evidence, 'preflight');
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, 'completed');

  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-verbose-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  const missingVerbose = await fakeClaudeRunner(t, 'no_verbose', { args: [script, 'no_verbose'] });
  await missingVerbose.runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  await assert.rejects(missingVerbose.runner.waitForTurn(), /exited/);
});

test('initialize accepts the nested control_response shape from Claude Code 2.1.221', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-nested-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  clearClaudeCatalogCache();
  const models = await new ClaudeCodeProductRuntime({ executable: process.execPath, args: [script, 'nested'] }).listModels();
  assert.equal(models[0]?.value, 'sonnet');
  assert.equal(models[0]?.resolvedModel, 'claude-fable-5');
});

test('checkAuth can use an initialize catalog without reading credential files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-auth-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  clearClaudeCatalogCache();
  const status = await checkClaudeAuth(new ClaudeCodeProductRuntime({ executable: process.execPath, args: [script, 'catalog'] }));
  assert.equal(status.configured, true);
  assert.equal(status.source, 'initialize');
});

test('Claude smoke gate requires the four product-specific confirmations', () => {
  const blocked = checkClaudeSmokeGate({
    taskCaseReady: true,
    isolatedWorkspace: true,
    noIrreversibleActions: true,
    accountConfirmed: true,
    networkConfirmed: true,
    costLimit: '10 USD',
    maxWallClockMs: 30_000,
    permissionModeConfirmed: false,
    outOfWorkspaceToolsDisabled: false,
    sessionPollutionHandled: false,
    initSnapshotRecorded: false,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.missing.length, 4);
  const ready = checkClaudeSmokeGate({
    taskCaseReady: true,
    isolatedWorkspace: true,
    noIrreversibleActions: true,
    accountConfirmed: true,
    networkConfirmed: true,
    costLimit: '10 USD',
    maxWallClockMs: 30_000,
    permissionModeConfirmed: true,
    outOfWorkspaceToolsDisabled: true,
    sessionPollutionHandled: true,
    initSnapshotRecorded: true,
  });
  assert.deepEqual(ready, { allowed: true, missing: [] });
});

test('Claude smoke acceptance records are schema-checked and preserve blocked evidence', () => {
  const record = {
    schemaVersion: 1,
    status: 'blocked',
    recordedAt: '2026-08-14T00:00:00.000Z',
    taskCaseId: 'case-1',
    experimentId: 'experiment-1',
    runId: 'run-1',
    executable: 'C:/tools/claude.exe',
    requestedModel: 'sonnet',
    resolvedModel: 'claude-fable-5',
    catalogListed: true,
    actuallyRan: false,
    permissionModeConfirmed: true,
    outOfWorkspaceToolsDisabled: true,
    sessionPollutionHandled: true,
    initSnapshotRecorded: false,
    fidelity: 'unknown',
    termination: 'failed',
    cleanup: 'unknown',
    smokeSteps: {
      started: true,
      initialAdmission: true,
      firstTurnSettlement: true,
      followupSubmission: false,
      stopped: true,
    },
    humanJudgment: {
      rawEvidence: 'result is_error with 403 debt',
      artifacts: '',
      traceAndReport: '',
      knownLimitations: 'Live turn blocked by account debt.',
      conclusion: 'blocked',
    },
    blockingEvidence: {
      stage: 'first-turn',
      diagnosticCode: 'api_error',
      observation: 'Current user is in debt.',
      unexecutedExternalActions: 'No workspace files were written.',
    },
  } as const;
  assert.equal(Value.Check(ClaudeSmokeAcceptanceRecordSchema, record), true);
  assert.doesNotThrow(() => assertClaudeSmokeAcceptanceRecord(record));
});

async function fakeClaudeRunner(
  t: { after(fn: () => Promise<unknown>): void },
  mode: string,
  override?: { args: readonly string[] },
): Promise<{ runner: TargetRunner; events: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fake-claude-'));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  const runtime = new ClaudeCodeProductRuntime({
    executable: process.execPath,
    args: override?.args ?? [script, mode],
  });
  const events: string[] = [];
  const environment = { environmentId: 'environment-run-1', runId: 'run-1', root };
  const resolved = { productId: 'claude-code', executable: process.execPath, requestedModel: 'sonnet', resolvedModel: 'unknown' };
  const runner = await runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event.type); } },
    candidateLaunchFor(resolved, environment),
  );
  t.after(async () => { try { await runner.stop('shutdown'); } catch { /* already stopped */ } });
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { runner, events };
}

async function writeSession(root: string, sessionId: string, _cwd: string, rows: readonly Record<string, unknown>[]): Promise<string> {
  const dir = join(root, 'C--demo');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

function fullSessionRows(cwd: string): Record<string, unknown>[] {
  return [
    baseRow('attachment', cwd),
    baseRow('last-prompt', cwd),
    baseRow('mode', cwd),
    baseRow('permission-mode', cwd, { permissionMode: 'bypassPermissions' }),
    baseRow('ai-title', cwd),
    baseRow('custom-title', cwd),
    baseRow('agent-name', cwd),
    baseRow('file-history-snapshot', cwd),
    baseRow('file-history-delta', cwd),
    baseRow('queue-operation', cwd),
    baseRow('unknown-future', cwd),
    baseRow('system', cwd, { subtype: 'turn_duration' }),
    baseRow('system', cwd, { subtype: 'compact_boundary' }),
    baseRow('user', cwd, { version: '2.1.221', gitBranch: 'main', session_id: 'OTHER-ID', message: { role: 'user', content: 'Create ping.txt with secret-token' } }),
    baseRow('user', cwd, { isMeta: true, message: { role: 'user', content: 'meta should not be initial' } }),
    baseRow('assistant', cwd, {
      message: {
        role: 'assistant',
        model: 'deepseek-v4-flash',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'Working' },
          { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'ping.txt', content: 'pong' } },
        ],
        stop_reason: 'tool_use',
      },
    }),
    baseRow('user', cwd, { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    baseRow('assistant', cwd, {
      isApiErrorMessage: true,
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API error' }], stop_reason: 'stop_sequence' },
    }),
    baseRow('assistant', cwd, {
      message: { role: 'assistant', model: 'deepseek-v4-flash', content: [{ type: 'text', text: 'Created ping.txt' }], stop_reason: 'end_turn' },
    }),
    baseRow('user', cwd, { message: { role: 'user', content: [{ type: 'text', text: 'Thanks' }] } }),
  ];
}

function baseRow(type: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, sessionId: SESSION_ID, timestamp: STARTED, cwd, ...extra };
}

function envelope(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: STARTED,
    type,
    payload,
    checksum: 'a'.repeat(64),
  };
}
