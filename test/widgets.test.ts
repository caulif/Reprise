import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiAltScreen, visibleWidth } from '@earendil-works/pi-tui';
import { CodexIntakeTui } from '../src/tui/intake-app.js';
import { renderConfirmation, renderPreflight, renderTimeline, runningHints } from '../src/tui/pages/run.js';
import { matchesCanvasQuery } from '../src/tui/scrollback.js';
import { renderHistory, renderHistoryDetail } from '../src/tui/pages/history.js';
import { renderFailure, renderResult, resultHints } from '../src/tui/pages/result.js';
import { projectTimelineEvent } from '../src/tui/timeline.js';
import { relativeTime, renderSessions } from '../src/tui/pages/intake.js';
import { sessionReplayErrorMessage, t } from '../src/tui/i18n.js';
import { SessionReplayError } from '../src/products/shared/session-recovery.js';
import { FORBIDDEN_COMPACT, createTheme } from '../src/tui/theme.js';
import { operatorErrorMessage, truncateFit } from '../src/tui/format.js';
import { kv, kvBlock, pad, panel, joinColumns, progressBar, stateRail, wrapBodyLine, keyHints } from '../src/tui/widgets.js';
import { renderWorkbench } from '../src/tui/workbench.js';
import { helpLines } from '../src/tui/overlays.js';
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
  const body = `${Array.from({ length: 200 }, (_, index) => `public response line ${index + 1}`).join('\n')}\nPUBLIC_DETAIL_END`;
  const entry = projectTimelineEvent({
    schemaVersion: 1, sequence: 1, eventId: 'event-1', occurredAt: '2026-08-11T00:10:02.000Z',
    type: 'codex.item_completed', payload: { item: { type: 'agentMessage', text: body } }, checksum: 'c'.repeat(64),
  })[0];
  assert.ok(entry);
  const lines = renderTimeline(theme, 120, {
    entries: [entry],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: true,
  });
  const text = lines.join('\n');
  assert.match(text, /public response line 1/);
  assert.match(text, /public response line|Codex|To Codex/);
  assert.doesNotMatch(text, /PUBLIC_DETAIL_END/);
  const clipped = renderTimeline(theme, 120, {
    entries: [entry],
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
  const cut = truncateFit('C:\\Users\\example\\Documents\\model-test\\Reprise\\very\\long\\path', 24, '...');
  assert.doesNotMatch(cut, /\u001b/);
  assert.equal(visibleWidth(cut), 24);
});

test('kv leaves long paths intact so the panel can wrap them', () => {
  const theme = createTheme(60, false);
  const line = kv(theme, 'Report', 'C:\\Users\\example\\AppData\\Local\\Temp\\reprise-tui-audit\\report.html', 58);
  assert.doesNotMatch(line, /\u001b/);
  assert.match(line, /reprise-tui-audit\\report\.html/);
});

test('kvBlock keeps the path with the colon wrap and does not start a line with ：', () => {
  const theme = createTheme(60, false);
  const lines = kvBlock(theme, 'Task', '请帮我读取并解密我的微信聊天记录，我想要导出指定的群聊记录并分析：C:\\software\\weixdocuments\\xwechat_files', 60);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(visibleWidth(line) <= 57, line);
  for (const line of lines.slice(1)) {
    assert.doesNotMatch(line.trimStart(), /^[：，。]/, line);
  }
  assert.match(lines.join('\n'), /分析：/);
});

test('history TaskCase detail keeps panel borders when the task includes a Windows path', () => {
  const theme = createTheme(120, false);
  const lines = renderHistoryDetail(theme, 120, {
    path: 'C:\\Users\\example\\Documents\\model-test\\Reprise\\.reprise\\cases\\case-4efe900555f98a46\\case.json',
    taskCase: {
      caseId: 'case-4efe900555f98a46',
      initialInput: { text: '请帮我读取并解密我的微信聊天记录，我想要导出指定的群聊记录并分析：C:\\software\\weixdocuments\\xwechat_files' },
      source: { productId: 'codex', sessionId: '019fb84f-dff4-7c40-a6d2-460d1214cab1' },
      provenance: { importedAt: '2026-08-13T11:40:19.498Z' },
    },
  } as never);
  for (const line of lines) assert.equal(visibleWidth(line), 120, line);
  assert.match(lines.join('\n'), /分析：/);
  assert.match(lines.join('\n'), /xwechat_files/);
  assert.match(lines.join('\n'), /\u001b\]8;;file:\/\//);
});

