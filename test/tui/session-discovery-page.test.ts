import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverSessionPage, resetSessionDiscoveryCacheStats, sessionDiscoveryCacheStats, SessionDiscoveryError, type SessionFileEntry } from '../../src/products/shared/session-files.js';
import type { SessionSummary } from '../../src/products/contract.js';

const entries: readonly SessionFileEntry[] = [
  { path: 'C:/sessions/new.jsonl', mtime: 30, size: 10 },
  { path: 'C:/sessions/bad.jsonl', mtime: 20, size: 10 },
  { path: 'C:/sessions/old.jsonl', mtime: 10, size: 10 },
];

function summary(path: string): SessionSummary {
  return {
    productId: 'fake', sessionId: path, sourcePath: path, updatedAt: `2026-08-1${path.includes('old') ? '0' : '1'}T00:00:00.000Z`,
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
}

test('discovery page uses a root-bound stable cursor and records skipped local files', async () => {
  const inspect = async (entry: SessionFileEntry): Promise<SessionSummary> => {
    const path = entry.path;
    if (path.endsWith('bad.jsonl')) throw new Error('invalid JSONL');
    return summary(path);
  };
  const first = await discoverSessionPage({ root: 'C:/sessions', ranked: entries, limit: 1, inspect });
  assert.deepEqual(first.items.map((item) => item.sourcePath), ['C:/sessions/new.jsonl']);
  assert.equal(first.scanned, 3);
  assert.equal(first.skipped, 1);
  assert.deepEqual(first.rootDiagnostics, [{ code: 'invalid-jsonl', count: 1, samplePath: 'bad.jsonl' }]);
  assert.equal(first.pageDiagnostics, undefined);
  assert.ok(first.nextCursor);

  const second = await discoverSessionPage({ root: 'C:/sessions', ranked: entries, limit: 1, cursor: first.nextCursor, inspect });
  assert.deepEqual(second.items.map((item) => item.sourcePath), ['C:/sessions/old.jsonl']);
  assert.equal(second.scanned, 3);
  assert.equal(second.skipped, 1);
  assert.deepEqual(second.diagnostics.map((diagnostic) => diagnostic.code), ['invalid-jsonl']);
  assert.deepEqual(second.rootDiagnostics, [{ code: 'invalid-jsonl', count: 1, samplePath: 'bad.jsonl' }]);
  assert.equal(second.pageDiagnostics, undefined);
  assert.equal(second.nextCursor, undefined);
});

test('discovery identifies root diagnostics separately from cursor-page diagnostics', async () => {
  const ranked: readonly SessionFileEntry[] = [
    { path: 'C:/sessions/new.jsonl', mtime: 3, size: 10 },
    { path: 'C:/sessions/bad.jsonl', mtime: 2, size: 10 },
    { path: 'C:/sessions/old.jsonl', mtime: 1, size: 10 },
  ];
  const diagnostics = [{ code: 'unreadable-directory' as const, count: 1, samplePath: 'locked' }];
  const inspect = async (entry: SessionFileEntry): Promise<SessionSummary> => {
    if (entry.path.endsWith('bad.jsonl')) throw new Error('invalid JSONL');
    return summary(entry.path);
  };
  const first = await discoverSessionPage({ root: 'C:/sessions', ranked, limit: 1, diagnostics, inspect });
  const indexDiagnostics = [
    { code: 'invalid-jsonl' as const, count: 1, samplePath: 'bad.jsonl' },
    ...diagnostics,
  ];
  assert.deepEqual(first.rootDiagnostics, indexDiagnostics);
  assert.equal(first.pageDiagnostics, undefined);
  assert.ok(first.nextCursor);

  const second = await discoverSessionPage({
    root: 'C:/sessions', ranked, limit: 1, diagnostics,
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}), inspect,
  });
  assert.deepEqual(second.rootDiagnostics, indexDiagnostics);
  assert.equal(second.pageDiagnostics, undefined);
  assert.deepEqual(second.diagnostics.map((entry) => [entry.code, entry.count]), [
    ['invalid-jsonl', 1], ['unreadable-directory', 1],
  ]);
  assert.equal(second.skipped, 2);
});

test('discovery rejects a cursor from another root instead of mixing session caches', async () => {
  await assert.rejects(
    discoverSessionPage({ root: 'C:/sessions', ranked: entries, limit: 1, cursor: 'not-a-cursor', inspect: async (entry) => summary(entry.path) }),
    /cursor is invalid/i,
  );
  const first = await discoverSessionPage({ root: 'C:/sessions', ranked: entries, limit: 1, inspect: async (entry) => summary(entry.path) });
  await assert.rejects(
    discoverSessionPage({ root: 'C:/other', ranked: entries, limit: 1, ...(first.nextCursor ? { cursor: first.nextCursor } : {}), inspect: async (entry) => summary(entry.path) }),
    /cursor is stale/i,
  );
});

test('discovery sorts known update instants before unknown values and breaks ties by source path', async () => {
  const ranked: readonly SessionFileEntry[] = [
    { path: 'C:/sessions/a.jsonl', mtime: 3, size: 10 },
    { path: 'C:/sessions/b.jsonl', mtime: 2, size: 10 },
    { path: 'C:/sessions/c.jsonl', mtime: 1, size: 10 },
  ];
  const page = await discoverSessionPage({
    root: 'C:/sessions', ranked, limit: 3,
    inspect: async (entry) => ({
      productId: 'fake', sessionId: entry.path, sourcePath: entry.path,
      ...(entry.path.endsWith('a.jsonl') ? {} : { updatedAt: '2026-08-11T00:00:00.000Z' }),
      signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    }),
  });
  assert.deepEqual(page.items.map((item) => item.sourcePath), ['C:/sessions/b.jsonl', 'C:/sessions/c.jsonl', 'C:/sessions/a.jsonl']);
});
test('discovery diagnostics expose only root-relative sample paths', async () => {
  const page = await discoverSessionPage({
    root: 'C:/private/sessions',
    ranked: [{ path: 'C:/private/sessions/nested/bad.jsonl', mtime: 1, size: 10 }],
    limit: 1,
    inspect: async () => { throw new Error('invalid JSONL'); },
  });
  assert.deepEqual(page.diagnostics, [{ code: 'invalid-jsonl', count: 1, samplePath: 'nested/bad.jsonl' }]);
});

