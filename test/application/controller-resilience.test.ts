import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { instrumentTools, AgentToolFailure } from '../../src/infrastructure/agent/tools.js';
import { workspaceTools } from '../../src/infrastructure/recovery-tools.js';
import { ToolPreconditionRejected } from '../../src/core/tool-precondition-rejected.js';
import type { AgentAuditEvent } from '../../src/infrastructure/agent/types.js';
import { cleanupCandidateRun } from '../../src/application/candidate-run-cleanup.js';
import { ScriptedRunner } from '../support/scripted-runtime.js';
import { CandidateRun } from '../../src/application/candidate-run.js';
import { copyTree, type SnapshotCopyPolicy } from '../../src/environment/local-workspace-fs.js';
import { controllerPromptContent } from '../../src/application/controller-briefing.js';
import { startExperiment } from '../../src/application/experiment.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

const signal = () => new AbortController().signal;
test('directory read and invalid parameters are model-visible audited results; a subsequent read succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-controller-recovery-'));
  try {
    await mkdir(join(root, 'run', 'turns'), { recursive: true });
    await writeFile(join(root, 'ok.txt'), 'recovered');
    const events: AgentAuditEvent[] = [];
    const tools = instrumentTools(workspaceTools(root), 'session', 'controller', { requestIndex: 0 }, { append: async event => { events.push(event); } });
    const read = tools.find(tool => tool.name === 'read')!;
    assert.match((await read.execute({ path: 'run/turns' }, signal())).content, /Use ls/);
    assert.match((await read.execute({ path: 1 }, signal())).content, /invalid_arguments/);
    assert.equal((await read.execute({ path: 'ok.txt' }, signal())).content, 'recovered');
    assert.equal(events.filter(event => event.type === 'agent.tool_completed').length, 3);
    assert.match(JSON.stringify(events), /Use ls/);
    assert.match((await read.execute({ path: 'missing.txt' }, signal())).content, /not_found/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tool persistence, permission, invariant and cancellation failures never become recoverable success', async () => {
  const tool = { name: 'probe', description: 'Probe failures', parameters: Type.Object({}), execute: async () => { throw new Error('invariant corrupted'); } };
  const wrapped = instrumentTools([tool], 's', 'controller', { requestIndex: 0 })[0]!;
  await assert.rejects(wrapped.execute({}, signal()), AgentToolFailure);
  const denied = instrumentTools([{ ...tool, execute: async () => { throw new ToolPreconditionRejected('host_write_policy', 'denied'); } }], 's', 'controller', { requestIndex: 0 })[0]!;
  await assert.rejects(denied.execute({}, signal()), /denied/);
  const audit = instrumentTools([{ ...tool, execute: async () => ({ content: 'ok' }) }], 's', 'controller', { requestIndex: 0 }, { append: async () => { throw new Error('disk failed'); } })[0]!;
  await assert.rejects(audit.execute({}, signal()), AgentToolFailure);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(wrapped.execute({}, abort.signal), /abort/i);
});

test('failBeforeStart skips unstarted runtime lifecycle; budget and supervisor are not user cancellation', async () => {
  const runner = new ScriptedRunner([], []);
  runner.stop = async () => { throw new Error('unstarted stop must not run'); };
  runner.close = async () => { throw new Error('unstarted close must not run'); };
  const run = new CandidateRun({ runner, policy: { turnTimeoutMs: 100, maxTargetTurns: 2 } });
  await run.failBeforeStart({ code: 'tool_failure', message: 'bad opening' });
  assert.equal(run.result().outcome.cleanup.status, 'complete');
  for (const source of ['budget', 'supervisor'] as const) {
    const stopped = new CandidateRun({ runner: new ScriptedRunner([], []), policy: { turnTimeoutMs: 100, maxTargetTurns: 2 } });
    await stopped.cancel(source);
    assert.equal(stopped.result().outcome.termination.initiatedBy, 'harness');
    assert.equal(stopped.result().outcome.termination.code, source === 'budget' ? 'limit.wall_clock' : 'cancelled.supervisor');
  }
});

test('capture timeout is bounded, signalled, visible and never races release; close failure is incomplete', async () => {
  let release = 0; let capturedSignal: AbortSignal | undefined;
  const events: string[] = [];
  const ports = { runner: new ScriptedRunner([], []), timeoutMs: 15,
    appendCleanup: async (type: string) => { events.push(type); return type; },
    release: async () => { release++; return { status: 'released' as const }; },
    captureArtifacts: async (value: AbortSignal) => { capturedSignal = value; await new Promise(() => {}); } };
  const result = await cleanupCandidateRun('failed', ports);
  assert.equal(result.status, 'unknown'); assert.deepEqual(result.remainingResourceIds, ['capture']);
  assert.equal(capturedSignal?.aborted, true); assert.equal(release, 0);
  assert.ok(events.includes('cleanup.capture_failed'));
  ports.runner.close = async () => { throw new Error('close failed'); };
  assert.equal((await cleanupCandidateRun('failed', ports)).status, 'incomplete');
});

