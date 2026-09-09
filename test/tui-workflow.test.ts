import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperimentWorkflow, createHarnessWorkflow, TUI_RUN_POLICY } from '../src/application/experiment-workflow.js';
import { candidateStartBlocked, startRunSetup } from '../src/tui/controller-run.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiModelCaller } from '../src/infrastructure/agent/model-caller.js';
import { defaultHarnessModelConfig, saveHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { IntakeTui_showError } from '../src/tui/intake-tui-nav.js';
import { IntakeTui } from '../src/tui/intake-app.js';
import type { RecoveryView } from '../src/application/recovery/view.js';
import { mockTui } from '../scripts/tui-audit-lib.js';
import { waitFor } from './codex-intake-support.js';

test('TUI run policy is a last-resort safety valve, not a completion budget', () => {
  assert.equal(TUI_RUN_POLICY.maxTargetTurns, 256);
  assert.equal(TUI_RUN_POLICY.maxModelCalls, 256);
  assert.equal(TUI_RUN_POLICY.wallClockMs, 24 * 60 * 60_000);
  assert.equal(TUI_RUN_POLICY.turnTimeoutMs, 2 * 60 * 60_000);
});

test('connection probe failures preserve their phase and show localized retry guidance', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-probe-phase-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  await saveHarnessModelConfig(dataDir, defaultHarnessModelConfig());
  const cause = Object.assign(new Error('Upstream request failed: provider detail'), { status: 503 });
  t.mock.method(PiModelCaller.prototype, 'validate', async () => { throw cause; });
  const workflow = createHarnessWorkflow({ dataDir, now: () => new Date().toISOString() });
  await assert.rejects(workflow.recover({ taskCase: {} as never, sourceRoot: dataDir }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'HarnessProbeError');
    assert.equal(error.cause, cause);
    const view = { locale: 'zh', message: '', page: 'running' };
    IntakeTui_showError.call(view as never, error, 'home');
    assert.equal(view.page, 'error');
    assert.match(view.message, /连接探测.*暂时失败.*重试/);
    assert.doesNotMatch(view.message, /无法恢复|provider detail/);
    return true;
  });
});

test('recover publishes activity before the billable connection probe', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-probe-activity-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  await saveHarnessModelConfig(dataDir, defaultHarnessModelConfig());
  const order: string[] = [];
  t.mock.method(PiModelCaller.prototype, 'validate', async () => {
    order.push('probe');
    throw new Error('stop-after-probe-order');
  });
  const workflow = createHarnessWorkflow({ dataDir, now: () => new Date().toISOString() });
  await assert.rejects(workflow.recover({
    taskCase: { caseId: 'case-order', source: { productId: 'codex', sessionId: 's' } } as never,
    sourceRoot: dataDir,
    onActivity: () => { order.push('activity'); },
  }), /stop-after-probe-order|HarnessProbeError/);
  assert.deepEqual(order, ['activity', 'probe']);
});

test('production Recovery forwards cancellation to the probe and does not misclassify it', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-probe-cancel-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  await saveHarnessModelConfig(dataDir, defaultHarnessModelConfig());
  const abort = new AbortController();
  let seen: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(PiModelCaller.prototype, 'validate', async (signal?: AbortSignal) => {
    seen = signal;
    started();
    await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Operation cancelled', 'AbortError')), { once: true }));
    return {};
  });
  const workflow = createHarnessWorkflow({ dataDir, now: () => new Date().toISOString() });
  const pending = workflow.recover({ taskCase: {} as never, sourceRoot: dataDir, signal: abort.signal });
  await ready;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(seen?.aborted, true);
});