test('detail pane indents command output so it does not stick to the frame', () => {
  const theme = createTheme(120, false);
  const entry = projectTimelineEvent({
    schemaVersion: 1, sequence: 29, eventId: 'event-29', occurredAt: '2026-08-13T14:17:28.260Z',
    type: 'codex.item_completed',
    payload: {
      item: {
        type: 'commandExecution',
        command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command Get-Content',
        status: 'failed', cwd: 'C:\\work', exitCode: -1, durationMs: 12,
        aggregatedOutput: 'execution error: Io(Custom { kind: Other, error: "Windows sandbox: helper_unknown_error: apply deny-read ACLs" })',
      },
    },
    checksum: 'c'.repeat(64),
  })[0];
  assert.ok(entry);
  const lines = renderTimeline(theme, 120, {
    entries: [entry],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:34', turns: { used: 0, max: 4 }, calls: { used: 0, max: 3 }, detailExpanded: true,
  });
  for (const line of lines) assert.equal(visibleWidth(line), 120, line);
  const text = lines.join('\n');
  assert.match(text, /Sandbox blocked/);
  assert.match(text, /Get-Content/);
  assert.doesNotMatch(text, /Program Files/);
  assert.doesNotMatch(text, /seq /);
  assert.doesNotMatch(text.replace(/\u001b\[[0-9;]*m/g, ''), /│execution/);
});

test('command detail paints a one-line invocation plus indented output', () => {
  const theme = createTheme(120, false);
  const entry = projectTimelineEvent({
    schemaVersion: 1, sequence: 5, eventId: 'event-5', occurredAt: '2026-08-11T00:10:01.500Z',
    type: 'codex.item_completed',
    payload: {
      item: {
        type: 'commandExecution',
        command: '"C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" -Command "Get-ChildItem | Format-Table Mode,Length,LastWriteTime,Name"',
        status: 'completed', cwd: 'C:\\\\Users\\\\15893\\\\Documents\\\\model-test\\\\Reprise', exitCode: 0, durationMs: 476,
        aggregatedOutput: ['Mode  Length LastWriteTime         Name', '----  ------ -------------         ----', '-a---   1200 8/13/2026 12:00:00 AM  file-1.txt'].join('\n'),
      },
    },
    checksum: 'c'.repeat(64),
  })[0];
  assert.ok(entry);
  const text = renderTimeline(theme, 120, {
    entries: [entry],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:00', turns: { used: 0, max: 4 }, calls: { used: 0, max: 3 }, detailExpanded: true,
  }).join('\n');
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  assert.match(plain, /\$ Get-ChildItem \| Format-Table/);
  assert.match(plain, /file-1\.txt/);
  assert.match(plain, /exit 0 · 476ms/);
  assert.doesNotMatch(plain, /seq /);
  assert.doesNotMatch(plain, /Command completed/);
  assert.doesNotMatch(plain, /Program Files/);
  assert.doesNotMatch(plain, /cwd {2}/);
  const commandHits = plain.split('\n').filter((line) => /\$ Get-ChildItem/.test(line));
  assert.equal(commandHits.length, 1);
});

test('wrapBodyLine splits embedded newlines before wrapping so panel borders stay closed', () => {
  const theme = createTheme(80, false);
  const wrapped = wrapBodyLine('"pwsh" -Command Get-Content\nexecution error: sandbox deny-read', 40);
  assert.ok(wrapped.length >= 2);
  for (const line of wrapped) {
    assert.doesNotMatch(line, /\n/);
    assert.ok(visibleWidth(line) <= 40, line);
  }
  const panelLines = panel(theme, 'Detail', wrapped.map((line) => ` ${line}`), 80);
  for (const line of panelLines) assert.equal(visibleWidth(line), 80, line);
  assert.match(panelLines.join('\n'), /execution error/);
});

test('wrapBodyLine does not split WhatsApp/WeChat at the slash', () => {
  const lines = wrapBodyLine('The candidate cannot bypass WhatsApp/WeChat security mechanisms in this environment.', 48);
  for (const line of lines) assert.ok(visibleWidth(line) <= 48, line);
  assert.match(lines.join('\n'), /WhatsApp\/WeChat/);
  assert.doesNotMatch(lines.map((line) => line.trimStart()).join('\n'), /^WeChat/m);
});

test('wrapBodyLine prefers path separators over a mid-segment break', () => {
  const message = "EPERM: operation not permitted, rename 'C:\\Users\\example\\Documents\\model-test\\Reprise\\.reprise\\experiments\\experiment-2af2ed5b\\environment\\baselines\\.case.staging' -> 'C:\\Users\\example\\Documents\\model-test\\Reprise\\.reprise\\experiments\\experiment-2af2ed5b\\environment\\baselines\\case'";
  const lines = wrapBodyLine(message, 80);
  for (const line of lines) assert.ok(visibleWidth(line) <= 80, line);
  assert.doesNotMatch(lines.map((line) => line.trimStart()).join('\n'), /^vironment/m);
});

test('the error page names a Windows baseline lock without dumping the staging path', () => {
  const theme = createTheme(120, false);
  const error = Object.assign(new Error("EPERM: operation not permitted, rename 'C:\\Users\\example\\Documents\\model-test\\Reprise\\.reprise\\experiments\\experiment-2af2ed5b\\environment\\baselines\\.case.staging' -> 'C:\\Users\\example\\Documents\\model-test\\Reprise\\.reprise\\experiments\\experiment-2af2ed5b\\environment\\baselines\\case'"), { code: 'EPERM' });
  const text = renderFailure(theme, 120, operatorErrorMessage(error)).join('\n');
  assert.match(text, /lock on the copied files/);
  assert.doesNotMatch(text, /staging-/);
  assert.doesNotMatch(text, /vironment/);
});

test('stateRail wraps on segment boundaries at compact width', () => {
  const theme = createTheme(60, false);
  const lines = stateRail(theme, 'launching', 60);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60, line);
});