test('snapshot only omits proven installed dependencies, records recipe, preserves explicit delivery paths and cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-snapshot-policy-'));
  try {
    const source = join(root, 'source'); await mkdir(join(source, 'node_modules'), { recursive: true });
    await mkdir(join(source, 'target')); await writeFile(join(source, 'target', 'delivery.txt'), 'deliver');
    for (const file of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'node_modules/large.dat']) await writeFile(join(source, file), 'data');
    const policy: SnapshotCopyPolicy = { retainPaths: [], omitted: [] };
    const dest = join(root, 'dest'); await mkdir(dest); await copyTree(source, dest, signal(), policy);
    assert.deepEqual(policy.omitted, [{ path: 'node_modules', lockfile: 'package-lock.json', restoreCommand: 'npm ci' }]);
    await assert.rejects(readFile(join(dest, 'node_modules', 'large.dat')));
    assert.equal(await readFile(join(dest, 'target', 'delivery.txt'), 'utf8'), 'deliver');
    const retained = join(root, 'retained'); await mkdir(retained);
    await copyTree(source, retained, signal(), { retainPaths: ['./NODE_MODULES\\large.dat'], omitted: [] });
    assert.equal(await readFile(join(retained, 'node_modules', 'large.dat'), 'utf8'), 'data');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(copyTree(source, join(root, 'cancelled'), abort.signal), /abort/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('completion opening hands off frozen wording directly; legacy historical opening still withholds later requirements', () => {
  const prompt = controllerPromptContent({ phase: 'opening', briefingRoot: 'briefing', indexMarkdown: 'later answer', execution: {
    mode: 'task_completion', goal: '原文目标', deliverables: ['edited file'], authorization: 'edit and test' } });
  assert.match(prompt, /原文目标/); assert.match(prompt, /Send the frozen task directly/); assert.doesNotMatch(prompt, /later answer/);
  const historical = controllerPromptContent({ phase: 'opening', briefingRoot: 'briefing', indexMarkdown: 'navigation only' });
  assert.match(historical, /Do not reveal requirements that came later/);
});

 test('Windows process identity reuse refuses tree termination; identity acquisition failure never falls back to PID', async () => {
  const { captureWindowsProcessIdentity, terminateVerifiedWindowsTree } = await import('../../src/infrastructure/windows-process-identity.js');
  let current = '100'; let kills = 0; const verified: string[] = [];
  const child = { pid: 42, exitCode: null, signalCode: null, kill: () => { kills++; return true; } } as unknown as import('node:child_process').ChildProcess;
  const backend = { capture: () => current, terminate: (_pid: number, identity: string) => { verified.push(identity); return identity === current; } };
  captureWindowsProcessIdentity(child, backend); current = '200';
  assert.equal(terminateVerifiedWindowsTree(child, backend), false);
  assert.deepEqual(verified, ['100']); assert.equal(kills, 1);
  const unknown = { ...child } as import('node:child_process').ChildProcess;
  assert.equal(terminateVerifiedWindowsTree(unknown, backend), false);
  assert.deepEqual(verified, ['100']);
  current = '100'; assert.equal(terminateVerifiedWindowsTree(child, backend), true);
  Object.defineProperty(child, 'exitCode', { value: 0 }); assert.equal(terminateVerifiedWindowsTree(child, backend), false);
 });

test('ordinary capture failure retains ownership and records an incomplete cleanup', async () => {
  let releases = 0;
  const result = await cleanupCandidateRun('failed', {
    runner: new ScriptedRunner([], []), started: false, timeoutMs: 100,
    appendCleanup: async () => undefined,
    captureArtifacts: async () => { throw new Error('snapshot denied'); },
    release: async () => { releases++; return { status: 'released' }; },
  });
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.remainingResourceIds, ['capture']);
  assert.equal(releases, 0);
});

