import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { TaskCaseSchema } from '../src/core/schema.js';
import { codexProductPack, freezeCodexFixture, importCodexFixture, normalizeCodexRuntimeEvent } from '../src/products/codex/pack.js';
import { CodexRuntimePort, codexSettlementStatus, discoverCodexExecutable } from '../src/products/codex/runtime-port.js';
import { CodexTextCaller, EXPERIMENT_APPLICATION_EFFORT, EXPERIMENT_APPLICATION_MODEL } from '../src/products/codex/text-caller.js';
import { assertCodexSmokeAcceptanceRecord, checkCodexSmokeGate, CodexSmokeAcceptanceRecordSchema } from '../src/products/codex/smoke-gate.js';
import { productPacks } from '../src/products/index.js';

const fixturePath = new URL('./fixtures/codex-session.fixture.json', import.meta.url);

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

test('Experiment Application defaults to the authorized Terra medium model and honors pre-aborted calls', async () => {
  assert.equal(EXPERIMENT_APPLICATION_MODEL, 'gpt-5.6-terra');
  assert.equal(EXPERIMENT_APPLICATION_EFFORT, 'medium');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(new CodexTextCaller().complete({ systemPrompt: 'Return JSON.', contextJson: '{}', capabilities: [] }, controller.signal), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
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