test('prepareRail stays compact and names the current phase', () => {
  const wide = progressBar(createTheme(120, false), 'check', '00:04', 120).join('\n');
  assert.match(wide, /check/);
  assert.doesNotMatch(wide, /Checking source|Copying workspace/);
  const compact = progressBar(createTheme(60, false), 'copy', '00:12', 60);
  const text = compact.join('\n');
  assert.match(text, /copy/);
  assert.doesNotMatch(text, FORBIDDEN_COMPACT);
  for (const line of compact) assert.ok(visibleWidth(line) <= 60, line);
  const compare = progressBar(createTheme(120, false), 'compare', '01:12', 120).join('\n');
  assert.match(compare, /compare/);
});

test('canvas find keeps matching voice blocks and hides the rest', () => {
  const input = { sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'CONTROLLER' as const, title: 'Input to Target', detail: 'Fix the failing test.' };
  const product = { sequence: 2, occurredAt: '2026-08-11T00:10:02.000Z', source: 'TARGET' as const, title: 'Visible response', detail: 'public response line 1', original: 'PUBLIC_DETAIL_END' };
  assert.equal(matchesCanvasQuery(product, 'public response'), true);
  assert.equal(matchesCanvasQuery(product, 'PUBLIC_DETAIL'), true);
  assert.equal(matchesCanvasQuery(input, 'public response'), false);
  const theme = createTheme(120, false);
  const model = {
    entries: [input, product],
    selected: 0, filter: 'ALL' as const, following: true, cancelling: false,
    currentState: 'awaiting_target' as const, elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
    finding: true, findQuery: 'public response', findCursor: 15,
  };
  const text = renderTimeline(theme, 120, model).join('\n');
  assert.match(text, /Find:/);
  assert.match(text, /1\/1/);
  assert.match(text, /public response line 1/);
  assert.doesNotMatch(text, /Fix the failing test/);
  const restored = renderTimeline(theme, 120, { ...model, finding: false, findQuery: '' }).join('\n');
  assert.match(restored, /Fix the failing test/);
  assert.match(restored, /public response line 1/);
  assert.doesNotMatch(restored, /Find:/);
});

test('timeline extra count excludes the first detail line', () => {
  const text = renderTimeline(createTheme(120, false), 120, {
    entries: [{ sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'TARGET', title: 'Event', detail: 'first\nsecond\nthird' }],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
  }).join('\n');
  assert.match(text, /Event|first|Codex/);
});

test('successful messages containing fail are not painted as errors', () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    const text = renderWorkbench({
      page: 'home', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: false,
      message: 'No failed checks remain; validation succeeded.',
      home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
    }, 120).join('\n');
    assert.doesNotMatch(text, /\x1b\[31m/);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
});

test('running timeline names a missing state origin as created', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [{ sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'HARNESS', title: 'State: ? → launching' }],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'launching', elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
  }).join('\n');
  assert.match(text, /To Unknown agent|Unknown agent|Preparing replay/);
  assert.doesNotMatch(text, /Codex/);
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
    hasUsableAuth: true,
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

test('help names the keys of the page it was opened on', () => {
  const running = helpLines('running').join('\n');
  assert.match(running, /f\s+Cycle (?:timeline )?filter/);
  assert.match(running, /o\s+Open full event output/);
  assert.match(running, /Enter\s+Expand command/);
  assert.match(running, /\/\s+Find in canvas/);
  assert.doesNotMatch(running, /Test connection/);

  const config = helpLines('config').join('\n');
  assert.match(config, /t\s+Test connection/);
  assert.doesNotMatch(config, /Cycle timeline filter/);

  // `t` and `d` are overloaded across pages, so inspection must not inherit the running meanings.
  const inspection = helpLines('inspection').join('\n');
  assert.match(inspection, /t\s+Toggle model text sharing/);
  assert.match(inspection, /Enter\s+Freeze the session from the first user task/);
  assert.doesNotMatch(inspection, /Select task input|Select task start/);
  assert.doesNotMatch(inspection, /Request cancellation/);

  const result = helpLines('result').join('\n');
  assert.match(result, /o\s+Open report\.html/);
  assert.match(result, /t\s+Open trace folder/);
  assert.doesNotMatch(result, /Test connection/);

  const global = helpLines().join('\n');
  assert.match(global, /Ctrl\+C/);
  assert.doesNotMatch(global, /This page/);
});