test('budget during a fingerprint waits for cleanup instead of returning finalizing to the Controller loop', async () => {
  let entered!: () => void; let resumeFingerprint!: () => void; let resumeStop!: () => void;
  const fingerprinting = new Promise<void>(resolve => { entered = resolve; });
  const fingerprintGate = new Promise<void>(resolve => { resumeFingerprint = resolve; });
  const stopGate = new Promise<void>(resolve => { resumeStop = resolve; });
  const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [{
    turnId: 't', status: 'waiting_input', confidence: 'native', observedAt: new Date().toISOString(), rawRefs: [],
  }]);
  runner.stop = async () => { await stopGate; };
  const run = new CandidateRun({ runner, policy: { turnTimeoutMs: 1_000, maxTargetTurns: 5, maxConsecutiveNoProgress: 2 },
    progressFingerprint: async () => { entered(); await fingerprintGate; return 'digest'; },
  });
  let returned = false;
  const pending = run.start({ id: 'm', text: 'work' }, { runId: 'r', turnIndex: 0, clientMessageId: 'c' }).then(state => { returned = true; return state; });
  await fingerprinting;
  const stopping = run.stopByHarness('limit.wall_clock');
  resumeFingerprint();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  resumeStop();
  assert.equal(await pending, 'finished');
  await stopping;
  assert.equal(run.result().outcome.termination.code, 'limit.wall_clock');
});

test('deadline during request persistence never starts a Controller model invocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-deadline-request-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below and invoked with call(this).
  const append = ExperimentStore.prototype.append;
  ExperimentStore.prototype.append = async function(event) {
    if (event.type === 'controller.requested') await new Promise(resolve => setTimeout(resolve, 70));
    return append.call(this, event);
  };
  t.after(() => { ExperimentStore.prototype.append = append; });
  let calls = 0; let released = 0;
  const result = await startExperiment({ ...base, compare: false,
    policy: { ...base.policy, wallClockMs: 20 },
    controller: { decide: async () => { calls++; throw new Error('late model request'); }, release: () => { released++; } },
  }).result;
  assert.equal(calls, 0); assert.equal(released, 1);
  assert.equal(result.record.outcome.termination.code, 'limit.wall_clock');
});

for (const source of ['budget', 'supervisor', 'user'] as const) test(`external ${source} signal retains its provenance through the experiment workflow`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-signal-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const abort = new AbortController();
  const result = await startExperiment({ ...base, signal: abort.signal, compare: false,
    controller: { decide: async () => {
      abort.abort(source === 'budget' ? new DOMException('deadline', 'TimeoutError') : source === 'user' ? { source: 'user' } : new Error('supervisor stopped'));
      return { status: 'cancelled', factRef: 'external:stop' };
    } },
  }).result;
  assert.equal(result.record.outcome.termination.code, source === 'budget' ? 'limit.wall_clock' : `cancelled.${source}`);
  assert.equal(result.record.outcome.termination.initiatedBy, source === 'user' ? 'user' : 'harness');
});

test('factory task completion preserves explicit deliverables in proven rebuildable directories without a total deadline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-factory-retain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(join(base.sourceRoot, 'node_modules'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json', 'node_modules/delivery.txt']) await writeFile(join(base.sourceRoot, file), 'data');
  const original = base.taskCase;
  const { wallClockMs: _deadline, ...policy } = base.policy;
  const result = await startExperiment({ ...base, policy, compare: false,
    taskCase: () => ({ ...original, execution: {
      mode: 'task_completion', goal: 'preserve delivery', deliverables: ['node_modules/delivery.txt'], authorization: 'edit', snapshotRetainPaths: ['./NODE_MODULES\\delivery.txt'],
    } }),
  }).result;
  assert.equal(result.record.outcome.cleanup.status, 'complete');
  const scopeRef = result.record.artifactRefs.find(ref => ref.artifactId === 'candidate-workspace-scope.json');
  assert.ok(scopeRef);
  assert.equal(result.record.manifest?.environment.executionIsolation?.hostPrivateReads, 'unknown');
  const files = await import('node:fs/promises');
  const paths = await files.readdir(base.dataDir, { recursive: true });
  assert.ok(paths.some(path => path.replaceAll('\\', '/').endsWith('node_modules/delivery.txt')));
});

 test('budget interrupts an unsettled native wait instead of waiting for the per-turn timeout', async () => {
  const runner = new ScriptedRunner([{ delivery: 'accepted', evidence: 'native_admission' }], [new Promise(() => {})]);
  const run = new CandidateRun({ runner, policy: { turnTimeoutMs: 60_000, maxTargetTurns: 2 } });
  const pending = run.start({ id: 'm', text: 'work' }, { runId: 'r', turnIndex: 0, clientMessageId: 'c' });
  await new Promise(resolve => setTimeout(resolve, 20));
  await run.stopByHarness('limit.wall_clock');
  assert.equal(await pending, 'finished'); assert.equal(run.result().outcome.termination.code, 'limit.wall_clock');
 });
