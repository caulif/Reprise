import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema } from '../src/core/schema.js';
import { codexProductPack, freezeCodexFixture, importCodexFixture, normalizeCodexRuntimeEvent } from '../src/products/codex/pack.js';
import { discoverCodexSessions, freezeCodexSession, inspectCodexSession } from '../src/products/codex/sessions.js';
import { CodexAppServerClient, CodexRuntimePort, codexSettlementStatus, discoverCodexExecutable } from '../src/products/codex/runtime-port.js';
import { CodexTextCaller, EXPERIMENT_APPLICATION_EFFORT, EXPERIMENT_APPLICATION_MODEL } from '../src/products/codex/text-caller.js';
import { assertCodexSmokeAcceptanceRecord, checkCodexSmokeGate, CodexSmokeAcceptanceRecordSchema } from '../src/products/codex/smoke-gate.js';
import { productPacks } from '../src/products/index.js';

const fixturePath = new URL('./fixtures/codex-session.fixture.json', import.meta.url);
const execFileAsync = promisify(execFile);

test('Codex fixture import freezes one complete session without exposing raw private fields', async () => {
  const imported = await importCodexFixture(fixturePath);
  assert.equal(imported.taskCase.initialInput.id, 'message-1');
  assert.equal(imported.taskCase.transcript.length, 2);
  assert.equal(imported.taskCase.baseline.finalMessage, 'Implemented the importer.');
  assert.equal(imported.taskCase.baseline.artifactRefs[0]?.caseId, imported.taskCase.caseId);
  assert.equal(Value.Check(TaskCaseSchema, imported.taskCase), true);
  assert.doesNotMatch(JSON.stringify(imported.taskCase), /privateDebug/);
  assert.equal(imported.rawSession.events.at(-1)?.type, 'internal_debug');
});

test('Codex freeze creates immutable case facts, raw session, and hashed baseline artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-case-'));
  try {
    const frozen = await freezeCodexFixture(fixturePath, root);
    await stat(join(root, frozen.taskCase.caseId, 'case.complete'));
    const caseJson = await readFile(join(root, frozen.taskCase.caseId, 'case.json'), 'utf8');
    const raw = await readFile(join(root, frozen.taskCase.caseId, 'raw', 'session.json'), 'utf8');
    const artifact = await readFile(join(root, frozen.taskCase.caseId, 'baseline-artifacts', 'screenshot-1'), 'utf8');
    assert.match(caseJson, /message-1/);
    assert.match(raw, /privateDebug/);
    assert.equal(artifact, 'png-fixture');
    await assert.rejects(freezeCodexFixture(fixturePath, root), /already exists/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex runtime normalization records only observed model facts and leaves absent data unknown', () => {
  assert.deepEqual(normalizeCodexRuntimeEvent({ type: 'model.resolved', data: { provider: 'openai', model: 'gpt-5.6-codex' } }), {
    type: 'runtime.model_resolved', provider: 'openai', model: 'gpt-5.6-codex',
  });
  assert.deepEqual(normalizeCodexRuntimeEvent({ type: 'turn.completed', data: { turnId: 'turn-1' } }), {
    type: 'runtime.turn_settled', turnId: 'turn-1',
  });
  assert.deepEqual(normalizeCodexRuntimeEvent({ type: 'model.resolved', data: {} }), {
    type: 'runtime.model_resolved', provider: 'unknown', model: 'unknown',
  });
});

test('only the Codex Product Pack is statically registered', () => {
  assert.equal(productPacks.length, 1);
  assert.equal(productPacks[0], codexProductPack);
  assert.equal(codexProductPack.runtime.id, 'codex');
  assert.deepEqual(codexProductPack.manifest.sessionSchemaVersions, ['reprise.codex.fixture/v1']);
});

test('Codex runtime discovery is local-only and resolves model facts as unknown', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-runtime-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex.CMD');
  await writeFile(executable, 'fixture executable');

  assert.equal(await discoverCodexExecutable({ env: { PATH: root }, platform: 'win32', pathExt: '.CMD' }), executable);
  const runtime = new CodexRuntimePort({ executable, platform: 'win32', version: '0.147.0' });
  assert.deepEqual(await runtime.inspectAvailable(), [{ productId: 'codex', executable, version: '0.147.0' }]);
  const resolved = await runtime.resolve({ productId: 'codex', requestedModel: 'gpt-test' });
  assert.equal(resolved.resolvedModel, 'unknown');
  const runner = await runtime.createRunner(resolved, { environmentId: 'env-1', runId: 'run-1', root }, { append: async () => undefined });
  assert.equal(runner.capabilities().nativeAdmission, true);
  assert.equal(runner.capabilities().nativeTurnSettlement, true);
});

