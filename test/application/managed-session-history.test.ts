import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveManagedSession, assertNotManagedImport, bindManagedSession, discoverManagedSessions, inspectManagedSession, managedProjectKey, mergeManagedSessions } from '../../src/application/managed-session-history.js';
import type { CandidateLaunchContext } from '../../src/core/schema.js';
import type { TargetRunner } from '../../src/core/runtime.js';
import { claudeSessionAdapter } from '../../src/products/packs/claude-code/sessions.js';
import { isEligibleSession, type SessionDiscoveryPage } from '../../src/products/contract.js';
import { sessionGroupingKey } from '../../src/products/shared/session-project.js';
import { listSourceProjects, listSourceSessions } from '../../src/application/experiment-queries.js';
import { CodexTargetRunner } from '../../src/products/packs/codex/runner.js';
import { ClaudeTargetRunner } from '../../src/products/packs/claude-code/runner.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const emptyPage: SessionDiscoveryPage = { items: [], scanned: 0, skipped: 0, diagnostics: [] };

test('native transcript roots follow the frozen candidate configuration and custom Claude argv stays undeclared', () => {
  const root = join(tmpdir(), 'reprise-test-frozen-workspace');
  const environment = { environmentId: 'environment-a', runId: 'run-a', root };
  const sink = { append: () => Promise.resolve() };
  const runtime = { productId: 'codex', executable: 'unused', requestedModel: 'model-a', resolvedModel: 'model-a' };
  const codex = new CodexTargetRunner({ runtime, environment, sink, effort: 'high', sandbox: 'read-only', completeEnv: { CODEX_HOME: 'private-codex' } });
  assert.equal(codex.historySource().root, join(root, 'private-codex', 'sessions'));
  const claude = new ClaudeTargetRunner({ runtime: { ...runtime, productId: 'claude-code' }, environment, sink, completeEnv: { CLAUDE_CONFIG_DIR: 'private-claude' } });
  assert.equal(claude.historySource()?.root, join(root, 'private-claude', 'projects'));
  assert.equal(claude.observableConfig().sessionPersistence, 'on');
  const custom = new ClaudeTargetRunner({ runtime: { ...runtime, productId: 'claude-code' }, environment, sink, args: ['custom'] });
  assert.equal(custom.historySource(), undefined);
  assert.equal(custom.observableConfig().sessionPersistence, 'unknown');
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-managed-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const nativeRoot = join(root, 'native');
  const workspace = join(root, 'workspace');
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(workspace);
  const sourcePath = join(nativeRoot, `${SESSION_ID}.jsonl`);
  const content = [
    { type: 'user', sessionId: SESSION_ID, cwd: workspace, timestamp: '2026-10-19T00:00:00.000Z', message: { role: 'user', content: 'Fix SECRET.' } },
    { type: 'assistant', sessionId: SESSION_ID, cwd: workspace, timestamp: '2026-10-19T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed SECRET.' }], stop_reason: 'end_turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(sourcePath, content);
  const launch: CandidateLaunchContext = { schemaVersion: 1, experimentId: 'experiment-a', runId: 'run-a', productId: 'claude-code', requestedModel: 'model-a', resolvedModel: 'model-a', workspaceRoot: workspace, permissions: {} };
  const runner = { session: () => ({ sessionId: SESSION_ID, productId: 'claude-code', requestedModel: 'model-a', resolvedModel: 'model-a', workspaceRoot: workspace }), historySource: () => ({ root: nativeRoot, sourcePath }) } as TargetRunner;
  const receipt = (await bindManagedSession(dataDir, launch, runner))!;
  return { root, dataDir, nativeRoot, workspace, sourcePath, content, launch, runner, receipt };
}

test('managed history survives native cleanup, deduplicates and remains read-only run evidence', async t => {
  const f = await fixture(t);
  const archived = await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: ['SECRET'], signal: new AbortController().signal });
  assert.equal(archived.status, 'archived');
  await rm(f.nativeRoot, { recursive: true });
  const first = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, emptyPage);
  assert.equal(first.items.length, 1);
  const summary = first.items[0]!;
  assert.equal(sessionGroupingKey(summary), managedProjectKey('claude-code'));
  assert.equal(summary.cwd, f.workspace);
  assert.equal(summary.model, undefined);
  assert.equal(Object.hasOwn(summary, 'transcript'), false);
  assert.equal(Object.hasOwn(summary, 'finalMessage'), false);
  assert.equal(isEligibleSession(summary), false);
  assert.equal(summary.managed?.runId, 'run-a');
  const inspection = await inspectManagedSession(f.dataDir, claudeSessionAdapter, summary);
  assert.equal(inspection?.model, undefined);
  assert.equal(inspection?.transcript[0]?.text, 'Fix [REDACTED].');
  assert.ok(!(await readFile(summary.sourcePath, 'utf8')).includes('SECRET'));
  const { projectKey: _project, managed: _managed, ...nativeSummary } = summary;
  const duplicate = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, { ...emptyPage, items: [nativeSummary] });
  assert.equal(duplicate.items.length, 1);
  assert.deepEqual(duplicate.projects, [{ key: managedProjectKey('claude-code'), label: 'Reprise' }]);
  await assert.rejects(assertNotManagedImport(f.dataDir, summary), /read-only run evidence/);
  await writeFile(summary.sourcePath, f.content);
  await assert.rejects(inspectManagedSession(f.dataDir, claudeSessionAdapter, summary), /integrity mismatch/);
  const damaged = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, emptyPage);
  assert.equal(damaged.items[0]?.availability, 'unreadable');
});

