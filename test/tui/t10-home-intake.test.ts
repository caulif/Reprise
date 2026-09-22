import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { ProductPack, SessionDiscoveryQuery, ProductHistoryReader, SessionSummary } from '../../src/products/contract.js';
import { IntakeTui } from '../../src/tui/intake-app.js';
import { createTheme } from '../../src/tui/theme.js';
import { recentResultLabel, renderHome, homeActions, defaultHomeFocus } from '../../src/tui/pages/home.js';
import { renderInspection, renderSessions, matchesIntakeQuery } from '../../src/tui/pages/intake.js';
import { restoreById } from '../../src/tui/intake-layer-memory.js';
import { fakeProductPack } from '../fixtures/fake-pack/pack.js';

const privacy = { allowModelText: false, allowBinary: false, redactions: [] };

function summary(productId: string, sessionId: string, startedAt: string, task = `${productId} ${sessionId}`): SessionSummary {
  return {
    productId,
    sessionId,
    sourcePath: `${productId}-${sessionId}.jsonl`,
    startedAt,
    cwd: 'C:/shared-project',
    summary: task,
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
}

function sessionPack(input: {
  productId: string;
  displayName: string;
  defaultRoot: string;
  discover: (query?: SessionDiscoveryQuery) => ReturnType<ProductHistoryReader['discover']>;
}): ProductPack {
  return {
    ...fakeProductPack,
    manifest: { ...fakeProductPack.manifest, productId: input.productId, displayName: input.displayName, packVersion: 'test' },
    checkAuth: async () => ({ configured: false }),
    history: {
      ...fakeProductPack.history,
      defaultRoot: input.defaultRoot,
      discover: input.discover,
      inspect: async () => ({
        productId: input.productId,
        sessionId: 's1',
        sourcePath: 's1.jsonl',
        startedAt: '2026-08-11T00:00:00.000Z',
        cwd: 'C:/shared-project',
        transcript: [
          { id: 'u1', role: 'user', text: 'Build a Chinese 鹈鹕 bike page.' },
          { id: 'a1', role: 'assistant', text: 'Done.' },
          { id: 'u2', role: 'user', text: 'Add captions.' },
        ],
        signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
        finalMessage: 'Done.',
      }),
      import: async () => { throw new Error('not used'); },
    },
  };
}

function fakeTui(
  onDocument: (document: Component) => void = () => {},
  writes?: string[],
  mouseEnabled?: boolean,
): TUI {
  return {
    addChild: onDocument,
    addInputListener: () => () => {},
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
    terminal: writes ? { write: (data: string) => writes.push(data) } : undefined,
    mouseEnabled,
  } as unknown as TUI;
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for intake state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('TUI enables SGR mouse reporting for result-page clicks at startup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-t10-mouse-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui(() => {}, writes, true),
    packs: [fakeProductPack],
    privacy,
  });
  await app.start();
  assert.ok(writes.some((data) => /\x1b\[\?1000h/.test(data)));
});

test('TUI does not override a disabled mouse configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-t10-no-mouse-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const writes: string[] = [];
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui(() => {}, writes, false),
    packs: [fakeProductPack],
    privacy,
  });
  await app.start();
  assert.equal(writes.some((data) => /\x1b\[\?1000h/.test(data)), false);
});

test('home defaults to new replay and Enter opens source intake', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-t10-home-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const theme = createTheme(100, false);
  const home = renderHome(theme, 100, {
    taskCase: undefined,
    recentExperiment: {
      experimentId: 'e1',
      taskCaseId: 'case-12345678',
      path: 'C:/e',
      sizeBytes: 1,
      startedAt: '2026-08-11T00:00:00.000Z',
      taskStatus: 'apparently_completed',
      comparisonStatus: 'cancelled',
      outcome: 'completed',
    },
    hasApiConfig: true,
    hasUsableAuth: true,
    composer: '',
    showSuggestions: false,
    focus: 'new-replay',
    locale: 'en',
  }).join('\n');
  assert.match(home, /New replay/);
  assert.match(home, /Latest run/);
  assert.match(home, /candidate apparently_completed/);
  assert.match(home, /comparison cancelled/);
  assert.doesNotMatch(home, /\bcompleted\b(?!.*candidate)/);
  assert.equal(defaultHomeFocus({
    taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, composer: '', showSuggestions: false,
  }), 'new-replay');
  assert.equal(homeActions({
    taskCase: undefined, recentExperiment: undefined, hasApiConfig: false, composer: '', showSuggestions: false,
  })[0], 'config');

  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui(),
    packs: [sessionPack({
      productId: 'codex',
      displayName: 'Codex',
      defaultRoot: join(root, 'codex'),
      discover: async () => ({ items: [], scanned: 0, skipped: 0, diagnostics: [] }),
    })],
    privacy,
  });
  await app.start();
  assert.equal(app.homeFocus, 'config');
  app.hasSavedModelConfig = true;
  app.harnessAuthOk = true;
  app.homeFocus = 'new-replay';
  app.handleInput('\r');
  await waitFor(() => app.page === 'sessions');
  assert.equal(app.intakeLevel, 'products');
});

test('recent result labels avoid bare completed', () => {
  assert.match(recentResultLabel({
    experimentId: 'e', taskCaseId: 'c', path: 'p', sizeBytes: 1,
    taskStatus: 'apparently_completed', outcome: 'completed',
  }, 'en'), /candidate apparently_completed/);
  assert.doesNotMatch(recentResultLabel({
    experimentId: 'e', taskCaseId: 'c', path: 'p', sizeBytes: 1, outcome: 'completed',
  }, 'en'), /^completed$/);
});