test('Codex app-server settlement statuses preserve native terminal semantics', () => {
  assert.equal(codexSettlementStatus('completed'), 'completed');
  assert.equal(codexSettlementStatus('failed'), 'failed');
  assert.equal(codexSettlementStatus('interrupted'), 'aborted');
  assert.equal(codexSettlementStatus('inProgress'), undefined);
});

test('Codex app-server requests time out and close an unresponsive process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-app-server-timeout-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'unresponsive-app-server.mjs');
  await writeFile(fixture, "process.stdin.resume(); process.on('SIGTERM', () => process.exit(0));");
  const client = new CodexAppServerClient({ executable: process.execPath, args: [fixture], cwd: root, requestTimeoutMs: 25 });
  await assert.rejects(client.start(), /initialize timed out/);
  await client.close();
});

test('Experiment Application defaults to the authorized Terra medium model and rejects unsupported Host tools', async () => {
  assert.equal(EXPERIMENT_APPLICATION_MODEL, 'gpt-5.6-terra');
  assert.equal(EXPERIMENT_APPLICATION_EFFORT, 'medium');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new CodexTextCaller().createSession({ sessionId: 'session-1', systemPrompt: 'Return JSON.', tools: [] }).append({ content: '{}', signal: controller.signal }), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
  assert.throws(() => new CodexTextCaller().createSession({ sessionId: 'session-1', systemPrompt: 'Return JSON.', tools: [{ name: 'read_observation', description: '', parameters: Type.Object({}), execute: async () => ({ content: '', details: {} }) }] }), /cannot expose Host tools/);
});

test('Codex smoke gate reports missing external confirmations without starting a Runtime', () => {
  const blocked = checkCodexSmokeGate({ taskCaseReady: true, isolatedWorkspace: true, noIrreversibleActions: true, accountConfirmed: false, networkConfirmed: false, costLimit: '', maxWallClockMs: 0 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.missing.length, 4);
  const ready = checkCodexSmokeGate({ taskCaseReady: true, isolatedWorkspace: true, noIrreversibleActions: true, accountConfirmed: true, networkConfirmed: true, costLimit: '10 USD', maxWallClockMs: 30_000 });
  assert.deepEqual(ready, { allowed: true, missing: [] });
});

test('Codex smoke acceptance records are schema-checked and preserve blocked evidence', () => {
  const record = {
    schemaVersion: 1,
    status: 'blocked',
    recordedAt: '2026-08-10T00:00:00.000Z',
    taskCaseId: 'case-1',
    experimentId: 'experiment-1',
    runId: 'run-1',
    executable: 'C:/tools/codex.cmd',
    requestedModel: 'gpt-test',
    resolvedModel: 'unknown',
    fidelity: 'unknown',
    termination: 'unknown',
    cleanup: 'unknown',
    smokeSteps: { started: false, initialAdmission: false, firstTurnSettlement: false, followupSubmission: false, stopped: false },
    humanJudgment: { rawEvidence: '', artifacts: '', traceAndReport: '', knownLimitations: 'Protocol not verified.', conclusion: 'blocked' },
    blockingEvidence: { stage: 'start', diagnosticCode: 'unsupported_runtime', observation: 'Runner refused to start.', unexecutedExternalActions: 'No network request was sent.' },
  } as const;
  assert.equal(Value.Check(CodexSmokeAcceptanceRecordSchema, record), true);
  assert.doesNotThrow(() => assertCodexSmokeAcceptanceRecord(record));
  assert.throws(() => assertCodexSmokeAcceptanceRecord({ ...record, runId: '../outside' }), /Invalid Codex smoke acceptance record/);
});

test('Codex runtime discovery does not report missing executables', async () => {
  assert.equal(await discoverCodexExecutable({ executable: join(tmpdir(), 'does-not-exist', 'codex.exe'), platform: 'win32' }), undefined);
  const runtime = new CodexRuntimePort({ executable: join(tmpdir(), 'does-not-exist', 'codex.exe'), platform: 'win32' });
  await assert.rejects(runtime.resolve({ productId: 'codex', requestedModel: 'gpt-test' }), /executable was not found/);
});

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD']);
  return stdout.trim();
}

test('Codex session discovery skips one oversized rollout but explicit inspection explains the limit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-rollout-oversized-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions');
  await mkdir(sessions);
  const valid = join(sessions, 'rollout-valid.jsonl');
  await writeFile(valid, [
    JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'valid-session' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Small valid task.' } }),
  ].join('\n') + '\n');
  const oversized = join(sessions, 'rollout-oversized.jsonl');
  await writeFile(oversized, Buffer.alloc(64 * 1024 * 1024 + 1));

  const discovered = await discoverCodexSessions(sessions);
  assert.deepEqual(discovered.map((session) => session.sessionId), ['valid-session']);
  await assert.rejects(inspectCodexSession(oversized), /64 MiB inspection limit/);
});