test('archived previews remain readable when native discovery retains only an index or an unreadable source', async t => {
  const f = await fixture(t);
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const archived = await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  assert.equal(archived.status, 'archived');
  await rm(f.nativeRoot, { recursive: true });
  for (const availability of ['catalog-only', 'unreadable'] as const) {
    const stale = { ...native, availability, recoveryReadiness: 'corrupt' as const,
      signals: { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 } };
    const page = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, { ...emptyPage, items: [stale] });
    assert.equal(page.items.length, 1);
    const summary = page.items[0]!;
    assert.equal(summary.availability, 'indexed');
    assert.equal(summary.recoveryReadiness, 'pending');
    assert.deepEqual(summary.signals, archived.preview!.signals);
    assert.equal(summary.signals.userMessages, 1);
    const inspected = await inspectManagedSession(f.dataDir, claudeSessionAdapter, summary);
    assert.equal(inspected?.transcript[0]?.text, 'Fix SECRET.');
  }
});

test('managed history preserves the model recorded by the native transcript instead of the requested alias', async t => {
  const f = await fixture(t);
  await writeFile(f.sourcePath, f.content.replace('"role":"assistant"', '"role":"assistant","model":"actual-native-model"'));
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const recording = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, { ...emptyPage, items: [native] });
  assert.equal(recording.items[0]?.model, 'actual-native-model');
  const archived = await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.requestedModel, 'model-a');
  assert.equal(archived.preview?.model, 'actual-native-model');
  await rm(f.nativeRoot, { recursive: true });
  const page = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, emptyPage);
  assert.equal(page.items[0]?.model, 'actual-native-model');
  assert.equal((await inspectManagedSession(f.dataDir, claudeSessionAdapter, page.items[0]))?.model, 'actual-native-model');
});

test('recording receipts survive restart and allow verified native reads after a crash', async t => {
  const f = await fixture(t);
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const page = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, { ...emptyPage, items: [native] });
  assert.equal(Object.hasOwn(page.items[0]!, 'transcript'), false);
  assert.equal(page.items[0]?.managed?.status, 'recording');
  assert.equal(page.items[0]?.signals.userMessages, 1);
  assert.equal((await inspectManagedSession(f.dataDir, claudeSessionAdapter, page.items[0]))?.cwd, f.workspace);
});