test('R14: Chinese search and return restore session id and query', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-t10-r14-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const items = [
    summary('codex', 'keep-me', '2026-08-11T01:00:00.000Z', 'Build a Chinese 鹈鹕 bike page'),
    summary('codex', 'other', '2026-08-11T00:00:00.000Z', 'Unrelated English task'),
  ];
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui(),
    packs: [sessionPack({
      productId: 'codex',
      displayName: 'Codex',
      defaultRoot: join(root, 'codex'),
      discover: async () => ({ items, scanned: 2, skipped: 0, diagnostics: [] }),
    })],
    privacy,
  });
  await app.start();
  await app.loadProductSessions('codex');
  assert.equal(app.intakeLevel, 'projects');
  app.handleInput('\r');
  assert.equal(app.intakeLevel, 'sessions');
  app.handleInput('/');
  for (const ch of '鹈鹕') app.handleInput(ch);
  assert.equal(matchesIntakeQuery(items[0]!, '鹈鹕'), true);
  assert.equal(app.visibleSessions().map((item) => item.sessionId).join(','), 'keep-me');
  app.selected = 0;
  app.handleInput('\r');
  await waitFor(() => app.page === 'inspection');
  app.handleInput('\x1b');
  assert.equal(app.page, 'sessions');
  assert.equal(app.intakeLevel, 'sessions');
  assert.equal(app.searchQuery, '鹈鹕');
  assert.equal(app.visibleSessions()[app.selected]?.sessionId, 'keep-me');
});

test('R14: refresh failure keeps stale catalog and selection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-t10-refresh-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let call = 0;
  const app = new IntakeTui({
    dataDir: join(root, 'data'),
    tui: fakeTui(),
    packs: [sessionPack({
      productId: 'codex',
      displayName: 'Codex',
      defaultRoot: join(root, 'codex'),
      discover: async () => {
        call += 1;
        if (call === 1) {
          return {
            items: [
              summary('codex', 'first', '2026-08-11T02:00:00.000Z'),
              summary('codex', 'second', '2026-08-11T01:00:00.000Z'),
            ],
            scanned: 2,
            skipped: 0,
            diagnostics: [],
          };
        }
        throw new Error('disk locked');
      },
    })],
    privacy,
  });
  await app.start();
  await app.loadProductSessions('codex');
  app.handleInput('\r');
  app.selected = 1;
  const kept = app.visibleSessions()[1]?.sessionId;
  assert.equal(kept, 'second');
  app.refreshProductSessions();
  await waitFor(() => call === 2 && app.productDiscovery.get('codex')?.refreshFailed === true);
  assert.equal(app.sessions.length, 2);
  assert.equal(app.visibleSessions()[app.selected]?.sessionId, 'second');
  assert.match(app.message, /Refresh failed|刷新失败/);
});

test('R14: missing session after reload selects a neighbor', () => {
  const restored = restoreById(
    [{ id: 'a' }, { id: 'c' }],
    'b',
    1,
  );
  assert.equal(restored.index, 1);
  assert.equal(restored.lost, true);
});

test('same basename projects keep distinct paths in labels', () => {
  const theme = createTheme(120, false);
  const projects = [
    {
      key: 'p1',
      label: 'work/notes',
      path: 'C:/work/notes',
      sessions: [summary('codex', 'a', '2026-08-11T00:00:00.000Z')],
      latestAt: '2026-08-11T00:00:00.000Z',
    },
    {
      key: 'p2',
      label: 'home/notes',
      path: 'C:/home/notes',
      sessions: [summary('codex', 'b', '2026-08-11T01:00:00.000Z')],
      latestAt: '2026-08-11T01:00:00.000Z',
    },
  ];
  const text = renderSessions(theme, 120, {
    level: 'projects',
    projects,
    sessions: [],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
    discoveryStatus: 'ready',
  }, 20).join('\n');
  assert.match(text, /Project/);
  assert.match(text, /work\/notes/);
  assert.match(text, /Search currently loaded records|搜索当前已加载记录/);
});

test('inspection puts task text first and folds historical final', () => {
  const theme = createTheme(120, false);
  const inspection = {
    productId: 'codex',
    sessionId: 'session-1',
    sourcePath: 'C:/tmp/s.jsonl',
    startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source',
    transcript: [
      { id: 'u1', role: 'user', text: 'Primary task text goes first.' },
      { id: 'a1', role: 'assistant', text: 'ok' },
      { id: 'u2', role: 'user', text: 'Follow-up note.' },
    ],
    signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    finalMessage: 'Historical final draft should stay folded.',
  };
  const folded = renderInspection(theme, 120, {
    inspection: inspection as never,
    privacy,
    selectedTaskInput: 0,
    showOutcome: false,
  }).join('\n');
  const taskAt = folded.indexOf('Task text:');
  const sourceAt = folded.indexOf('Source codex');
  const laterAt = folded.indexOf('Later user turns');
  const foldedAt = folded.indexOf('Historical final (folded');
  assert.ok(taskAt >= 0 && sourceAt > taskAt && laterAt > sourceAt && foldedAt > laterAt);
  assert.doesNotMatch(folded, /Historical final draft should stay folded/);
  const expanded = renderInspection(theme, 120, {
    inspection: inspection as never,
    privacy,
    selectedTaskInput: 0,
    showOutcome: true,
  }).join('\n');
  assert.match(expanded, /Historical final draft should stay folded/);
});
