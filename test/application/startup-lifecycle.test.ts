import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once, getEventListeners } from 'node:events';
import { Value } from '@sinclair/typebox/value';
import { startExperiment } from '../../src/application/experiment.js';
import { createExperimentWorkflow } from '../../src/application/experiment-workflow.js';
import { persistTaskCase } from '../../src/application/experiment-helpers.js';
import { requestInProcessCancel, registerActivity, activityControlReady, finishActivity } from '../../src/application/experiment-activity.js';
import { enqueueControlWork } from '../../src/application/experiment-control-host.js';
import { LocalWorkspaceProvider, type PreparedEnvironmentRef } from '../../src/environment/local-workspace-provider.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { RunStartupFailureSchema, RunCleanupFailureSchema } from '../../src/core/schema.js';
import { codexProductPack } from '../../src/products/packs/codex/pack.js';
import { createProductLookup } from '../../src/products/index.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'reprise-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtime = new VerifiedRuntime();
  const base = { ...input(root, runtime), compare: false };
  await fs.mkdir(base.sourceRoot);
  await fs.writeFile(join(base.sourceRoot, 'original.txt'), 'source stays unchanged');
  const experimentRoot = join(base.dataDir, 'experiments', base.experimentId);
  return { root, base, runtime, experimentRoot };
}