test('archive failure preserves a diagnostic and still allows a valid native transcript to be read', async t => {
  const f = await fixture(t);
  const runner = { ...f.runner, historySource: () => ({ root: f.nativeRoot, sourcePath: join(f.root, 'outside.jsonl') }) } as TargetRunner;
  const result = await archiveManagedSession({ ...f, runner, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.diagnostic, 'native-transcript-archive-failed');
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const page = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, { ...emptyPage, items: [native] });
  assert.equal(page.items[0]?.signals.userMessages, 1);
  assert.equal(page.items[0]?.managed?.status, 'unavailable');
});

test('managed archive rejects wrong session/workspace and honors cancellation before publishing', async t => {
  const f = await fixture(t);
  await writeFile(f.sourcePath, f.content.replaceAll(f.workspace.replaceAll('\\', '\\\\'), join(f.root, 'wrong').replaceAll('\\', '\\\\')));
  const invalid = await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  assert.equal(invalid.status, 'unavailable');
  await writeFile(f.sourcePath, f.content);
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  await assert.rejects(archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: abort.signal }), /cancelled/);
  assert.equal((await mergeManagedSessions(f.dataDir, 'other-pack', claudeSessionAdapter, emptyPage)).items.length, 0);
  const legacy = { ...f.runner };
  delete legacy.historySource;
  assert.equal(await bindManagedSession(f.dataDir, f.launch, legacy), undefined);
});

test('managed list uses bounded receipt previews without reading bodies and isolates damaged receipts', async t => {
  const f = await fixture(t);
  await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  const archive = join(f.dataDir, 'managed-sessions');
  await writeFile(join(archive, 'f'.repeat(64) + '.json'), '{"schemaVersion":');
  await writeFile(join(archive, 'e'.repeat(64) + '.json'), JSON.stringify({ productId: 'other-product' }));
  const neverInspect = { ...claudeSessionAdapter, inspect: () => { throw new Error('List must not parse transcript bodies.'); } };
  const page = await mergeManagedSessions(f.dataDir, 'claude-code', neverInspect, emptyPage);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.signals.userMessages, 1);
  assert.equal(page.items[0]?.availability, 'indexed');
  assert.equal(page.diagnostics.filter(item => item.code === 'invalid-metadata').length, 2);
  assert.equal(Object.hasOwn(page.items[0], 'transcript'), false);
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const other = { ...native, sessionId: 'other-session', sourcePath: join(f.root, 'other.jsonl') };
  const preserved = await mergeManagedSessions(f.dataDir, 'claude-code', neverInspect, { ...emptyPage, items: [native, other] });
  assert.equal(preserved.items.length, 2);
  assert.ok(preserved.projects?.some(project => project.path === f.workspace));
  const metadata = (await readdir(archive)).find(name => name.endsWith('.json') && !name.startsWith('f'.repeat(64)) && !name.startsWith('e'.repeat(64)))!;
  const contents = JSON.parse(await readFile(join(archive, metadata), 'utf8')) as Record<string, unknown>;
  contents.status = 'archived';
  contents.digest = '0'.repeat(64);
  await writeFile(join(archive, metadata), JSON.stringify(contents));
  const stillListed = await mergeManagedSessions(f.dataDir, 'claude-code', neverInspect, emptyPage);
  assert.equal(stillListed.items.length, 1);
  await assert.rejects(inspectManagedSession(f.dataDir, claudeSessionAdapter, stillListed.items[0]!), /integrity mismatch/);
});

