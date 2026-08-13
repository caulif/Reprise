import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { CodexIntakeTui } from '../src/tui/codex-intake.js';
import { defaultHarnessModelConfig, saveHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';

test('Codex intake TUI uses an ASCII narrow-terminal fallback and states the minimum width', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-narrow-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {}, requestRender() {}, renderNow() {},
  } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });

  await app.start();
  const narrow = document?.render(60).join('\n') ?? '';
  assert.match(narrow, /Welcome \/ Recent runs/);
  assert.doesNotMatch(narrow, /[┌┐└┘│─❯●✓…]/);
  assert.match(narrow, /\[ Welcome \/ Recent runs \]/);
  assert.match(narrow, /^Reprise v0\.1\.0/m);
  assert.doesNotMatch(narrow.split('\n')[0] ?? '', /No configured model|gpt-/);
  assert.match(narrow.split('\n')[1] ?? '', /No configured model|API not configured/);
  assert.match(document?.render(31).join('\n') ?? '', /Resize to at least 32 columns/);
  app.handleInput('?');
  assert.match(document?.render(60).join('\n') ?? '', /Keys/);
});

test('Codex intake TUI uses framed panels at normal terminal widths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-wide-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {}, requestRender() {}, renderNow() {},
  } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });

  await app.start();
  const wide = document?.render(120).join('\n') ?? '';
  assert.match(wide, /┌─ Welcome \/ Recent runs/);
  assert.match(wide, /Enter a task or \/ command/);
});

test('Codex intake TUI presents session discovery errors instead of rejecting in the background', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-sessions-error-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, 'sessions-file');
  await writeFile(sessionsRoot, 'not a directory');
  let document: Component | undefined;
  let rendered = '';
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {},
    requestRender() { rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; },
  } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot, tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });

  await app.start();
  enterCommand(app, '/intake');
  await waitFor(() => /ENOTDIR/.test(rendered));
  assert.match(rendered, /ENOTDIR/);
});

test('Codex intake TUI only reads before explicit freeze and leaves no ambiguous case', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-intake-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, 'data'), defaultHarnessModelConfig());
  const source = join(sessionsRoot, 'rollout-session-1.jsonl');
  const raw = [
    { timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-1', cwd: 'C:/source', cli_version: '0.1.0' } },
    { timestamp: '2026-08-11T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-test' } },
    { timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the bug.' } },
    { timestamp: '2026-08-11T00:00:03.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Fixed it.' } },
    { timestamp: '2026-08-11T00:00:04.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Verify the regression.' } },
    { timestamp: '2026-08-11T00:00:05.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(source, raw);
  const oversized = join(sessionsRoot, 'rollout-oversized.jsonl');
  await writeFile(oversized, Buffer.alloc(64 * 1024 * 1024 + 1));

  let document: Component | undefined;
  let rendered = '';
  const tui = {
    addChild(component: Component) { document = component; },
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() { rendered = document?.render(120).join('\n') ?? ''; },
    renderNow() { rendered = document?.render(120).join('\n') ?? ''; },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot, tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => '2026-08-11T00:10:00.000Z',
  });

  await app.start();
  assert.match(rendered, /Welcome \/ Recent runs/);
  assert.match(rendered, /\/intake/);
  enterCommand(app, '/intake');
  await waitFor(() => /Fix the bug\./.test(rendered));
  assert.equal(await readFile(source, 'utf8'), raw);

  app.handleInput('\r');
  await waitFor(() => /Review the session details/.test(rendered));
  assert.match(rendered, /Review the session details/);
  assert.match(rendered, /Task input 1\/2: Fix the bug\./);
  assert.match(rendered, /Source:/);
  assert.equal(await readFile(source, 'utf8'), raw);

  app.handleInput('\u001b[B');
  assert.match(rendered, /Task input 2\/2: Verify the regression\./);
  app.handleInput('\r');
  await waitFor(() => /is current/.test(rendered));
  assert.match(rendered, /is current/);
  const caseId = (await readdir(join(root, 'data', 'cases')))[0];
  assert.ok(caseId);
  assert.match(await readFile(join(root, 'data', 'cases', caseId, 'case.complete'), 'utf8'), /^$/);
  const frozen = JSON.parse(await readFile(join(root, 'data', 'cases', caseId, 'case.json'), 'utf8')) as { initialInput: { text: string } };
  assert.equal(frozen.initialInput.text, 'Verify the regression.');
  assert.equal(await readFile(source, 'utf8'), raw);
});