test('wide inspection keeps a session list beside the freeze card without a third preview column', () => {
  const inspection = {
    productId: 'codex', sessionId: 'session-1', sourcePath: 'C:\\tmp\\rollout-session-1.jsonl', startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source', summary: 'Fix the bug.',
    signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    transcript: [
      { id: 'message-1', role: 'user', text: 'Fix the bug.' },
      { id: 'message-2', role: 'assistant', text: 'Fixed it.' },
      { id: 'message-3', role: 'user', text: 'Verify the regression.' },
    ],
    finalMessage: 'Fixed it.',
  };
  const session = {
    productId: 'codex', sessionId: 'session-1', sourcePath: 'C:\\tmp\\rollout-session-1.jsonl', startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source', summary: 'Fix the bug.',
    signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
  const text = renderWorkbench({
    page: 'inspection', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: false,
    message: 'Review the session details and privacy policy before writing a TaskCase.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
    sessions: {
      level: 'sessions', projects: [{ key: 'source', label: 'source', path: 'C:/source', sessions: [session], latestAt: session.startedAt }],
      sessions: [session], selected: 0, filterEligible: false, query: '', searching: false,
    },
    inspection: { inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false },
  } as never, 120).join('\n');
  assert.match(text, /Review session/);
  assert.match(text, /Session start:/);
  assert.match(text, /Later user turns/);
  assert.match(text, /Fix the bug/);
  assert.equal((text.match(/┌─/g) ?? []).length, 2);
  assert.doesNotMatch(text, /┌─ Preview/);
});

test('a regular-width intake sheet keeps preview, panel close, search, and footer on a 24-row terminal', () => {
  const startedAt = '2026-08-13T00:00:00.000Z';
  const projects = Array.from({ length: 51 }, (_, index) => ({
    key: `p${index}`,
    label: `project-${index}`,
    path: `C:/work/project-${index}`,
    sessions: [{
      productId: 'codex', sessionId: `s${index}`, sourcePath: `s${index}.jsonl`, startedAt, cwd: `C:/work/project-${index}`,
      summary: `Task ${index}`,
      signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    }],
    latestAt: startedAt,
  }));
  const view = {
    page: 'sessions' as const,
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasUsableAuth: true,
    hasTaskCase: false,
    message: 'Select a project.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
    sessions: {
      level: 'projects' as const,
      projects,
      sessions: [],
      selected: 50,
      filterEligible: false,
      query: '',
      searching: false,
    },
  };
  const lines = renderWorkbench(view, 90, 24);
  const text = lines.join('\n');
  assert.equal(lines.length, 24);
  assert.match(text, /Preview/);
  assert.match(text, /\[\/\] Search/);
  assert.match(text, /└/);
  assert.match(text, /\[↑↓\]|\[Up\/Dn\]/);
  assert.match(text, /51\/51/);
  assert.equal((text.match(/┌─/g) ?? []).length, 2);
});

test('regular density paints an intake preview beside the list', () => {
  const theme = createTheme(90, false);
  const startedAt = '2026-08-12T21:40:00.000Z';
  const session = {
    productId: 'codex', sessionId: 'session-1', sourcePath: 'session-1.jsonl', startedAt, cwd: 'C:/work/wechat-bot',
    summary: 'Fix the regression',
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
  const text = renderSessions(theme, 90, {
    level: 'sessions',
    projects: [{ key: 'wechat-bot', label: 'wechat-bot', path: 'C:/work/wechat-bot', sessions: [session], latestAt: startedAt }],
    sessions: [session],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
  }, 16).join('\n');
  assert.match(text, /Preview/);
  assert.match(text, /Fix the regression/);
  assert.match(text, /Updated/);
  assert.equal((text.match(/┌─/g) ?? []).length, 2);
});

test('pending list rows show truncated summary, not an unreadable freeze verdict', () => {
  const theme = createTheme(90, false);
  const startedAt = '2026-08-12T21:40:00.000Z';
  const session = {
    productId: 'codex', sessionId: 'pending-1', sourcePath: 'pending.jsonl', startedAt, cwd: 'C:/work/app',
    summary: 'Late user lives past the window',
    recoveryReadiness: 'pending' as const,
    signals: { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
  const text = renderSessions(theme, 90, {
    level: 'sessions',
    projects: [{ key: 'app', label: 'app', path: 'C:/work/app', sessions: [session], latestAt: startedAt }],
    sessions: [session],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
    locale: 'en',
  }, 16).join('\n');
  assert.doesNotMatch(text, /\[pending full inspect\]/);
  assert.match(text, /Late user/);
  assert.doesNotMatch(text, /\[unreadable\]/);
});

test('session replay errors map to distinct operator copy', () => {
  assert.equal(sessionReplayErrorMessage(new SessionReplayError('no-user-input', 'x'), 'zh'), t('zh', 'notReplayableNoUserInput'));
  assert.equal(sessionReplayErrorMessage(new SessionReplayError('corrupt', 'x'), 'en'), t('en', 'notReplayableCorrupt'));
  assert.equal(sessionReplayErrorMessage(new Error('other'), 'en'), undefined);
});

test('intake lists honor their injected render clock', () => {
  const theme = createTheme(90, false);
  const startedAt = '2026-08-07T00:00:00.000Z';
  const session = {
    productId: 'codex', sessionId: 'session-clock', sourcePath: 'session-clock.jsonl', startedAt, cwd: 'C:/work/clock',
    summary: 'Keep visual frames stable',
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
  const base = {
    projects: [{ key: 'clock', label: 'clock', path: 'C:/work/clock', sessions: [session], latestAt: startedAt }],
    sessions: [session], selected: 0, filterEligible: false, query: '', searching: false,
    nowMs: Date.parse('2026-08-11T00:00:00.000Z'),
  } as const;
  const projects = renderSessions(theme, 90, { ...base, level: 'projects' }, 16).join('\n');
  const sessions = renderSessions(theme, 90, { ...base, level: 'sessions' }, 16).join('\n');
  assert.match(projects, /4d ago/);
  assert.match(sessions, /4d ago/);
});

test('project catalog title counts projects, sessions, projectless, and unreadable', () => {
  const theme = createTheme(120, false);
  const startedAt = '2026-08-12T21:40:00.000Z';
  const readable = {
    productId: 'codex', sessionId: 'ok', sourcePath: 'ok.jsonl', startedAt, cwd: 'C:/work/app',
    summary: 'Keep going', signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
  const missing = {
    productId: 'codex', sessionId: 'gone', sourcePath: 'gone.jsonl', startedAt, cwd: 'C:/work/app',
    summary: 'Missing transcript', availability: 'catalog-only' as const,
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
  const text = renderSessions(theme, 120, {
    level: 'projects',
    projects: [
      { key: 'codex\0c:/work/app', label: 'app', path: 'C:/work/app', sessions: [readable, missing], latestAt: startedAt },
      { key: 'empty', label: 'Empty', path: 'C:/work/empty', sessions: [], latestAt: '' },
      { key: 'projectless', label: 'Projectless sessions', sessions: [], latestAt: '' },
    ],
    sessions: [],
    selected: 1,
    filterEligible: false,
    query: '',
    searching: false,
  }, 16).join('\n');
  assert.match(text, /3 projects \/ 2 sessions \/ 0 projectless \/ 1 unreadable/);
  assert.match(text, /0 sessions/);
  assert.match(text, /Empty/);
});

test('project catalog shows a loading catalog state', () => {
  const theme = createTheme(90, false);
  const text = renderSessions(theme, 90, {
    level: 'projects',
    projects: [{ key: 'projectless', label: 'Projectless sessions', sessions: [], latestAt: '' }],
    sessions: [],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
    discoveryStatus: 'loading',
  }, 12).join('\n');
  assert.match(text, /reading local session catalog/);
});

test('relative time follows the workbench locale', () => {
  const now = Date.parse('2026-08-14T12:00:00.000Z');
  assert.equal(relativeTime('2026-08-13T12:00:00.000Z', now, 'zh'), '昨天');
  assert.equal(relativeTime('2026-08-11T12:00:00.000Z', now, 'zh'), '3 天前');
  assert.equal(relativeTime('2026-08-13T12:00:00.000Z', now, 'en'), 'yesterday');
});

test('a colored theme emits Grok-style controller and target codes', () => {
  const theme = createTheme(80, true);
  assert.match(theme.style.controller('sent'), /\u001b\[/);
  assert.match(theme.style.target('screen'), /\u001b\[/);
  assert.match(theme.style.selected('row'), /\u001b\[/);
  assert.notEqual(theme.style.controller('sent'), 'sent');
});

test('preflight wait paints a checking card instead of an empty overlay', () => {
  const text = renderWorkbench({
    page: 'preflight', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: true,
    message: 'Inspecting source and deterministic contamination signals; no model will be called.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
  }, 120).join('\n');
  assert.match(text, /Checking source/);
  assert.match(text, /Inspecting source/);
  assert.doesNotMatch(text, /Review run confirmation/);
});

test('a short viewport trims chrome and refuses to paint below the minimum height', () => {
  const view = {
    page: 'home' as const,
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasUsableAuth: true,
    hasTaskCase: false,
    message: 'Reprise is a Benchmark workbench; enter /help to see available actions.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
  };
  const short = renderWorkbench(view, 60, 14);
  const roomy = renderWorkbench(view, 60, 40);
  assert.ok(short.length <= 14, `expected <= 14 lines, got ${short.length}`);
  // Dividers and the second header row are the rows a short terminal cannot afford.
  assert.equal(short.filter(isDivider).length, 0);
  assert.ok(roomy.filter(isDivider).length >= 2, 'a roomy viewport keeps its dividers');

  const tiny = renderWorkbench(view, 60, 6).join('\n');
  assert.match(tiny, /too short/);
});

function isDivider(line: string): boolean {
  return /^[-─]{10,}$/.test(line.trim());
}


test('header names no default product before the user selects one', () => {
  const text = renderWorkbench({
    page: 'home', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: false,
    message: 'Welcome back.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
  }, 120).join('\n');
  assert.match(text, /Product unset/);
  assert.doesNotMatch(text, /Codex/);
  assert.doesNotMatch(text, /Agent unset/);
});

test('running timeline uses the selected product and has no Codex fallback', () => {
  const theme = createTheme(120, false);
  const base = {
    entries: [], selected: 0, filter: 'ALL' as const, following: true, cancelling: false,
    currentState: undefined, elapsed: '00:00', turns: { used: 0 }, calls: { used: 0 }, detailExpanded: false,
  };
  const claude = renderTimeline(theme, 120, { ...base, productLabel: 'Claude Code' }).join('\n');
  const unknown = renderTimeline(theme, 120, base).join('\n');
  assert.match(claude, /To Claude Code/);
  assert.doesNotMatch(claude, /Codex/);
  assert.match(unknown, /To Unknown agent/);
  assert.doesNotMatch(unknown, /Codex/);
});

test('header shows Harness env unset and does not send Next to /config', () => {
  const text = renderWorkbench({
    page: 'home',
    cwd: 'C:\\src',
    modelId: 'gpt-5.6-terra',
    effort: 'medium',
    hasApiConfig: true,
    hasUsableAuth: false,
    envName: 'OPENAI_API_KEY',
    productLabel: 'Claude Code',
    productConfigured: true,
    hasTaskCase: false,
    message: 'Welcome back.',
    home: {
      taskCase: undefined,
      recentExperiment: undefined,
      hasApiConfig: true,
      hasUsableAuth: false,
      envName: 'OPENAI_API_KEY',
      envSet: false,
        providerLabel: 'dzzzz-openai',
      modelId: 'gpt-5.6-terra',
      composer: '',
      showSuggestions: false,
    },
  }, 120).join('\n');
  assert.match(text, /Harness env unset/);
  assert.match(text, /Claude Code/);
  assert.doesNotMatch(text, /Codex/);
  assert.doesNotMatch(text, /API key missing/);
  assert.doesNotMatch(text, /API ready/);
  assert.match(text, /\/config|Endpoint, model/);
  assert.match(text, /needs a task|needs env/);
  assert.match(text, /OPENAI_API_KEY/);
  assert.match(text, /\$env:OPENAI_API_KEY = '<value>'|export OPENAI_API_KEY='<value>'/);
  assert.doesNotMatch(text, /Next: \/config/);
});

test('running voice cards use a left bar and hide ready MCP status', () => {
  const theme = createTheme(120, false);
  const text = renderTimeline(theme, 120, {
    entries: [
      { sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'CONTROLLER', title: 'Input to Target', detail: 'Fix the failing test.' },
      { sequence: 2, occurredAt: '2026-08-11T00:10:01.000Z', source: 'TARGET', title: 'MCP · linuxdo ready' },
      { sequence: 3, occurredAt: '2026-08-11T00:10:02.000Z', source: 'TARGET', title: 'Visible response', detail: 'public response line 1' },
    ],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:12', turns: { used: 1 }, calls: { used: 0 }, detailExpanded: false,
  }).join('\n');
  assert.match(text, /▎|To Codex|Fix the failing test/);
  assert.match(text, /public response line 1/);
  assert.doesNotMatch(text, /linuxdo ready/);
});

test('a colored running card paints a voice background', () => {
  const theme = createTheme(120, true);
  const text = renderTimeline(theme, 80, {
    entries: [
      { sequence: 1, occurredAt: '2026-08-11T00:10:00.000Z', source: 'CONTROLLER', title: 'Input to Target', detail: 'Fix the failing test.' },
    ],
    selected: 0, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '00:12', turns: { used: 1 }, calls: { used: 0 }, detailExpanded: false,
  }).join('\n');
  assert.match(text, /\u001b\[48;/);
  assert.match(text, /Fix the failing test/);
});

test('a following timeline keeps the latest events in a short viewport', () => {
  const theme = createTheme(120, false);
  const entries = Array.from({ length: 40 }, (_, index) => ({
    sequence: index + 1,
    occurredAt: '2026-08-11T00:10:00.000Z',
    source: 'TARGET' as const,
    title: `Event ${index + 1}`,
  }));
  const text = renderTimeline(theme, 120, {
    entries, selected: 39, filter: 'ALL', following: true, cancelling: false,
    currentState: 'awaiting_target', elapsed: '01:12', turns: { used: 1, max: 4 },
    calls: { used: 0, max: 3 }, detailExpanded: false,
  }, 12).join('\n');
  assert.match(text, /Event 40/);
  assert.doesNotMatch(text, /Event 1\b/);
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
  assert.match(frame, /Continue|Browse|\/ command/);
  assert.match(frame, /\/config|\/intake|\/run/);
  app.handleInput('?');
  assert.match(app.preview(120), /Commands: \/config, \/intake, \/run, \/history/);
});


test('production layout accepts bracketed paste and completes a unique Home command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-tui-bracketed-paste-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const term = new FakeTerminal(120, 30);
  const tui = new TuiAltScreen(term, false, undefined, { mouse: false });
  t.after(() => tui.stop());
  const app = new CodexIntakeTui({
    dataDir: join(root, 'data'), sessionsRoot: join(root, 'sessions'), tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  app.handleInput('\x1b[200~/c\x1b[201~');
  app.handleInput('\r');
  let frame = renderFrame(tui, term, 30, 120);
  assert.match(frame, /Harness connection/);

  // Pi catalog model selection is a picker. Toggle once to the editable OpenAI-compatible draft.
  app.handleInput('\r');
  app.handleInput('\x1b[B');
  app.handleInput('\x1b[B');
  app.handleInput('\x1b[B');
  app.handleInput('\r');
  app.handleInput('\x15');
  app.handleInput('\x1b[200~pasted-model\x1b[201~');
  frame = renderFrame(tui, term, 30, 120);
  assert.match(frame, /pasted-model/);
});


test('run confirmation only restates the start decision', () => {
  const theme = createTheme(120, false);
  const preflight = {
    sourceBaseline: 'available',
    resolved: { executable: 'codex', resolvedModel: 'gpt-5', version: '1.0.0' },
    limitations: [], comparisonClass: 'recovered',
  } as never;
  const text = renderConfirmation(theme, 120, {
    preflight,
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Claude Code',
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
  }).join('\n');
  assert.match(text, /Start isolated Claude Code Candidate[?]/);
  assert.match(text, /Claude Code\s+·\s+gpt-5/);
  assert.doesNotMatch(text, /isolated Codex/);
  assert.doesNotMatch(text, /Maximum requests/);
  assert.doesNotMatch(text, /Network \/ billing/);
  assert.doesNotMatch(text, /privacy sanitization/);
  assert.match(text, /Original directory stays unchanged/);
  const zhText = renderConfirmation(theme, 120, {
    preflight,
    candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessModel: 'gpt-5',
    harnessAuthOk: true,
    productLabel: 'Codex',
    policy: { wallClockMs: 60_000, maxTargetTurns: 4, maxModelCalls: 3, turnTimeoutMs: 10_000, maxConsecutiveNoProgress: 2 },
    locale: 'zh',
  }).join('\n');
  assert.match(zhText, /第 3 \/ 3 步/);
  assert.match(zhText, /可能产生费用/);
  assert.doesNotMatch(zhText, /Confirm run|Maximum requests|Network \/ billing|This starts a/);
});

test('preflight and history views expose snapshot and storage size', () => {
  const theme = createTheme(120, false);
  const preflight = {
    sourceBaseline: 'available',
    resolved: { executable: 'codex', resolvedModel: 'gpt-5', version: '1.0.0' },
    limitations: [], comparisonClass: 'observational',
    workspace: { fileCount: 7, totalBytes: 2 * 1024 * 1024, largestFileBytes: 1024, blockedReasons: [] },
  } as never;
  const preflightText = renderPreflight(theme, 120, { preflight, candidate: { candidateId: 'candidate-test', productId: 'codex', requestedModel: 'gpt-5' }, step: 2 }).join('\n');
  assert.match(preflightText, /Files/);
  assert.match(preflightText, /Source size/);
  assert.match(preflightText, /Status.*runnable/);
  const historyText = renderHistory(theme, 120, { totalBytes: 3 * 1024 * 1024, tab: 'runs', items: [], selected: 0 }).join('\n');
  assert.match(historyText, /Storage 3[.]0 MiB/);
});

test('history windows long lists around the selection', () => {
  const theme = createTheme(120, false);
  const items = Array.from({ length: 20 }, (_, index) => ({
    experimentId: `experiment-${index + 1}`,
    taskCaseId: 'case-1',
    outcome: 'completed',
    startedAt: '2026-08-13T00:00:00.000Z',
    path: `C:/data/experiments/experiment-${index + 1}`,
    sizeBytes: 0,
  }));
  const text = renderHistory(theme, 120, { totalBytes: 0, tab: 'runs', items, selected: 15 }).join('\n');
  assert.match(text, /experiment-16/);
  assert.match(text, /16\/20/);
  assert.doesNotMatch(text, /experiment-1\s/);
});

test('result page advertises opening its local report and trace', () => {
  assert.deepEqual(resultHints(), [['o', 'Open report'], ['t', 'Open trace'], ['/', 'Find'], ['Enter', 'Home'], ['b', 'Home']]);
});

test('failed result shows the recorded failure instead of limitations copy', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: ['fingerprint differs'] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        termination: {
          kind: 'failed',
          code: 'failed.controller',
          failure: { origin: 'controller', code: 'privacy_blocked', message: 'Model text is disallowed by TaskCase privacy policy.', evidenceRefs: [] },
        },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'failed' },
    comparison: { result: { status: 'failed' } },
  } as never).join('\n');
  assert.match(text, /failed\.controller/);
  assert.match(text, /Controller: Model text is disallowed by TaskCase privacy policy/);
  assert.doesNotMatch(text, /Limitations|Single run|fingerprint differs/);
});

test('runtime failure identifies the selected product rather than Codex', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    record: {
      attempt: { runId: 'run-1' },
      outcome: {
        termination: {
          kind: 'failed', code: 'failed.runtime',
          failure: { origin: 'runtime', code: 'runtime.invalid_json', message: 'invalid JSON', evidenceRefs: [] },
        },
        cleanup: { status: 'complete' },
      },
    },
    decision: { status: 'failed' },
    comparison: { result: { status: 'failed' } },
  } as never, 'en', 'Claude Code').join('\n');
  assert.match(text, /Claude Code: invalid JSON/);
  assert.match(text, /not a Claude Code runtime crash/);
  assert.doesNotMatch(text, /Codex/);
});

test('blocked result is a warning with controller reason and short paths', () => {
  const theme = createTheme(120, false);
  const lines = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked', rationale: 'Sandbox denied the WeChat data path.' } },
    comparison: { result: { status: 'completed' } },
  } as never);
  for (const line of lines) assert.equal(visibleWidth(line), 120, line);
  const text = lines.join('\n');
  assert.match(text, /blocked\.controller_done/);
  assert.match(text, /done · blocked/);
  assert.match(text, /Sandbox denied the WeChat data path/);
  assert.match(text, /Report\s+.*report\.html/);
  assert.match(text, /Trace\s+.*runs\/run-1\//);
  assert.match(text, /\u001b\]8;;file:\/\/\/.*report\.html\u001b\\/);
  assert.match(text, /\u001b\]8;;file:\/\/\/.*runs[/\\]run-1\u001b\\/);
  assert.doesNotMatch(text, /C:\\exp\\report\.html/);
  assert.doesNotMatch(text, /✗ blocked/);
  assert.doesNotMatch(text, /Cost not recorded|not recorded/);
});

test('limit_reached result explains the turn cap', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { termination: { kind: 'limit_reached', code: 'limit.target_turns' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'send', message: 'Continue.' } },
    comparison: { result: { status: 'completed' } },
  } as never).join('\n');
  assert.match(text, /limit\.target_turns/);
  assert.match(text, /target turn limit/);
  assert.match(text, /Comparison still ran/);
});

