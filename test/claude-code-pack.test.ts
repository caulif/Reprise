import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema, type EventEnvelope } from '../src/core/schema.js';
import type { TargetRunner } from '../src/core/runtime.js';
import { isEligibleSession, type TargetActivity } from '../src/products/contract.js';
import { freezeCase } from '../src/products/shared/freeze.js';
import { claudeCodeProductPack, checkClaudeAuth } from '../src/products/claude-code/pack.js';
import { claudeActivityTranslator } from '../src/products/claude-code/activity.js';
import {
  CLAUDE_DISALLOWED_TOOLS,
  CLAUDE_REQUIRED_ARGS,
  ClaudeStreamClient,
  ClaudeCodeRuntimePort,
  clearClaudeCatalogCache,
} from '../src/products/claude-code/runtime-port.js';
import { importClaudeSession, discoverClaudeSessions } from '../src/products/claude-code/sessions.js';
import {
  assertClaudeSmokeAcceptanceRecord,
  checkClaudeSmokeGate,
  ClaudeSmokeAcceptanceRecordSchema,
} from '../src/products/claude-code/smoke-gate.js';
import { productPacks } from '../src/products/index.js';
import { sha256 } from '../src/core/identity.js';

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
  const built = await readFile(new URL('../src/products/claude-code/recovery/SKILL.md', import.meta.url), 'utf8');
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

test('Claude discovery skips Reprise-owned cwd and import rejects a session with no end_turn', async (t) => {
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
  assert.equal(found.some((item) => item.cwd === owned), false);
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
});

test('Claude activity vocabulary maps built-in tools without exceeding the other-kind threshold', () => {
  const tools = [
    'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
    'Task', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TaskUpdate',
    'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'SendMessage',
    'Workflow', 'Skill', 'ReportFindings', 'EnterWorktree', 'ExitWorktree',
  ];
  const events: EventEnvelope[] = [
    envelope('claude-code.system_init', { permissionMode: 'bypassPermissions', model: 'claude-fable-5[1M]', claude_code_version: '2.1.221' }),
    envelope('claude-code.assistant', {
      message: {
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'working' },
          ...tools.map((name, index) => ({ type: 'tool_use', id: `tool-${index}`, name, input: { command: 'echo', query: 'q', file_path: 'a.ts' } })),
        ],
      },
    }),
    envelope('claude-code.result', { usage: { input_tokens: 3, output_tokens: 2 } }),
  ];
  const activities = events.flatMap((event) => claudeActivityTranslator.translate(event)).map((entry) => entry.activity);
  assert.ok(activities.some((activity) => activity.kind === 'sandbox_notice'));
  assert.ok(activities.some((activity) => activity.kind === 'subtask'));
  assert.ok(activities.some((activity) => activity.kind === 'schedule'));
  assert.ok(otherRatio(activities) < 0.4);
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
  assert.ok(events.includes('claude-code.system_init'));
  assert.ok(events.includes('claude-code.result'));
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
  assert.ok(events.includes('claude-code.protocol_error'));
});

test('an unexpectedly exited Claude process fails waitForTurn and records one process_exited event', async (t) => {
  const { runner, events } = await fakeClaudeRunner(t, 'exit');
  await runner.start(
    { id: 'message-1', text: 'Create ping.txt' },
    { runId: 'run-1', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
  );
  await assert.rejects(runner.waitForTurn(), /exited/);
  assert.equal(await runner.inspect(), 'stopped');
  assert.equal(events.filter((type) => type === 'claude-code.process_exited').length, 1);
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
  const first = new ClaudeCodeRuntimePort({ executable: process.execPath, args: [script, 'catalog'], env: { CLAUDE_FAKE_LOG: count } });
  const second = new ClaudeCodeRuntimePort({ executable: process.execPath, args: [script, 'catalog'], env: { CLAUDE_FAKE_LOG: count } });
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
  const models = await new ClaudeCodeRuntimePort({ executable: process.execPath, args: [script, 'nested'] }).listModels();
  assert.equal(models[0]?.value, 'sonnet');
  assert.equal(models[0]?.resolvedModel, 'claude-fable-5');
});

test('checkAuth can use an initialize catalog without reading credential files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-claude-auth-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake-claude.mjs');
  await writeFile(script, FAKE_CLAUDE);
  clearClaudeCatalogCache();
  const status = await checkClaudeAuth(new ClaudeCodeRuntimePort({ executable: process.execPath, args: [script, 'catalog'] }));
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
  const runtime = new ClaudeCodeRuntimePort({
    executable: process.execPath,
    args: override?.args ?? [script, mode],
  });
  const events: string[] = [];
  const runner = await runtime.createRunner(
    { productId: 'claude-code', executable: process.execPath, requestedModel: 'sonnet', resolvedModel: 'unknown' },
    { environmentId: 'environment-run-1', runId: 'run-1', root },
    { append: async (event) => { events.push(event.type); } },
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

function otherRatio(activities: readonly TargetActivity[]): number {
  if (!activities.length) return 0;
  return activities.filter((activity) => activity.kind === 'other').length / activities.length;
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
