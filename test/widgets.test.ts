import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiAltScreen, visibleWidth } from '@earendil-works/pi-tui';
import { CodexIntakeTui } from '../src/tui/codex-intake.js';
import { FORBIDDEN_COMPACT, createTheme } from '../src/tui/theme.js';
import { truncateFit } from '../src/tui/format.js';
import { kv, pad, panel, joinColumns, stateRail } from '../src/tui/widgets.js';
import { renderTimeline } from '../src/tui/pages/run.js';
import { renderWorkbench } from '../src/tui/workbench.js';
import { FakeTerminal, renderFrame } from './support/fake-terminal.js';

test('panel top and bottom borders have the same visible width', () => {
  const theme = createTheme(80, false);
  const lines = panel(theme, ' Review session ', [' Task input 1/2: Fix the bug.'], 80);
  const top = lines[0] ?? '';
  const bottom = lines.at(-1) ?? '';
  assert.equal(visibleWidth(top), 80);
  assert.equal(visibleWidth(bottom), 80);
  assert.equal(visibleWidth(top), visibleWidth(bottom));
});

test('panel CJK body lines stay within the panel width', () => {
  const theme = createTheme(80, false);
  const lines = panel(theme, ' Review session ', [' Task 修复这个回归缺陷并验证测试全部通过'], 80);
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80, line);
  }
});

test('compact glyphs contain none of the wide-terminal box characters', () => {
  const theme = createTheme(60, false);
  const lines = panel(theme, 'Welcome / Recent runs', [' /config    Configure the API connection'], 60);
  const text = lines.join('\n');
  assert.match(text, /\[ Welcome \/ Recent runs \]/);
  assert.doesNotMatch(text, FORBIDDEN_COMPACT);
});

test('pad uses visible width rather than UTF-16 length', () => {
  const filled = pad('修复', 10);
  assert.equal(visibleWidth(filled), 10);
});

test('a long agent message stays in the detail pane instead of exploding the list', () => {
  const theme = createTheme(120, false);
  const detail = `${Array.from({ length: 200 }, (_, index) => `public response line ${index + 1}`).join('\n')}\nPUBLIC_DETAIL_END`;
  const lines = renderTimeline(theme, 120, {
    entries: [{ sequence: 1, occurredAt: '2026-08-11T00:10:02.000Z', source: 'TARGET', title: 'Visible response', detail }],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: true,
  });
  const text = lines.join('\n');
  const beforeDetail = text.split('Detail')[0] ?? '';
  assert.doesNotMatch(beforeDetail, /public response line/);
  assert.match(text, /PUBLIC_DETAIL_END/);
  const clipped = renderTimeline(theme, 120, {
    entries: [{ sequence: 1, occurredAt: '2026-08-11T00:10:02.000Z', source: 'TARGET', title: 'Visible response', detail }],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: true,
  }, 16);
  assert.ok(clipped.length < 40, `expected a clipped running view, got ${clipped.length} lines`);
});

test('joinColumns stretches the shorter framed panel to the same height', () => {
  const theme = createTheme(80, false);
  const left = panel(theme, 'Left', [' a', ' b', ' c', ' d'], 38);
  const right = panel(theme, 'Right', [' x'], 38);
  const lines = joinColumns(left, right, 38, 38, 2, theme);
  assert.equal(left.length > right.length, true);
  assert.equal(lines.length, left.length);
  assert.match(lines.at(-1) ?? '', /└/);
  assert.equal(visibleWidth(lines[0] ?? ''), 78);
});

test('truncateFit keeps a plain ellipsis on uncolored text', () => {
  const cut = truncateFit('C:\\Users\\15893\\Documents\\model-test\\Reprise\\very\\long\\path', 24, '...');
  assert.doesNotMatch(cut, /\u001b/);
  assert.equal(visibleWidth(cut), 24);
});

test('kv leaves long paths intact so the panel can wrap them', () => {
  const theme = createTheme(60, false);
  const line = kv(theme, 'Report', 'C:\\Users\\15893\\AppData\\Local\\Temp\\reprise-tui-audit\\report.html', 58);
  assert.doesNotMatch(line, /\u001b/);
  assert.match(line, /reprise-tui-audit\\report\.html/);
});

test('stateRail wraps on segment boundaries at compact width', () => {
  const theme = createTheme(60, false);
  const lines = stateRail(theme, 'launching', 60);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60, line);
});

test('running timeline names a missing state origin as created', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [{ sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'HARNESS', title: 'State: ? → launching' }],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
  }).join('\n');
  assert.match(text, /State: created/);
  assert.doesNotMatch(text, /State: \?/);
});

test('a 24-row running workbench stays within the viewport', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1,
    occurredAt: '2026-08-11T00:10:00.000Z',
    source: 'TARGET' as const,
    title: `Event ${index + 1}`,
    detail: 'detail',
  }));
  const lines = renderWorkbench({
    page: 'running',
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasTaskCase: true,
    message: 'Candidate is running only in an isolated workspace.',
    running: {
      entries, selected: 0, filter: 'ALL', following: true, cancelling: false,
      currentState: 'launching', elapsed: '00:05', turns: { used: 1, max: 4 },
      calls: { used: 1, max: 3 }, detailExpanded: false,
    },
  }, 120, 24);
  assert.ok(lines.length <= 24, `expected <= 24 lines, got ${lines.length}`);
});

test('production layout root paints Home through a fake terminal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-layout-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const term = new FakeTerminal(120, 30);
  const tui = new TuiAltScreen(term, false, undefined, { mouse: false });
  t.after(() => tui.stop());
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  const frame = renderFrame(tui, term, 30, 120);
  assert.match(frame, /Welcome \/ Recent runs/);
  assert.match(frame, /Enter a task or \/ command/);
  app.handleInput('?');
  assert.match(app.preview(120), /Commands: \/config, \/intake, \/run, \/history/);
});
