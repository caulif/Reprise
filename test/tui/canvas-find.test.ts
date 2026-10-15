import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasFind } from '../../src/tui/canvas-find.js';
import { IntakeTui } from '../../src/tui/intake-app.js';
import { mockTui } from '../../scripts/tui-audit-lib.js';

test('find owns Unicode cursor edits, blocked input and its single-use restore snapshot', () => {
  const find = new CanvasFind();
  const other = new CanvasFind();
  assert.equal(find.dispatch('unhandled', false), undefined);
  assert.equal(find.dispatch('/', false)?.action, 'start-find');
  const restore = { anchor: 'seq:4', following: false, offset: 3, selected: 1 };
  find.rememberPosition(restore);
  find.dispatch('\x1b[200~x🧪y\x1b[201~', false);
  const before = find.state;
  assert.equal(find.dispatch('ignored', true), undefined);
  assert.equal(find.state, before);
  find.dispatch('\x1b[D', false);
  find.dispatch('\x7f', false);
  assert.equal(find.state.query, 'xy');
  assert.equal(find.state.cursor, 1);
  assert.deepEqual(other.state, { finding: false, query: '', cursor: 0 });
  assert.deepEqual(find.reset(), restore);
  assert.deepEqual(find.state, { finding: false, query: '', cursor: 0 });
  assert.equal(find.reset(), undefined);
});

test('home navigation clears the find owner and retains the existing generation invalidation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-find-home-'));
  const app = new IntakeTui({ dataDir, tui: mockTui().tui as never,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  try {
    app.page = 'result';
    app.generation = 12;
    app.canvasFind.dispatch('/', false);
    app.canvasFind.dispatch('old query', false);
    app.canvasFind.rememberPosition({ anchor: 'seq:9', following: false, offset: 2, selected: 4 });
    app.backToHome();
    assert.equal(app.page, 'home');
    assert.equal(app.generation, 13);
    assert.deepEqual(app.canvasFind.state, { finding: false, query: '', cursor: 0 });
    assert.equal(app.canvasFind.reset(), undefined);
  } finally { app.close(); await app.closing; await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