test('compact result keeps Trace on one line', () => {
  const theme = createTheme(60, false);
  const text = renderResult(theme, 60, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-6d6a47ae-e824-4f40-b1ad-35565ba8943c' },
      outcome: { termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 49_000, turns: 1, controllerCalls: 1 },
  } as never).join('\n');
  assert.match(text, /49s/);
  assert.match(text, /1 turn/);
  assert.match(text, /Trace\s+.*runs\/run-6d6a47ae/);
  assert.doesNotMatch(text, /\n\s+runs\//);
});

test('result metrics name candidate time when comparison made the experiment longer', () => {
  const theme = createTheme(120, false);
  const text = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    preflight: { sourceBaseline: 'available', resolved: { productId: 'codex', executable: 'codex', requestedModel: 'gpt-5', resolvedModel: 'gpt-5' }, limitations: [] },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { termination: { kind: 'blocked', code: 'blocked.controller_done' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'blocked' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 72_000, elapsedMs: 148_000, turns: 1, controllerCalls: 1 },
  } as never).join('\n');
  assert.match(text, /148s/);
  assert.match(text, /candidate 72s/);
});

test('narrow running hints keep filter and cancel', () => {
  const theme = createTheme(60, false);
  const line = keyHints(theme, runningHints('ALL', true), 60);
  assert.ok(visibleWidth(line) <= 60, line);
  assert.match(line, /\[f\]/);
  assert.match(line, /Ctrl\+C/);
});