test('Ctrl+C during Recovery aborts preparation and never enters candidate selection', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-tui-recovery-cancel-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let signal: AbortSignal | undefined;
  const tui = mockTui();
  const app = new IntakeTui({
    dataDir, tui: tui.tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    workflow: {
      policy: TUI_RUN_POLICY,
      preflight: async () => ({ sourceBaseline: 'available', limitations: [] }),
      recover: async (request: { signal: AbortSignal }) => {
        signal = request.signal;
        await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new DOMException('Operation cancelled', 'AbortError')), { once: true }));
        throw new Error('cancelled recovery must not continue');
      },
    } as never,
  });
  t.after(() => app.close());
  await app.start();
  app.taskCase = { caseId: 'case-cancel', initialInput: { text: 'Create slides' }, taskContext: { historicalCwd: dataDir }, privacy: { redactions: [] } } as never;
  startRunSetup(app);
  await waitFor(() => signal !== undefined);
  assert.equal(app.page, 'running');
  app.handleInput('\u0003');
  await app.recoveryFinished;
  assert.equal(signal?.aborted, true);
  assert.equal(app.page, 'home');
  assert.match(app.message, /Recovery cancelled/);
  assert.equal(app.cancelling, false);
  assert.equal(app.recoveryAbort, undefined);
});

test('same-product defaults.candidate is kept instead of pack.defaultCandidate', () => {
  const custom = { candidateId: 'operator-pick', productId: 'fake', requestedModel: 'operator-model' };
  const workflow = createExperimentWorkflow({
    dataDir: 'unused',
    pack: fakeProductPack,
    now: () => '2026-08-14T00:00:00.000Z',
    defaults: { candidate: custom, policy: TUI_RUN_POLICY },
    agents: async () => {
      throw new Error('agents should not be created for this assertion');
    },
  });
  assert.deepEqual(workflow.candidate, custom);
  assert.equal(workflow.policy.maxTargetTurns, 256);
});

test('Ctrl+C while preflight is pending prevents a later Recovery call', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-preflight-cancel-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let release!: () => void;
  let calls = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const app = new IntakeTui({ dataDir, tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
    policy: TUI_RUN_POLICY,
    preflight: async () => { await pending; return { sourceBaseline: 'available', limitations: [] }; },
    recover: async () => { calls += 1; throw new Error('must not run'); },
  } as never });
  t.after(() => app.close());
  await app.start();
  app.taskCase = { caseId: 'case-cancel', initialInput: { text: 'Create slides' }, taskContext: { historicalCwd: dataDir }, privacy: { redactions: [] } } as never;
  startRunSetup(app);
  await waitFor(() => app.page === 'running');
  app.handleInput('\u0003');
  release();
  await waitFor(() => app.page === 'home');
  assert.equal(calls, 0);
  assert.equal(app.cancelling, false);
});

test('production workflow accepts a smoke policy without forcing a candidate model', () => {
  const policy = { ...TUI_RUN_POLICY, wallClockMs: 45 * 60_000, maxTargetTurns: 16, maxModelCalls: 24 };
  const workflow = createHarnessWorkflow({ dataDir: 'unused', now: () => '2026-09-06T00:00:00.000Z', defaults: { policy } });
  assert.deepEqual(workflow.policy, policy);
  assert.equal(workflow.candidate, undefined);
});

test('closing the TUI waits for cancelled Recovery cleanup', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-recovery-close-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const app = new IntakeTui({ dataDir, tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
    policy: TUI_RUN_POLICY,
    preflight: async () => ({ sourceBaseline: 'available', limitations: [] }),
    recover: async (request: { signal: AbortSignal }) => {
      signal = request.signal;
      await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup;
      throw new DOMException('Operation cancelled', 'AbortError');
    },
  } as never });
  t.after(() => { release(); app.close(); });
  await app.start();
  app.taskCase = { caseId: 'case-close', initialInput: { text: 'Create slides' }, taskContext: { historicalCwd: dataDir }, privacy: { redactions: [] } } as never;
  startRunSetup(app);
  await waitFor(() => signal !== undefined);
  app.close();
  assert.equal(signal?.aborted, true);
  let closed = false;
  const finished = app.closing.then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  await finished;
  assert.equal(closed, true);
  assert.equal(app.recoveryAbort, undefined);
});