function enterCommand(app: CodexIntakeTui, command: string): void {
  app.handleInput(command);
  app.handleInput('\r');
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('TUI did not render its expected state.');
}

test('Codex intake TUI keeps non-command input local and makes help and unknown commands recoverable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-input-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = '';
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {},
    requestRender() { rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; },
  } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });

  await app.start();
  app.handleInput('explain this task');
  app.handleInput('\r');
  assert.match(rendered, /Benchmark workbench; enter \/help/);
  assert.doesNotMatch(rendered, /explain this task/);
  assert.deepEqual(await readdir(root), []);

  enterCommand(app, '/unknown');
  assert.match(rendered, /Unknown command: \/unknown/);
  app.handleInput('?');
  assert.match(rendered, /Commands: \/config, \/intake, \/run, \/history/);
});

test('Codex intake TUI opens Home without configuration and only enters config on an explicit command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-setup-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = '';
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {},
    requestRender() { rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; },
  } as unknown as TUI;
  const piModels = {
    getProviders: () => [{ id: 'provider-a', name: 'Provider A' }],
    getModels: () => [{ id: 'model-a', name: 'Model A', input: ['text'] }],
    getModel: () => ({ id: 'model-a', name: 'Model A', input: ['text'] }),
    getAuth: async () => ({ auth: {}, source: 'fixture Pi' }),
    completeSimple: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] }),
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui, piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, now: () => '2026-08-11T00:10:00.000Z',
  });

  await app.start();
  assert.match(rendered, /Welcome \/ Recent runs/);
  assert.doesNotMatch(rendered, /Harness API/);
  enterCommand(app, '/config');
  await waitFor(() => /Harness API/.test(rendered));
  assert.match(rendered, /provider-a/);
  app.handleInput('s');
  await waitFor(() => /Configuration saved locally/.test(rendered));
  assert.deepEqual(await readFile(join(root, 'data', 'harness-model.json'), 'utf8').then(JSON.parse), {
    schemaVersion: 2, provider: { kind: 'pi-catalog', id: 'provider-a' }, modelId: 'model-a', effort: 'medium',
  });
  assert.match(rendered, /Welcome \/ Recent runs/);
  enterCommand(app, '/config');
  await waitFor(() => /Harness API/.test(rendered));
  assert.doesNotMatch(rendered, /Unsaved draft/);
  assert.match(rendered, /Saved locally/);
});