async function assertStartup(f: Awaited<ReturnType<typeof fixture>>, stage: string) {
  const store = await ExperimentStore.open(f.experimentRoot, f.base.experimentId);
  const failure: unknown = JSON.parse(await fs.readFile(join(f.experimentRoot, 'runs', f.base.runId, 'startup-failure.json'), 'utf8'));
  assert.ok(Value.Check(RunStartupFailureSchema, failure));
  assert.equal(failure.stage, stage);
  assert.equal(failure.experimentId, f.base.experimentId);
  assert.equal(failure.runId, f.base.runId);
  assert.equal(store.events(f.base.runId).filter(event => event.type === 'run.attempt_created').length, 1);
  assert.equal(store.events(f.base.runId).filter(event => event.type === 'run.startup_failed').length, 1);
  assert.equal(store.events(f.base.runId).some(event => event.type === 'run.finished' || event.type === 'candidate.session_bound'), false);
  await assert.rejects(fs.stat(join(f.experimentRoot, 'runs', f.base.runId, 'manifest.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(join(f.experimentRoot, 'writer.lock')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(join(f.base.sourceRoot, 'original.txt'), 'utf8'), 'source stays unchanged');
  return failure;
}

for (const stage of ['runtime', 'baseline', 'checkpoint', 'prepare', 'runner'] as const) {
  test(`accepted startup ${stage} failure closes activity and writer without fabricated Candidate completion`, async t => {
    const f = await fixture(t);
    const reject = async () => { throw new Error(`${stage} injected failure`); };
    if (stage === 'runtime') t.mock.method(f.runtime, 'validateCandidate', reject);
    if (stage === 'baseline') t.mock.method(LocalWorkspaceProvider.prototype, 'resolveBaseline', reject);
    if (stage === 'checkpoint') t.mock.method(LocalWorkspaceProvider.prototype, 'captureRecoveryCheckpoint', reject);
    if (stage === 'prepare') t.mock.method(LocalWorkspaceProvider.prototype, 'prepareRun', reject);
    if (stage === 'runner') t.mock.method(f.runtime, 'createRunner', reject);
    const handle = startExperiment(f.base);
    await assert.rejects(handle.result, new RegExp(`${stage} injected failure`));
    await assertStartup(f, stage);
    assert.equal(handle.activity?.status, 'finished');
    assert.equal(f.runtime.created, 0);
  });
}

for (const stage of ['materialize', 'launch'] as const) {
  test(`failure after workspace preparation at ${stage} releases only the Candidate workspace`, async t => {
    const f = await fixture(t);
    let releases = 0;
    const release = Object.getOwnPropertyDescriptor(LocalWorkspaceProvider.prototype, 'release')!.value as LocalWorkspaceProvider['release'];
    t.mock.method(LocalWorkspaceProvider.prototype, 'release', async function (this: LocalWorkspaceProvider, environment: PreparedEnvironmentRef) {
      releases++;
      return release.call(this, environment);
    });
    if (stage === 'materialize') {
      const external = join(f.root, 'outside.txt');
      await fs.writeFile(external, 'external input');
      await fs.writeFile(join(f.base.sourceRoot, 'imported-inputs'), 'conflicting file');
      f.base.taskCase.initialInput.text = `Read ${external}`;
    }
    const handle = startExperiment({ ...f.base, ...(stage === 'launch' ? { requireObservations: true } : {}) });
    await assert.rejects(handle.result);
    await assertStartup(f, stage);
    assert.equal(releases, 1);
    assert.equal(f.runtime.created, 0);
    assert.equal(handle.activity?.status, 'finished');
  });
}

test('metadata publication failure keeps a submitted attempt and releases activity/lease', async t => {
  const f = await fixture(t);
  const link = fs.link;
  t.mock.method(fs, 'link', async (temporary: string, target: string) => {
    if (target.endsWith('preflight.json')) throw new Error('metadata disk failure');
    return link(temporary, target);
  });
  await assert.rejects(startExperiment(f.base).result, /metadata disk failure/);
  await assertStartup(f, 'metadata');
});

function workflowFor(f: Awaited<ReturnType<typeof fixture>>) {
  return createExperimentWorkflow({ dataDir: f.base.dataDir,
    lookup: createProductLookup([{ ...codexProductPack, runtime: f.runtime }]),
    defaults: { candidate: f.base.candidate, policy: f.base.policy }, now: () => f.base.now,
    agents: async () => { throw new Error('agents initialization failed'); } });
}

for (const operation of ['start', 'recover'] as const) {
  test(`workflow ${operation} agent initialization failure leaves an owned terminal preparation`, async t => {
    const f = await fixture(t);
    const workflow = workflowFor(f);
    let activity: import('../../src/application/experiment-activity.js').ExperimentActivity | undefined;
    const request = { taskCase: f.base.taskCase, sourceRoot: f.base.sourceRoot, onEvent: () => undefined,
      experimentId: f.base.experimentId, runId: f.base.runId, onActivity: (value: NonNullable<typeof activity>) => { activity = value; } };
    if (operation === 'start') {
      await assert.rejects(workflow.start(request), /agents initialization failed/);
      await assertStartup(f, 'agents');
    } else {
      await assert.rejects(workflow.recover(request), /agents initialization failed/);
      assert.ok(activity);
      const experimentRoot = join(f.base.dataDir, 'experiments', activity.experimentId);
      const store = await ExperimentStore.open(experimentRoot, activity.experimentId);
      assert.ok(store.events().some(event => event.type === 'recovery.attempt'));
      assert.equal(store.events().some(event => event.type === 'run.attempt_created'), false);
      assert.ok(store.events().some(event => event.type === 'recovery.preflight_failed'));
      await assert.rejects(fs.stat(join(experimentRoot, 'writer.lock')), { code: 'ENOENT' });
    }
    assert.equal(activity?.status, 'finished');
    assert.equal((await requestInProcessCancel(activity.operationId)).status, 'already_finished');
    assert.equal(f.runtime.created, 0);
  });
}

test('onActivity failure is recorded after admission and does not leave running control ownership', async t => {
  const f = await fixture(t);
  await assert.rejects(workflowFor(f).start({ taskCase: f.base.taskCase, sourceRoot: f.base.sourceRoot,
    experimentId: f.base.experimentId, runId: f.base.runId, onEvent: () => undefined,
    onActivity: () => { throw new Error('activity callback failed'); } }), /activity callback failed/);
  await assertStartup(f, 'activity');
  await assert.rejects(fs.stat(join(f.experimentRoot, 'control.json')), { code: 'ENOENT' });
});

test('original startup and workspace-release failure are both retained, including journal cleanup diagnostics', async t => {
  const f = await fixture(t);
  t.mock.method(f.runtime, 'createRunner', async () => { throw new Error('runner original failure'); });
  t.mock.method(LocalWorkspaceProvider.prototype, 'release', async () => { throw new Error('workspace cleanup failure'); });
  await assert.rejects(startExperiment(f.base).result, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  const failure = await assertStartup(f, 'runner');
  assert.match(failure.error.message, /runner original failure/);
  assert.match(failure.cleanupErrors[0]!.error.message, /workspace cleanup failure/);
  const store = await ExperimentStore.open(f.experimentRoot, f.base.experimentId);
  assert.ok(store.events().some(event => event.type === 'run.cleanup_failed' && Value.Check(RunCleanupFailureSchema, event.payload)));
});

test('late store close failure rejects success and adds a supplemental fact without replacing the sealed record', async t => {
  const f = await fixture(t);
  const close = Object.getOwnPropertyDescriptor(ExperimentStore.prototype, 'close')!.value as ExperimentStore['close'];
  const owners: ExperimentStore[] = [];
  t.mock.method(ExperimentStore.prototype, 'close', async function (this: ExperimentStore) {
    owners.push(this);
    throw new Error('late lock release failure');
  });
  const handle = startExperiment(f.base);
  await assert.rejects(handle.result, /late lock release failure/);
  assert.equal(handle.activity?.status, 'finished');
  const owner = owners[0];
  assert.ok(owner);
  const events = owner.events(f.base.runId);
  assert.ok(events.some(event => event.type === 'run.finished'));
  const late = events.find(event => event.type === 'run.cleanup_failed');
  assert.ok(late && Value.Check(RunCleanupFailureSchema, late.payload));
  assert.match(late.payload.error.message, /late lock release failure/);
  const recordPath = join(f.experimentRoot, 'runs', f.base.runId, 'record.json');
  const before = await fs.readFile(recordPath);
  await close.call(owner);
  assert.deepEqual(await fs.readFile(recordPath), before);
});

test('immutable startup failure persistence errors are propagated alongside the original fault', async t => {
  const f = await fixture(t);
  t.mock.method(f.runtime, 'validateCandidate', async () => { throw new Error('runtime original'); });
  const link = fs.link;
  t.mock.method(fs, 'link', async (temporary: string, target: string) => {
    if (target.endsWith('startup-failure.json')) throw new Error('failure record disk error');
    return link(temporary, target);
  });
  await assert.rejects(startExperiment(f.base).result, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  await assert.rejects(fs.stat(join(f.experimentRoot, 'writer.lock')), { code: 'ENOENT' });
  const store = await ExperimentStore.open(f.experimentRoot, f.base.experimentId);
  assert.equal(store.events().some(event => event.type === 'run.startup_failed'), false);
});

test('control publication failure has a startup diagnostic and no live activity or overwritten source', async t => {
  const f = await fixture(t);
  await fs.mkdir(join(f.experimentRoot, 'control.json'), { recursive: true });
  const handle = startExperiment(f.base);
  await assert.rejects(handle.result);
  await assertStartup(f, 'activity');
  assert.equal(handle.activity?.status, 'finished');
});

test('startup cancellation is idempotent, records its current phase and removes the external listener', async t => {
  const f = await fixture(t);
  let entered: () => void = () => undefined;
  let proceed: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const unblock = new Promise<void>(resolve => { proceed = resolve; });
  t.mock.method(f.runtime, 'validateCandidate', async () => { entered(); await unblock; return f.runtime.resolve(f.base.candidate); });
  const external = new AbortController();
  const handle = startExperiment({ ...f.base, signal: external.signal });
  await ready;
  const first = handle.cancel();
  const second = handle.cancel();
  proceed();
  await Promise.all([first, second]);
  await assert.rejects(handle.result, { name: 'AbortError' });
  const failure = await assertStartup(f, 'runtime');
  assert.equal(failure.status, 'cancelled');
  assert.equal(failure.cancellationSource, 'user');
  assert.equal(handle.activity?.status, 'finished');
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test('borrowed baseline remains byte-identical when an owned Candidate preparation fails', async t => {
  const f = await fixture(t);
  const provider = new LocalWorkspaceProvider(join(f.experimentRoot, 'environment'));
  const baseline = await provider.resolveBaseline({ caseId: f.base.caseId, sourceRoot: f.base.sourceRoot }, [], {});
  assert.ok(baseline.root);
  const before = await fs.readFile(join(baseline.root, 'original.txt'));
  const released: string[] = [];
  const release = provider.release.bind(provider);
  t.mock.method(provider, 'release', async (environment: PreparedEnvironmentRef) => { released.push(environment.root); return release(environment); });
  await assert.rejects(startExperiment({ ...f.base, environmentProvider: provider, preResolvedBaseline: baseline, requireObservations: true }).result);
  assert.deepEqual(await fs.readFile(join(baseline.root, 'original.txt')), before);
  assert.equal(released.length, 1);
  assert.notEqual(released[0], baseline.root);
  await assertStartup(f, 'launch');
});

test('attempt journal failure rejects before activity registration or Runtime preparation', async t => {
  const f = await fixture(t);
  const append = Object.getOwnPropertyDescriptor(ExperimentStore.prototype, 'append')!.value as ExperimentStore['append'];
  t.mock.method(ExperimentStore.prototype, 'append', async function (this: ExperimentStore, event: Parameters<typeof append>[0]) {
    if (event.type === 'run.attempt_created') throw new Error('attempt audit disk error');
    return append.call(this, event);
  });
  const handle = startExperiment(f.base);
  await assert.rejects(handle.result, /attempt audit disk error/);
  assert.equal(handle.activity, undefined);
  assert.equal(f.runtime.created, 0);
  await assert.rejects(fs.stat(join(f.experimentRoot, 'writer.lock')), { code: 'ENOENT' });
  const store = await ExperimentStore.open(f.experimentRoot, f.base.experimentId);
  assert.deepEqual(store.events(), []);
});

test('malformed replacement lock is retained and close reports inability to verify ownership', async t => {
  const f = await fixture(t);
  const store = await ExperimentStore.open(f.experimentRoot, f.base.experimentId);
  await store.acquireWriter();
  const path = join(f.experimentRoot, 'writer.lock');
  await fs.writeFile(path, 'malformed lock');
  await assert.rejects(store.close(), /ownership cannot be verified/);
  assert.equal(await fs.readFile(path, 'utf8'), 'malformed lock');
});

test('Recovery retains its writer until delayed control retirement finishes, preventing a new owner race', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  t.after(() => release());
  let activity: import('../../src/application/experiment-activity.js').ExperimentActivity | undefined;
  const pending = workflowFor(f).recover({ taskCase: f.base.taskCase, sourceRoot: f.base.sourceRoot,
    onActivity: value => {
      activity = value;
      void enqueueControlWork(async () => { entered(); await gate; });
    } });
  const rejected = assert.rejects(pending, /agents initialization failed/);
  await ready;
  while (activity?.status !== 'finished') await new Promise<void>(resolve => setImmediate(resolve));
  const experimentRoot = join(f.base.dataDir, 'experiments', activity.experimentId);
  await fs.stat(join(experimentRoot, 'writer.lock'));
  const contender = await ExperimentStore.open(experimentRoot, activity.experimentId);
  await assert.rejects(contender.acquireWriter(), /active writer/);
  const before: unknown = JSON.parse(await fs.readFile(join(experimentRoot, 'control.json'), 'utf8'));
  assert.ok(before && typeof before === 'object' && 'operationId' in before);
  assert.equal(before.operationId, activity.operationId);
  release();
  await rejected;
  await contender.acquireWriter();
  const next = registerActivity({ kind: 'run', experimentId: activity.experimentId, runId: 'run-next',
    dataDir: f.base.dataDir, cancel: async () => undefined });
  await activityControlReady(next);
  const current: unknown = JSON.parse(await fs.readFile(join(experimentRoot, 'control.json'), 'utf8'));
  assert.ok(current && typeof current === 'object' && 'operationId' in current);
  assert.equal(current.operationId, next.operationId);
  await finishActivity(next);
  await contender.close();
});

for (const shared of [true, false]) {
  test(`two real processes ${shared ? 'reject the non-owner of one experiment before preparation' : 'prepare different experiments independently'}`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    await persistTaskCase(join(f.base.dataDir, 'cases', f.base.caseId, 'case.json'), f.base.taskCase);
    const children = ['first', 'second'].map((id) => {
      const experimentId = shared ? 'experiment-shared' : `experiment-${id}`;
      const child = fork(new URL('../support/startup-owner-child.js', import.meta.url), [f.root, experimentId, `run-${id}`], { silent: true });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const messages: { status: string; runId: string; message?: string }[] = [];
      const first = once(child, 'message').then(([message]: unknown[]) => {
        assert.ok(message && typeof message === 'object' && 'status' in message && typeof message.status === 'string' && 'runId' in message && typeof message.runId === 'string');
        return { status: message.status, runId: message.runId };
      });
      child.on('message', (message: unknown) => {
        assert.ok(message && typeof message === 'object' && 'status' in message && typeof message.status === 'string' && 'runId' in message && typeof message.runId === 'string');
        messages.push({ status: message.status, runId: message.runId,
          ...('message' in message && typeof message.message === 'string' ? { message: message.message } : {}) });
      });
      const done = once(child, 'exit').then(([code]) => { assert.equal(code, 0, stderr); return messages; });
      return { child, first, done, experimentId };
    });
    for (const worker of children) worker.child.send('start');
    const outcomes = await Promise.all(children.map(worker => worker.first));
    assert.deepEqual(outcomes.map(item => item.status).sort(), shared ? ['owned', 'rejected'] : ['owned', 'owned']);
    for (const [index, outcome] of outcomes.entries()) {
      const worker = children[index]!;
      if (outcome.status === 'owned') {
        const root = join(f.base.dataDir, 'experiments', worker.experimentId);
        assert.deepEqual(await fs.readdir(join(root, 'runs')), [outcome.runId]);
        const store = await ExperimentStore.open(root, worker.experimentId);
        assert.equal(store.events().filter(event => event.type === 'run.attempt_created').length, 1);
        await assert.rejects(fs.stat(join(root, 'environment')), { code: 'ENOENT' });
        worker.child.send('release');
      }
    }
    const results = (await Promise.all(children.map(worker => worker.done))).flat();
    assert.equal(results.filter(item => item.status === 'finished').length, shared ? 1 : 2, JSON.stringify(results));
    if (shared) assert.match(results.find(item => item.status === 'rejected')!.message!, /active writer/);
    for (const worker of children) await assert.rejects(fs.stat(join(f.base.dataDir, 'experiments', worker.experimentId, 'writer.lock')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(join(f.base.sourceRoot, 'original.txt'), 'utf8'), 'source stays unchanged');
  });
}