test('closing preserves a late Recovery staging reference when cleanup fails', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-late-recovery-cleanup-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  let release!: () => void;
  let recovering = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const attempt = {
    experimentId: 'late-cleanup',
    experimentRoot: dataDir,
    baseline: { mode: 'canonical' },
    recovery: { status: 'completed', sessionId: 's', value: { status: 'ready', reportPath: 'recovery.md', unresolved: [] } },
    staging: { recoveryId: 'r', caseId: 'c', sourceRoot: dataDir, root: dataDir },
  };
  const app = new IntakeTui({ dataDir, tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
    policy: TUI_RUN_POLICY,
    preflight: async () => ({ sourceBaseline: 'available', limitations: [] }),
    recover: async () => { recovering = true; await pending; return attempt; },
    discardRecovery: async () => { throw new Error('private cleanup detail'); },
  } as never });
  t.after(() => { release(); app.close(); });
  await app.start();
  app.taskCase = { caseId: 'late-cleanup', initialInput: { text: 'Create slides' }, taskContext: { historicalCwd: dataDir }, privacy: { redactions: [] } } as never;
  startRunSetup(app);
  await waitFor(() => recovering);
  app.close();
  const rejected = assert.rejects(app.closing, /Cleanup did not complete/);
  release();
  await rejected;
  assert.equal(app.recoveryView?.experimentId, 'late-cleanup');
  assert.doesNotMatch(app.message, /private cleanup detail/);
});

test('Ctrl+C while accepting Recovery prevents experiment startup', async () => {
  let release!: () => void;
  let accepting = false;
  let starts = 0;
  let discarded = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
    policy: TUI_RUN_POLICY,
    verifyCandidate: async () => ({}),
    start: async () => { starts += 1; throw new Error('must not start'); },
    acceptRecovery: async () => { accepting = true; await pending; return {}; },
    discardRecovery: async () => { discarded += 1; },
  } as never });
  app.page = 'confirm';
  app.taskCase = { caseId: 'cancel-accept', initialInput: { text: 'Create slides' } } as never;
  app.selectedCandidate = { candidateId: 'candidate', productId: 'codex', requestedModel: 'fixture' };
  app.preflight = { sourceBaseline: 'available', limitations: [] } as never;
  app.recoveryView = {
    experimentId: 'cancel-accept',
    experimentRoot: 'unused',
    baseline: { mode: 'canonical' },
    recovery: { status: 'completed', sessionId: 's', value: { status: 'ready', reportPath: 'recovery.md', unresolved: [] } },
    hasAccept: true,
    staging: { recoveryId: 'r', caseId: 'c', sourceRoot: '/', root: '/' },
  } as unknown as RecoveryView;
  try {
    app.handleInput('\r');
    await waitFor(() => accepting);
    app.handleInput('\u0003');
    release();
    await app.workflowFinished;
    assert.equal(starts, 0);
    assert.equal(discarded, 1);
    assert.equal(app.page, 'home');
    assert.equal(app.cancelling, false);
  } finally { release(); app.close(); await app.closing; }
});

test('startup cancellation reaches the Harness probe and prevents experiment creation', async () => {
  const abort = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let observed: AbortSignal | undefined;
  const workflow = createExperimentWorkflow({ dataDir: 'unused', now: () => '2026-09-06T00:00:00.000Z',
    agents: async (signal) => { observed = signal; await pending; return {} as never; },
  });
  const started = workflow.start({ taskCase: {} as never, sourceRoot: 'unused', onEvent: () => {}, signal: abort.signal });
  abort.abort();
  const failure = assert.rejects(started, { name: 'AbortError' });
  release();
  await failure;
  assert.equal(observed?.aborted, true);
});

test('source blockedReasons do not block a recovered candidate', () => {
  assert.equal(
    candidateStartBlocked({
      sourceBaseline: 'unavailable',
      blockedReasons: ['symlink outside root'],
      recovery: { hasAccept: true, hasStaging: true, baselineMode: 'canonical', runnable: 'isolated' },
    }),
    undefined,
  );
});

