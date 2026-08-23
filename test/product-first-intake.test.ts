import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { ProductPack, SessionSummary } from '../src/products/contract.js';
import { CodexIntakeTui } from '../src/tui/intake-app.js';

const privacy = { allowModelText: false, allowBinary: false, redactions: [] };

function summary(productId: string, sessionId: string, startedAt: string): SessionSummary {
  return {
    productId,
    sessionId,
    sourcePath: `${productId}-${sessionId}.jsonl`,
    startedAt,
    cwd: 'C:/shared-project',
    summary: `${productId} ${sessionId}`,
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
}

function pack(productId: string, displayName: string, discover: () => Promise<readonly SessionSummary[]>): ProductPack {
  return {
    manifest: { productId, displayName, packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot: '.',
      discover: async () => {
        const items = await discover();
        return { items, scanned: items.length, skipped: 0, diagnostics: [] };
      },
      inspect: async () => { throw new Error('not used'); },
      import: async () => { throw new Error('not used'); },
    },
  } as unknown as ProductPack;
}

function fakeTui(onDocument: (document: Component) => void): TUI {
  return {
    addChild: onDocument,
    addInputListener: () => () => {},
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as unknown as TUI;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for intake state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('product intake isolates per-pack limits, errors, and compact back navigation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-product-intake-boundaries-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const codex = Array.from({ length: 200 }, (_, index) =>
    summary('codex', `session-${index}`, `2026-08-11T${String(index % 24).padStart(2, '0')}:00:00.000Z`));
  let document: Component | undefined;
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui((value) => { document = value; }),
    packs: [
      pack('codex', 'Codex', async () => { calls.push('codex'); return codex; }),
      pack('claude-code', 'Claude Code', async () => { calls.push('claude-code'); throw new Error('Claude sessions unavailable'); }),
    ],
    privacy,
  });

  await app.start();
  await app.loadSessions();
  app.selected = 1;
  app.openIntakeSelection();
  await waitFor(() => app.productDiscovery.get('claude-code')?.status === 'error');
  assert.equal(app.intakeLevel, 'products');
  assert.deepEqual(calls, ['claude-code']);
  assert.match(document?.render(60).join('\n') ?? '', /Claude Code[\s\S]*error: Claude session/i);

  app.selected = 0;
  app.openIntakeSelection();
  await waitFor(() => app.productDiscovery.get('codex')?.status === 'ready');
  assert.equal(app.sessions.length, 150);
  assert.equal(app.visibleSessions().every((item) => item.productId === 'codex'), true);
  assert.deepEqual(calls, ['claude-code', 'codex']);

  app.handleInput('\r');
  assert.equal(app.intakeLevel, 'sessions');
  app.handleInput('\b');
  assert.equal(app.intakeLevel, 'projects');
  app.handleInput('\b');
  assert.equal(app.intakeLevel, 'products');
  assert.match(document?.render(60).join('\n') ?? '', /Select agent product/);
});
test('a late discovery result cannot replace the newly selected product', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-product-switch-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let releaseCodex: (() => void) | undefined;
  let codexAborted = false;
  const codex = {
    manifest: { productId: 'codex', displayName: 'Codex', packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot: join(root, 'codex'),
      discover: async (query?: { signal?: AbortSignal }) => {
        query?.signal?.addEventListener('abort', () => { codexAborted = true; }, { once: true });
        await new Promise<void>((resolve) => { releaseCodex = resolve; });
        return { items: [summary('codex', 'late-codex', '2026-08-11T00:00:00.000Z')], scanned: 1, skipped: 0, diagnostics: [] };
      },
      inspect: async () => { throw new Error('not used'); },
      import: async () => { throw new Error('not used'); },
    },
  } as unknown as ProductPack;
  const claude = {
    manifest: { productId: 'claude-code', displayName: 'Claude Code', packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot: join(root, 'claude'),
      discover: async () => ({ items: [summary('claude-code', 'current-claude', '2026-08-12T00:00:00.000Z')], scanned: 1, skipped: 0, diagnostics: [] }),
      inspect: async () => { throw new Error('not used'); },
      import: async () => { throw new Error('not used'); },
    },
  } as unknown as ProductPack;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), tui: fakeTui(() => {}), packs: [codex, claude], privacy });
  await app.start();
  const pendingCodex = app.loadProductSessions('codex');
  await waitFor(() => releaseCodex !== undefined);
  await app.loadProductSessions('claude-code');
  releaseCodex?.();
  await pendingCodex;

  assert.equal(codexAborted, true);
  assert.equal(app.activeProductId, 'claude-code');
  assert.deepEqual(app.visibleSessions().map((item) => item.productId), ['claude-code']);
  assert.deepEqual(app.groupedProjects().flatMap((project) => project.sessions.map((item) => item.productId)), ['claude-code']);
});
test('a legacy session root is scoped to one Pack instead of leaking into another product', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-product-root-isolation-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const observed: string[] = [];
  const makePack = (productId: string, defaultRoot: string) => ({
    manifest: { productId, displayName: productId, packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot,
      discover: async (query?: { root?: string }) => {
        observed.push(`${productId}:${query?.root}`);
        return { items: [summary(productId, `${productId}-1`, '2026-08-11T00:00:00.000Z')], scanned: 1, skipped: 0, diagnostics: [] };
      },
      inspect: async () => { throw new Error('not used'); },
      import: async () => { throw new Error('not used'); },
    },
  }) as unknown as ProductPack;
  const legacyRoot = join(root, 'legacy-codex');
  const claudeRoot = join(root, 'claude-default');
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'),
    sessionsRoot: legacyRoot,
    tui: fakeTui(() => {}),
    packs: [makePack('codex', join(root, 'codex-default')), makePack('claude-code', claudeRoot)],
    privacy,
  });

  await app.start();
  await app.loadProductSessions('claude-code');
  assert.deepEqual(observed, [`claude-code:${claudeRoot}`]);

  const reordered = new CodexIntakeTui({
    dataDir: join(root, 'reordered-data'),
    sessionsRoot: legacyRoot,
    tui: fakeTui(() => {}),
    packs: [makePack('claude-code', claudeRoot), makePack('codex', join(root, 'codex-default'))],
    privacy,
  });
  await reordered.start();
  await reordered.loadProductSessions('claude-code');
  await reordered.loadProductSessions('codex');
  assert.deepEqual(observed.slice(1), [
    `claude-code:${claudeRoot}`,
    `codex:${legacyRoot}`,
  ]);

  const singlePackRoot = join(root, 'single-pack-root');
  const singlePack = new CodexIntakeTui({
    dataDir: join(root, 'single-pack-data'),
    sessionsRoot: singlePackRoot,
    tui: fakeTui(() => {}),
    packs: [makePack('claude-code', claudeRoot)],
    privacy,
  });
  await singlePack.start();
  await singlePack.loadProductSessions('claude-code');
  assert.deepEqual(observed.slice(3), [`claude-code:${singlePackRoot}`]);
});