test('Codex intake TUI prefills the historical source, shows current-state limits, live facts, and report summary', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-workflow-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, 'sessions');
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, 'data'), defaultHarnessModelConfig());
  await writeFile(join(sessionsRoot, 'rollout-session-2.jsonl'), [
    JSON.stringify({ timestamp: '2026-08-11T00:00:00.000Z', type: 'session_meta', payload: { id: 'session-2', cwd: 'C:/not-automatic' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Make a focused change.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:02.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } }),
    JSON.stringify({ timestamp: '2026-08-11T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_complete' } }),
  ].join('\n') + '\n');
  let document: Component | undefined;
  let rendered = '';
  let stops = 0;
  let requestedRenders = 0;
  const tui = {
    addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() { stops += 1; },
    requestRender() { requestedRenders += 1; rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; },
  } as unknown as TUI;
  let cancellations = 0;
  let releaseStart: (() => void) | undefined;
  let resolveResult: ((value: unknown) => void) | undefined;
  let sourceRoot = '';
  let emitEvent: ((event: unknown) => void) | undefined;
  const fullPublicResponse = `${Array.from({ length: 200 }, (_, index) => `public response line ${index + 1}`).join('\n')}\nPUBLIC_DETAIL_END`;
  const workflow = {
    candidate: { candidateId: 'codex-luna-high', productId: 'codex', requestedModel: 'gpt-5.6-luna' },
    preflight: async () => ({ sourceBaseline: 'partial', resolved: { productId: 'codex', executable: 'fixture', requestedModel: 'gpt-5.6-luna', resolvedModel: 'gpt-5.6-luna' }, limitations: ['fingerprint differs'] }),
    start: async (input: { sourceRoot: string; onEvent(event: unknown): void }) => {
      sourceRoot = input.sourceRoot;
      emitEvent = input.onEvent;
      input.onEvent({ schemaVersion: 1, sequence: 1, eventId: 'event-1', occurredAt: '2026-08-11T00:10:00.000Z', type: 'run.state_changed', payload: { to: 'launching' }, checksum: 'a'.repeat(64) });
      input.onEvent({ schemaVersion: 1, sequence: 2, eventId: 'event-2', occurredAt: '2026-08-11T00:10:01.000Z', type: 'controller.decision', payload: { status: 'completed', sessionId: 'controller-1', value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' } }, checksum: 'b'.repeat(64) });
      input.onEvent({ schemaVersion: 1, sequence: 3, eventId: 'event-3', occurredAt: '2026-08-11T00:10:02.000Z', type: 'codex.item_completed', payload: { item: { type: 'agentMessage', text: fullPublicResponse } }, checksum: 'c'.repeat(64) });
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      return { cancel: async () => { cancellations += 1; }, result: new Promise((resolve) => { resolveResult = resolve; }) };
    },
  } as never;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot, tui, workflow, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, now: () => '2026-08-11T00:10:00.000Z' });

  await app.start();
  enterCommand(app, '/intake');
  await waitFor(() => /Make a focused change\./.test(rendered));
  app.handleInput('\r');
  await waitFor(() => /Review the session details/.test(rendered));
  app.handleInput('\r');
  await waitFor(() => /is current/.test(rendered));
  enterCommand(app, '/run');
  assert.match(rendered, /Historical working directory is prefilled/);
  assert.match(rendered, /C:\/not-automatic/);
  for (let index = 0; index < 'C:/not-automatic'.length; index += 1) app.handleInput('\b');
  app.handleInput('C:\\explicit-source');
  app.handleInput('\r');
  await waitFor(() => /Candidate preflight/.test(rendered));
  app.handleInput('\r');
  await waitFor(() => /Start isolated Codex Candidate/.test(rendered));
  app.handleInput('\r');
  await waitFor(() => /Validating the configured provider/.test(rendered));
  app.handleInput('\u0003');
  assert.equal(stops, 0);
  assert.equal(cancellations, 0);
  releaseStart?.();
  await waitFor(() => cancellations === 1);
  assert.match(rendered, /Cancellation requested/);
  assert.equal(sourceRoot, 'C:\\explicit-source');
  assert.match(rendered, /State: created → launching/);
  assert.match(rendered, /public response line 1/);
  requestedRenders = 0;
  for (let sequence = 4; sequence <= 6; sequence += 1) {
    emitEvent?.({ schemaVersion: 1, sequence, eventId: `event-${sequence}`, occurredAt: '2026-08-11T00:10:03.000Z', type: 'run.state_changed', payload: { to: 'waiting' }, checksum: 'd'.repeat(64) });
  }
  await waitFor(() => requestedRenders === 1);
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal(requestedRenders, 1);
  app.handleInput('f');
  assert.match(rendered, /Filter: TARGET/);
  assert.doesNotMatch(rendered, /State: created → launching/);
  assert.match(rendered, /Detail[\s\S]*PUBLIC_DETAIL_END/);
  app.handleInput('pageUp');
  app.handleInput('l');
  assert.match(rendered, /Following latest/);
  app.handleInput('\u0003');
  assert.equal(cancellations, 1);
  // Test seam intentionally supplies a partial result; the TUI must not assume optional display data exists.
  resolveResult?.({
    reportPath: join(root, 'data', 'experiments', 'fixture', 'report.html'),
    record: { attempt: { runId: 'run-1' }, outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } } },
    decision: { value: { type: 'done' }, usedFallback: false }, comparison: { result: { usedFallback: false } }, recovery: { value: { status: 'ready_for_provider_validation' }, usedFallback: false },
  });
  await waitFor(() => /Experiment finished/.test(rendered));
  assert.match(rendered, /report\.html/);
  app.handleInput('\u0003');
  assert.equal(stops, 1);
});