test('close waits for the experiment terminal cleanup after cancel returns', async () => {
  const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  let release!: () => void;
  let cancelled = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  app.activeExperiment = { cancel: async () => { cancelled += 1; }, result: pending.then(() => ({ record: { outcome: { cleanup: { status: 'complete' } } } })) } as never;
  app.close();
  let closed = false;
  const finished = app.closing.then(() => { closed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
  assert.equal(closed, false);
  release();
  await finished;
  assert.equal(closed, true);
});

test('close discards cached recovery and preserves a failed cleanup for review', async () => {
  for (const fails of [false, true]) {
    let calls = 0;
    const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
      discardRecovery: async () => { calls += 1; if (fails) throw new Error('private provider detail'); },
    } as never });
    app.recoveryView = {
      experimentId: 'cached',
      experimentRoot: 'unused',
      baseline: { mode: 'canonical' },
      recovery: { status: 'completed', sessionId: 's', value: { status: 'ready', reportPath: 'recovery.md', unresolved: [] } },
      hasAccept: false,
      staging: { recoveryId: 'r', caseId: 'c', sourceRoot: '/', root: '/' },
    } as unknown as RecoveryView;
    app.close();
    if (fails) {
      await assert.rejects(app.closing, /Cleanup did not complete/);
      assert.equal(app.recoveryView?.experimentId, 'cached');
      assert.doesNotMatch(app.message, /private provider detail/);
    } else {
      await app.closing;
      assert.equal(app.recoveryView, undefined);
    }
    assert.equal(calls, 1);
  }
});

test('close releases the comparison choice without starting a report', async () => {
  const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  let chosen: boolean | undefined;
  app.workflowFinished = new Promise<void>((resolve) => { app.compareChoice = { resolve: (value) => { chosen = value; resolve(); } }; });
  app.page = 'compare-gate';
  app.close();
  await app.closing;
  assert.equal(chosen, false);
  assert.equal(app.compareChoice, undefined);
});

test('closing during startup waits for the late handle and its cleanup result', async (t) => {
  for (const cleanupStatus of ['complete', 'failed']) await t.test(cleanupStatus, async () => {
    let releaseStart!: () => void;
    let releaseResult!: () => void;
    let started = false;
    let cancelled = false;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    const result = new Promise<void>((resolve) => { releaseResult = resolve; });
    const app = new IntakeTui({ dataDir: 'unused', tui: mockTui().tui as never, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, workflow: {
      policy: TUI_RUN_POLICY,
      verifyCandidate: async () => ({}),
      start: async () => {
        started = true;
        await start;
        return { cancel: async () => { cancelled = true; }, result: result.then(() => ({ record: { outcome: { cleanup: { status: cleanupStatus } } } })) };
      },
    } as never });
    app.page = 'confirm';
    app.taskCase = { caseId: 'case-close' } as never;
    app.selectedCandidate = { candidateId: 'candidate', productId: 'codex', requestedModel: 'fixture' };
    app.preflight = { sourceBaseline: 'available', limitations: [] } as never;
    app.handleInput('\r');
    await waitFor(() => started);
    app.close();
    let closed = false;
    const completion = app.closing.then(() => { closed = true; });
    const failure = cleanupStatus === 'failed' ? assert.rejects(completion, /Cleanup did not complete/) : undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    releaseStart();
    await waitFor(() => cancelled);
    assert.equal(closed, false);
    releaseResult();
    if (failure) await failure;
    else { await completion; assert.equal(closed, true); }
  });
});

test('a failed recovery without a candidate still refuses to start', () => {
  assert.match(
    candidateStartBlocked({
      sourceBaseline: 'available',
      blockedReasons: [],
      recovery: { hasAccept: false, hasStaging: false, baselineMode: 'unsupported', runnable: 'unsupported' },
    }) ?? '',
    /runnable workspace/,
  );
});

test('current-state fallback without accept cannot start a candidate', () => {
  assert.match(
    candidateStartBlocked({
      sourceBaseline: 'available',
      blockedReasons: [],
      recovery: {
        hasAccept: false,
        hasStaging: true,
        baselineMode: 'canonical',
        runnable: 'isolated',
        userStatus: 'failed',
      },
    }) ?? '',
    /runnable workspace/,
  );
});

test('blocked recovery cannot start a candidate even if an accept handle leaked', () => {
  assert.match(
    candidateStartBlocked({
      sourceBaseline: 'available',
      blockedReasons: [],
      recovery: {
        hasAccept: true,
        hasStaging: true,
        baselineMode: 'canonical',
        runnable: 'blocked',
        userStatus: 'failed',
      },
    }) ?? '',
    /runnable workspace/,
  );
});