test('cursor pagination counts root diagnostics once and page diagnostics once per examined record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-product-diagnostics-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let call = 0;
  const page = (sessionId: string, nextCursor?: string) => {
    const rootDiagnostics = [{ code: 'unreadable-directory' as const, count: 1, samplePath: 'locked' }];
    const pageDiagnostics = [{ code: 'invalid-jsonl' as const, count: 1, samplePath: `${sessionId}.bad.jsonl` }];
    return {
      items: [summary('codex', sessionId, '2026-08-11T00:00:00.000Z')],
      scanned: 2,
      skipped: 2,
      diagnostics: [...rootDiagnostics, ...pageDiagnostics],
      rootDiagnostics,
      pageDiagnostics,
      ...(nextCursor ? { nextCursor } : {}),
    };
  };
  const codex = {
    manifest: { productId: 'codex', displayName: 'Codex', packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot: root,
      discover: async () => ++call === 1 ? page('first', 'next') : page('second'),
      inspect: async () => { throw new Error('not used'); },
      import: async () => { throw new Error('not used'); },
    },
  } as unknown as ProductPack;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), tui: fakeTui(() => {}), packs: [codex], privacy });
  await app.start();
  await app.loadProductSessions('codex');
  assert.match(app.message, /1 shown · 2 skipped · more available/);
  assert.match(app.message, /Diagnostics: invalid-jsonl \(1\), unreadable-directory \(1\)/);
  app.locale = 'zh';
  assert.match(app.sessionsMessage(), /已显示 1 条 · 已跳过 2 条 · 还有更多/);
  app.loadMoreProductSessions();
  await waitFor(() => call === 2 && app.productDiscovery.get('codex')?.status === 'ready');
  assert.equal(app.productItems()[0]?.skipped, 3);
  assert.match(app.message, /已显示 2 条 · 已跳过 3 条/);
  assert.doesNotMatch(app.message, /还有更多/);
  assert.match(app.message, /诊断：invalid-jsonl \(2\), unreadable-directory \(1\)/);
  assert.deepEqual(app.productDiscovery.get('codex')?.diagnostics?.map((diagnostic) => [diagnostic.code, diagnostic.count]), [
    ['invalid-jsonl', 2], ['unreadable-directory', 1],
  ]);
});

test('freeze imports through the session product pack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-product-freeze-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const sourcePath = join(root, 'claude.jsonl');
  const claude = {
    manifest: { productId: 'claude-code', displayName: 'Claude Code', packVersion: 'test', schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: {
      defaultRoot: root,
      discover: async () => ({ items: [], scanned: 0, skipped: 0, diagnostics: [] }),
      inspect: async () => { throw new Error('not used'); },
      import: async () => {
        calls.push('claude-code');
        return {
          source: { productId: 'claude-code', sessionId: 'claude-1', sourcePath },
          initialInput: { id: 'user-1', role: 'user', text: 'Review this.' },
          transcript: [{ id: 'user-1', role: 'user', text: 'Review this.' }, { id: 'assistant-1', role: 'assistant', text: 'Done.' }],
          historicalEvents: [],
          baseline: { status: 'available', artifactRefs: [], evidenceRefs: [] },
          sourceRuntimeEvidence: { productId: 'claude-code', artifactRefs: [] },
          provenance: { packVersion: 'test' },
          raw: { relativePath: 'claude.jsonl', text: '{"fixture":true}\n' },
          diagnostics: [],
          signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
        };
      },
    },
  } as unknown as ProductPack;
  const app = new CodexIntakeTui({ dataDir: join(root, 'data'), tui: fakeTui(() => {}), packs: [claude], privacy, now: () => '2026-08-15T00:00:00.000Z' });
  app.sessions = [{ ...summary('claude-code', 'claude-1', '2026-08-11T00:00:00.000Z'), sourcePath }];
  const { freeze } = await import('../src/tui/controller-run.js');
  await freeze(app, sourcePath);
  assert.deepEqual(calls, ['claude-code']);
  assert.equal(app.taskCase?.source.productId, 'claude-code');
});