test('Codex freeze accepts a selected user task input and rejects other transcript entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-selected-input-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, 'rollout-selected-input.jsonl');
  await writeFile(source, [
    JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'selected-input' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'First task.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'First response.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:03.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Second task.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  const request = { sourcePath: source, casesRoot: join(root, 'cases'), now: '2026-08-11T00:01:00.000Z', privacy: { allowModelText: false, allowBinary: false, redactions: [] } };

  const frozen = await freezeCodexSession({ ...request, initialMessageId: 'message-3' });
  assert.deepEqual(frozen.taskCase.initialInput, { id: 'message-3', role: 'user', text: 'Second task.' });
  await assert.rejects(freezeCodexSession({ ...request, casesRoot: join(root, 'invalid-user'), initialMessageId: 'message-2' }), /not a user message/);
  await assert.rejects(freezeCodexSession({ ...request, casesRoot: join(root, 'invalid-id'), initialMessageId: 'missing' }), /not a user message/);
});

test('Codex rollout discovery and freeze are read-only, complete, redacted, and idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-rollout-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, 'sessions', '2026', '08', '11');
  await mkdir(sessions, { recursive: true });
  const source = join(sessions, 'rollout-2026-08-11T00-00-00-session-1.jsonl');
  const historicalCwd = join(root, 'historical');
  await mkdir(historicalCwd);
  await execFileAsync('git', ['init', historicalCwd]);
  await execFileAsync('git', ['-C', historicalCwd, 'config', 'user.email', 'test@example.invalid']);
  await execFileAsync('git', ['-C', historicalCwd, 'config', 'user.name', 'Reprise test']);
  await writeFile(join(historicalCwd, 'tracked.txt'), 'baseline\n');
  await execFileAsync('git', ['-C', historicalCwd, 'add', '.']);
  await execFileAsync('git', ['-C', historicalCwd, 'commit', '-m', 'baseline']);
  await writeFile(join(historicalCwd, 'dirty.txt'), 'current only\n');
  const historicalCommit = 'a'.repeat(40);
  const lines = [
    { timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: historicalCwd, cli_version: '0.1.0', git: { commit: historicalCommit } } },
    { timestamp: '2026-08-11T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.6' } },
    { timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the SERVICE_TOKEN leak.' } },
    { timestamp: '2026-08-11T00:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"npm test"}' } },
    { timestamp: '2026-08-11T00:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'apply_patch', arguments: '{"patch":"*** Update File: src/example.ts\\n*** Add File: README.md"}' } },
    { timestamp: '2026-08-11T00:00:05.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed and tested.' } },
    { timestamp: '2026-08-11T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ];
  await writeFile(source, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

  const discovered = await discoverCodexSessions(join(root, 'sessions'));
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.signals.toolCalls, 2);
  assert.equal((await inspectCodexSession(source)).finalMessage, 'Fixed and tested.');

  const cases = join(root, 'cases');
  const frozen = await freezeCodexSession({ sourcePath: source, casesRoot: cases, now: '2026-08-11T00:01:00.000Z', privacy: { allowModelText: false, allowBinary: false, redactions: ['SERVICE_TOKEN'] } });
  assert.equal(frozen.reused, false);
  assert.equal(Value.Check(TaskCaseSchema, frozen.taskCase), true);
  assert.doesNotMatch(JSON.stringify(frozen.taskCase), /SERVICE_TOKEN/);
  assert.doesNotMatch(await readFile(join(cases, frozen.taskCase.caseId, 'raw', 'session.jsonl'), 'utf8'), /SERVICE_TOKEN/);
  const context = frozen.taskCase.taskContext as Record<string, unknown>;
  assert.equal(context.historicalCommit, historicalCommit);
  assert.deepEqual(context.historicalBehavior, { commands: ['npm test'], touchedPaths: ['README.md', 'src/example.ts'] });
  assert.deepEqual(context.historicalEnvironment, { cwd: { status: 'available', git: { isRepository: true, dirty: true, head: await gitHead(historicalCwd) } } });
  assert.equal((await freezeCodexSession({ sourcePath: source, casesRoot: cases, now: '2026-08-11T00:01:00.000Z', privacy: { allowModelText: false, allowBinary: false, redactions: ['SERVICE_TOKEN'] } })).reused, true);

  const incomplete = join(sessions, 'rollout-incomplete.jsonl');
  await writeFile(incomplete, lines.slice(0, -1).map((line) => JSON.stringify(line)).join('\n') + '\n');
  await assert.rejects(freezeCodexSession({ sourcePath: incomplete, casesRoot: cases, now: '2026-08-11T00:01:00.000Z', privacy: { allowModelText: false, allowBinary: false, redactions: [] } }), /no completed turn/);
});