test('Codex intake TUI browses validated local history and selects a TaskCase without reopening source sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-history-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const casesRoot = join(dataDir, 'cases', 'case-history');
  const experimentsRoot = join(dataDir, 'experiments', 'exp-history');
  await mkdir(casesRoot, { recursive: true });
  await mkdir(join(experimentsRoot, 'runs', 'run-history'), { recursive: true });
  const taskCase = {
    schemaVersion: 1, caseId: 'case-history', source: { productId: 'codex', sessionId: 'session-history' },
    initialInput: { id: 'input-history', role: 'user', text: 'Inspect a focused regression.' }, transcript: [{ id: 'input-history', role: 'user', text: 'Inspect a focused regression.' }], historicalEvents: [],
    baseline: { status: 'unavailable', artifactRefs: [], evidenceRefs: [] }, sourceRuntimeEvidence: { productId: 'codex', artifactRefs: [] }, provenance: { packVersion: '1', importedAt: '2026-08-11T00:00:00.000Z', sourceHash: 'a'.repeat(64) },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] }, contentHash: 'b'.repeat(64),
  };
  await writeFile(join(casesRoot, 'case.json'), JSON.stringify(taskCase));
  await writeFile(join(experimentsRoot, 'experiment.json'), JSON.stringify({ spec: {
    experimentId: 'exp-history', taskCaseId: 'case-history', candidates: [{ candidateId: 'codex-history', productId: 'codex', requestedModel: 'gpt-history' }],
    recovery: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
    runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, outputRoot: experimentsRoot,
  }, runIds: ['run-history'] }));
  await writeFile(join(experimentsRoot, 'runs', 'run-history', 'record.json'), JSON.stringify({
    schemaVersion: 1, attempt: { schemaVersion: 1, runId: 'run-history', experimentId: 'exp-history', caseId: 'case-history', candidate: { candidateId: 'codex-history', productId: 'codex', requestedModel: 'gpt-history' }, policy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, createdAt: '2026-08-11T01:00:00.000Z' },
    manifest: { schemaVersion: 1, attempt: { schemaVersion: 1, runId: 'run-history', experimentId: 'exp-history', caseId: 'case-history', candidate: { candidateId: 'codex-history', productId: 'codex', requestedModel: 'gpt-history' }, policy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 }, createdAt: '2026-08-11T01:00:00.000Z' }, resolvedModel: { requested: 'gpt-history', resolved: 'gpt-history' }, runtime: { productId: 'codex', executable: 'fixture' }, environment: { environmentId: 'env-history', workspacePath: 'fixture' }, recovery: { providerId: 'provider', requestedModel: 'model', configHash: 'c'.repeat(64), promptVersion: 'v1', toolPolicy: 'read', contextPolicy: 'v1' }, controller: { providerId: 'provider', requestedModel: 'model', configHash: 'c'.repeat(64), promptVersion: 'v1', toolPolicy: 'read', contextPolicy: 'v1' }, comparison: { providerId: 'provider', requestedModel: 'model', configHash: 'c'.repeat(64), promptVersion: 'v1', toolPolicy: 'read', contextPolicy: 'v1' }, startedAt: '2026-08-11T01:00:00.000Z' },
    outcome: { termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } }, artifactRefs: [],
  }));
  let document: Component | undefined;
  let rendered = '';
  const tui = { addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {}, requestRender() { rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; } } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir, sessionsRoot: join(root, 'sessions'), tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  await app.start();
  enterCommand(app, '/history');
  await waitFor(() => /Recent experiments/.test(rendered));
  assert.match(rendered, /exp-history/);
  app.handleInput('\t');
  assert.match(rendered, /TaskCases/);
  app.handleInput('\r');
  assert.match(rendered, /TaskCase: case-history/);
  app.handleInput('\r');
  assert.match(rendered, /TaskCase case-history/);
});


test('Codex intake TUI saves an OpenAI-compatible draft without a secret or connection request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-custom-config-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = '';
  const tui = { addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {}, requestRender() { rendered = document?.render(120).join('\n') ?? ''; }, renderNow() { rendered = document?.render(120).join('\n') ?? ''; } } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  const replaceField = (value: string) => { app.handleInput(value); app.handleInput('\r'); };
  await app.start();
  enterCommand(app, '/config');
  await waitFor(() => /Harness API/.test(rendered));
  app.handleInput('\r'); // provider type: pi catalog -> OpenAI-compatible
  app.handleInput('\u001b[B'); app.handleInput('\r'); replaceField('private-gateway');
  app.handleInput('\u001b[B'); app.handleInput('\r'); replaceField('https://api.example.test/v1');
  app.handleInput('\u001b[B'); app.handleInput('\r'); replaceField('model-private');
  app.handleInput('\u001b[B'); // effort, deliberately retain default
  app.handleInput('\u001b[B'); app.handleInput('\r'); replaceField('env:REPRISE_PRIVATE_KEY');
  app.handleInput('s');
  await waitFor(() => /Configuration saved locally/.test(rendered));
  const saved = await readFile(join(root, 'data', 'harness-model.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), {
    schemaVersion: 2, provider: { kind: 'openai-compatible', id: 'private-gateway' }, modelId: 'model-private', effort: 'medium',
    baseUrl: 'https://api.example.test/v1', keyRef: 'env:REPRISE_PRIVATE_KEY',
  });
  assert.doesNotMatch(saved, /actual-secret-value/);
  assert.doesNotMatch(rendered, /REPRISE_PRIVATE_KEY=.*\S/);
});