test('discovery rejects a continuation when the ranked local root changes', async () => {
  const ranked: readonly SessionFileEntry[] = [
    { path: 'C:/sessions/new.jsonl', mtime: 30, size: 10 },
    { path: 'C:/sessions/old.jsonl', mtime: 10, size: 10 },
  ];
  const first = await discoverSessionPage({ root: 'C:/sessions', ranked, limit: 1, inspect: async (entry) => summary(entry.path) });
  await assert.rejects(
    discoverSessionPage({
      root: 'C:/sessions',
      ranked: [{ path: 'C:/sessions/new.jsonl', mtime: 31, size: 10 }, ...ranked.slice(1)],
      limit: 1,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      inspect: async (entry) => summary(entry.path),
    }),
    /cursor is stale/i,
  );
});

// File mtimes are only a cheap candidate-enumeration order. JSONL event time owns the
// product-facing recency order, including at a cursor boundary.
test('discovery globally orders cursor pages by summary update time instead of file mtime', async () => {
  const ranked: readonly SessionFileEntry[] = [
    { path: 'C:/sessions/file-newer.jsonl', mtime: 20, size: 10 },
    { path: 'C:/sessions/event-newer.jsonl', mtime: 10, size: 10 },
  ];
  const inspect = async (entry: SessionFileEntry): Promise<SessionSummary> => ({
    productId: 'fake', sessionId: entry.path, sourcePath: entry.path,
    updatedAt: entry.path.endsWith('event-newer.jsonl') ? '2026-08-12T00:00:00.000Z' : '2026-08-10T00:00:00.000Z',
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  });
  const first = await discoverSessionPage({ root: 'C:/sessions', ranked, limit: 1, inspect });
  assert.deepEqual(first.items.map((item) => item.sourcePath), ['C:/sessions/event-newer.jsonl']);
  assert.ok(first.nextCursor);

  const second = await discoverSessionPage({
    root: 'C:/sessions', ranked, limit: 1,
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}), inspect,
  });
  assert.deepEqual(second.items.map((item) => item.sourcePath), ['C:/sessions/file-newer.jsonl']);
  assert.equal(second.nextCursor, undefined);
});


test('discovery reuses a product-scoped summary index until explicit refresh', async () => {
  const ranked: readonly SessionFileEntry[] = [
    { path: 'C:/cached/a.jsonl', mtime: 2, size: 10 },
    { path: 'C:/cached/b.jsonl', mtime: 1, size: 10 },
  ];
  let inspections = 0;
  const inspect = async (entry: SessionFileEntry): Promise<SessionSummary> => {
    inspections += 1;
    return summary(entry.path);
  };
  const first = await discoverSessionPage({ root: 'C:/cached', ranked, limit: 1, cacheKey: 'fake-cache', inspect });
  assert.equal(inspections, 2);
  assert.ok(first.nextCursor);
  await discoverSessionPage({
    root: 'C:/cached', ranked, limit: 1, cacheKey: 'fake-cache',
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}), inspect,
  });
  assert.equal(inspections, 2);
  await discoverSessionPage({ root: 'C:/cached', ranked, limit: 1, cacheKey: 'fake-cache', refresh: true, inspect });
  assert.equal(inspections, 4);
});


test('discovery reuses unchanged files while reindexing only changed entries', async () => {
  resetSessionDiscoveryCacheStats();
  const ranked = [
    { path: 'C:/incremental/a.jsonl', mtime: 2, size: 10 },
    { path: 'C:/incremental/b.jsonl', mtime: 1, size: 10 },
  ] as const;
  let inspections = 0;
  const inspect = async (entry: SessionFileEntry): Promise<SessionSummary> => {
    inspections += 1;
    return summary(`${entry.path}?read=${inspections}`);
  };
  await discoverSessionPage({ root: 'C:/incremental', ranked, limit: 2, cacheKey: 'incremental-cache', inspect });
  assert.equal(inspections, 2);
  await discoverSessionPage({ root: 'C:/incremental', ranked, limit: 2, cacheKey: 'incremental-cache', inspect });
  assert.equal(inspections, 2);
  await discoverSessionPage({
    root: 'C:/incremental', ranked: [{ ...ranked[0], mtime: 3 }, ranked[1]], limit: 2,
    cacheKey: 'incremental-cache', inspect,
  });
  assert.equal(inspections, 3);
  assert.deepEqual(sessionDiscoveryCacheStats(), { unchanged: 3, reread: 3 });
});

test('discovery promotes a safe too-large summary to a partial item', async () => {
  const entry = { path: 'C:/partial/large.jsonl', mtime: 1, size: 5_000_000 } as const;
  const page = await discoverSessionPage({
    root: 'C:/partial', ranked: [entry], limit: 1,
    inspect: async () => { throw new SessionDiscoveryError('too-large', 'complete summary limit'); },
    inspectPartial: async () => ({ ...summary(entry.path), partial: true }),
  });
  assert.equal(page.items[0]?.partial, true);
  assert.equal(page.skipped, 0);
  assert.deepEqual(page.diagnostics, []);
});
