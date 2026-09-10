import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedRuntimeEnvironment, ResolvedRuntime } from '../../src/core/runtime.js';
import type { CandidateLaunchContext } from '../../src/core/schema.js';
import { forceCloseRuntimeProcess } from '../../src/infrastructure/process/terminate.js';
import {
  assertIsolatedLaunchWorkspace,
  availableFromInspect,
  inspectRuntimeAvailability,
  LOCAL_SESSION_RECOVERY_CAPABILITIES,
  TtlCache,
} from '../../src/products/shared/runtime-host.js';
import {
  compactSessionText,
  emptyDiscoverySummaryState,
  recordLaterUserSummary,
  requireDiscoveredSessionId,
  sessionSummaryFromDiscovery,
} from '../../src/products/shared/session-summaries.js';
import { SessionDiscoveryError } from '../../src/products/shared/session-files.js';
import { assertRuntimeMessageIdentity, TurnWaiter } from '../../src/products/shared/turn-wait.js';

test('TtlCache returns a value until expiry then forgets it', async () => {
  const cache = new TtlCache<string>(20);
  cache.set('k', 'v');
  assert.equal(cache.get('k'), 'v');
  await new Promise((resolveWait) => setTimeout(resolveWait, 30));
  assert.equal(cache.get('k'), undefined);
  cache.set('k', 'v2');
  cache.clear();
  assert.equal(cache.get('k'), undefined);
});

test('inspect helpers map installed and missing executables', () => {
  const missing = inspectRuntimeAvailability({
    productId: 'codex',
    executable: undefined,
    installHint: 'Install Codex.',
  });
  assert.equal(missing[0]?.status, 'not_installed');
  assert.deepEqual(availableFromInspect(missing), []);
  const found = inspectRuntimeAvailability({
    productId: 'codex',
    executable: 'C:\\codex.cmd',
    observedVersion: '1',
    installHint: 'Install Codex.',
  });
  assert.deepEqual(availableFromInspect(found), [{ productId: 'codex', executable: 'C:\\codex.cmd', version: '1' }]);
});

test('assertIsolatedLaunchWorkspace rejects a relative workspace', () => {
  const runtime = { productId: 'codex', executable: 'x', requestedModel: 'm', resolvedModel: 'm' } as ResolvedRuntime;
  const environment = { root: 'relative' } as PreparedRuntimeEnvironment;
  const launch = { workspaceRoot: 'relative' } as CandidateLaunchContext;
  assert.throws(
    () => assertIsolatedLaunchWorkspace({
      runtime,
      environment,
      launch,
      expectedProductId: 'codex',
      wrongProduct: 'wrong',
      relativeRoot: 'relative-root',
      mismatch: 'mismatch',
      fail: (message) => new Error(message),
    }),
    /relative-root/,
  );
  assert.equal(LOCAL_SESSION_RECOVERY_CAPABILITIES.sessionHistory, 'available');
});

test('TurnWaiter queues a settlement, rejects a second waiter, and cancel drops the queue', async () => {
  const turns = new TurnWaiter();
  turns.deliver({ turnId: 't1', status: 'completed', confidence: 'native', observedAt: '2026-01-01T00:00:00.000Z', rawRefs: [] });
  assert.equal((await turns.wait('busy')).turnId, 't1');
  const pending = turns.wait('busy');
  await assert.rejects(turns.wait('busy'), /busy/);
  turns.fail(new Error('gone'));
  await assert.rejects(pending, /gone/);
  turns.deliver({ turnId: 't2', status: 'completed', confidence: 'native', observedAt: '2026-01-01T00:00:00.000Z', rawRefs: [] });
  turns.cancel(new Error('timeout'));
  turns.deliver({ turnId: 't3', status: 'completed', confidence: 'native', observedAt: '2026-01-01T00:00:00.000Z', rawRefs: [] });
  assert.equal((await turns.wait('busy')).turnId, 't3');
  const waiting = turns.wait('busy');
  turns.cancel(new Error('timeout'));
  await assert.rejects(waiting, /timeout/);
  turns.stash(new Error('late'));
  await assert.rejects(turns.wait('busy'), /late/);
});

test('assertRuntimeMessageIdentity requires safe ids and non-empty text', () => {
  assert.throws(
    () => assertRuntimeMessageIdentity({ id: 'bad id', text: 'hi' }, { runId: 'run', turnIndex: 0, clientMessageId: 'msg' }, 'Codex'),
    /Codex runtime message identity/,
  );
  assertRuntimeMessageIdentity(
    { id: 'msg1', text: 'hi' },
    { runId: 'run1', turnIndex: 0, clientMessageId: 'client1' },
    'Codex',
  );
});

test('session summary helpers compact user text and require a session id', () => {
  const state = emptyDiscoverySummaryState();
  recordLaterUserSummary(state, '  first   line  ');
  recordLaterUserSummary(state, 'second');
  assert.equal(state.summary, compactSessionText('  first   line  '));
  assert.deepEqual(state.laterUserSummaries, ['second']);
  assert.throws(() => requireDiscoveredSessionId(undefined, 'Codex', 'head'), (error: unknown) => error instanceof SessionDiscoveryError);
  assert.throws(() => requireDiscoveredSessionId(undefined, 'Claude', 'full'), /Claude session metadata has no valid id/);
  state.sessionId = 'sess';
  state.cwd = 'C:\\proj';
  const summary = sessionSummaryFromDiscovery({
    productId: 'codex',
    entry: { path: 'C:\\rollout.jsonl', mtime: Date.parse('2026-01-02T00:00:00.000Z'), size: 1 },
    sourcePath: 'C:\\rollout.jsonl',
    state,
    recoveryReadiness: 'verified',
    evidenceLevel: 'transcript',
  });
  assert.equal(summary.sourceKind, 'rollout-only');
  assert.equal(summary.evidenceLevel, 'transcript');
  assert.equal(summary.updatedAtSource, 'file-mtime');
});

test('forceCloseRuntimeProcess returns when the child already closed', async () => {
  const child = { pid: 1, killed: true } as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
  await forceCloseRuntimeProcess(child, Promise.resolve(), () => new Error('still alive'));
});