test('managed and native sessions are deduplicated and paged together without repeated managed items', async t => {
  const f = await fixture(t);
  await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  const native = await claudeSessionAdapter.inspect({ productId: 'claude-code', sessionId: SESSION_ID, sourcePath: f.sourcePath });
  const other = { ...native, sessionId: 'other-session', sourcePath: join(f.root, 'other.jsonl') };
  const history = { ...claudeSessionAdapter, discover: () => Promise.resolve({ ...emptyPage, items: [native, other] }) };
  const first = await discoverManagedSessions(f.dataDir, 'claude-code', history, { root: f.nativeRoot, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await discoverManagedSessions(f.dataDir, 'claude-code', history, { root: f.nativeRoot, limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.sessionId, second.items[0]?.sessionId);
  assert.equal(second.nextCursor, undefined);
  await assert.rejects(discoverManagedSessions(f.dataDir, 'claude-code', history, { root: join(f.root, 'different'), limit: 1, cursor: first.nextCursor }), /cursor is stale/);
  const secondRunner = { ...f.runner, session: () => ({ ...f.runner.session(), sessionId: '22222222-2222-4333-8444-555555555555' }) };
  await bindManagedSession(f.dataDir, { ...f.launch, runId: 'run-b' }, secondRunner);
  const onlyManaged = { ...history, discover: () => Promise.resolve(emptyPage) };
  const managedFirst = await discoverManagedSessions(f.dataDir, 'claude-code', onlyManaged, { limit: 1 });
  const managedSecond = await discoverManagedSessions(f.dataDir, 'claude-code', onlyManaged, { limit: 1, cursor: managedFirst.nextCursor! });
  assert.equal(managedFirst.items.length, 1);
  assert.equal(managedSecond.items.length, 1);
  assert.notEqual(managedFirst.items[0]?.sessionId, managedSecond.items[0]?.sessionId);
  assert.equal(managedSecond.nextCursor, undefined);
  const excluded = await discoverManagedSessions(f.dataDir, 'claude-code', onlyManaged, { excludeSessionIds: [SESSION_ID] });
  assert.equal(excluded.items.length, 1);
  assert.notEqual(excluded.items[0]?.sessionId, SESSION_ID);
  const excludedPath = await discoverManagedSessions(f.dataDir, 'claude-code', onlyManaged, { excludeSourcePaths: [excluded.items[0]!.sourcePath] });
  assert.equal(excludedPath.items.length, 1);
  assert.equal(excludedPath.items[0]?.sessionId, SESSION_ID);
});

test('CLI project and project-scoped session cursors are applied after native and managed discovery', async t => {
  const f = await fixture(t);
  await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [], signal: new AbortController().signal });
  const nativeId = '33333333-2222-4333-8444-555555555555';
  await writeFile(join(f.nativeRoot, `${nativeId}.jsonl`), f.content.replaceAll(SESSION_ID, nativeId));
  const query = { productId: 'claude-code', dataDir: f.dataDir, sessionsRoots: { 'claude-code': f.nativeRoot }, limit: 1 };
  const first = await listSourceProjects(query);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await listSourceProjects({ ...query, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]?.key, second.items[0]?.key);
  const sessions = await listSourceSessions({ ...query, project: managedProjectKey('claude-code') });
  assert.equal(sessions.items.length, 1);
  assert.equal(sessions.items[0]?.sessionId, SESSION_ID);
  assert.equal(sessions.nextCursor, undefined);
});

test('managed archive redactions cover JSON-escaped secret characters in native messages', async t => {
  const f = await fixture(t);
  const secret = 'SECRET\n"quoted"\\value';
  await writeFile(f.sourcePath, f.content.replaceAll('SECRET', JSON.stringify(secret).slice(1, -1)));
  const archived = await archiveManagedSession({ ...f, history: claudeSessionAdapter, redactions: [secret], signal: new AbortController().signal });
  assert.equal(archived.status, 'archived');
  const page = await mergeManagedSessions(f.dataDir, 'claude-code', claudeSessionAdapter, emptyPage);
  const inspection = await inspectManagedSession(f.dataDir, claudeSessionAdapter, page.items[0]!);
  assert.equal(inspection?.transcript[0]?.text, 'Fix [REDACTED].');
  assert.equal(inspection?.transcript[1]?.text, 'Fixed [REDACTED].');
});
