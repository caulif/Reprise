import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme } from '../src/tui/theme.js';
import {
  groupSessionsByProject, matchesIntakeQuery, projectLabel, renderInspection, renderSessions, sessionListTitle, sessionTitle, taskDisplaySummary, formatDiscoverySignals,
  selectDefaultProjectIndex,
} from '../src/tui/pages/intake.js';
import { renderWorkbench } from '../src/tui/workbench.js';
import type { SessionInspection } from '../src/products/contract.js';

test('session titles drop leading Windows paths from PPT prompts', () => {
  const title = sessionTitle('For "C:\\Users\\example\\slides\\report.pptx", make the requested changes.');
  assert.doesNotMatch(title, /C:\\Users\\example\\slides/);
  assert.match(title, /make the requested changes/i);
});

test('session list titles use later short user tasks while a lone first message stays first', () => {
  const instruction = '# AGENTS.md\n1. Keep the skill. 2. don\'t re-write it. 3. More rules here that go on for a while so this looks like injected instructions.';
  const later = session('later-task', 'C:\\work\\slides', '2026-08-13T01:00:00.000Z', instruction);
  const withLater = { ...later, laterUserSummaries: ['Make a 10-page briefing deck about the CNCERT findings.'] };
  assert.match(sessionListTitle(withLater), /briefing deck/i);
  assert.doesNotMatch(sessionListTitle(withLater), /don't re-write it/i);
  assert.match(sessionListTitle(later), /AGENTS.md/);
  const theme = createTheme(120, false);
  const listed = renderSessions(theme, 120, {
    level: 'sessions',
    projects: [{ key: 'slides', label: 'slides', path: 'C:\\work\\slides', sessions: [withLater], latestAt: withLater.startedAt }],
    sessions: [withLater],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
    locale: 'en',
  }, 16).join('\n');
  assert.match(listed, /briefing deck/i);
  assert.doesNotMatch(listed, /don't re-write it/i);
  const latest = renderSessions(theme, 120, {
    level: 'projects',
    projects: [{ key: 'slides', label: 'slides', path: 'C:\\work\\slides', sessions: [withLater], latestAt: withLater.startedAt }],
    sessions: [withLater],
    selected: 0,
    filterEligible: false,
    query: '',
    searching: false,
    locale: 'en',
  }, 16).join('\n');
  assert.match(latest, /briefing deck/i);
});

test('task display summary uses the later short user task when the first message is an instruction block', () => {
  const title = taskDisplaySummary(
    '# AGENTS.md\n1. Keep the skill. 2. don\'t re-write it. 3. More rules here that go on for a while so this looks like injected instructions.',
    ['Make a 10-page briefing deck about the CNCERT findings.'],
  );
  assert.match(title, /briefing deck/i);
  assert.doesNotMatch(title, /don't re-write it/i);
});

test('sessions group by workspace basename and send missing cwd to 其他', () => {
  const grouped = groupSessionsByProject([
    session('a', 'C:\\obsidian\\notes', '2026-08-13T01:00:00.000Z', 'First'),
    session('b', 'c:\\obsidian\\notes', '2026-08-12T01:00:00.000Z', 'Second'),
    session('c', undefined, '2026-08-11T01:00:00.000Z', 'Loose'),
    session('d', 'C:\\blog', '2026-08-13T02:00:00.000Z', 'Post'),
  ]);
  assert.equal(grouped[0]?.label, 'blog');
  assert.equal(grouped.find((item) => item.label === 'notes')?.sessions.length, 2);
  assert.equal(grouped.find((item) => item.key === 'projectless')?.sessions.length, 0);
  assert.equal(grouped.at(-1)?.label, 'Unknown project');
  assert.equal(projectLabel('C:\\Users\\example\\slides'), 'slides');
});

test('project list default cursor prefers last project, then cwd, and skips harness checkout', () => {
  const hermes = { key: 'hermes', label: '.hermes', path: 'C:/wsl/.hermes', sessions: [session('h', 'C:/wsl/.hermes', '2026-08-31T12:00:00.000Z', 'Hermes')], latestAt: '2026-08-31T12:00:00.000Z' };
  const ppt = { key: 'ppt', label: 'ppt', path: 'C:/work/cncert', sessions: [session('p', 'C:/work/cncert', '2026-08-30T12:00:00.000Z', 'PPT')], latestAt: '2026-08-30T12:00:00.000Z' };
  const reprise = { key: 'reprise', label: 'reprise开发', path: 'C:/work/Reprise', sessions: [session('r', 'C:/work/Reprise', '2026-08-29T12:00:00.000Z', 'Harness')], latestAt: '2026-08-29T12:00:00.000Z' };
  const projects = [hermes, ppt, reprise];
  assert.equal(selectDefaultProjectIndex(projects, 'C:/work/cncert'), 1);
  assert.equal(selectDefaultProjectIndex(projects, 'C:/unrelated'), 0);
  assert.equal(selectDefaultProjectIndex(projects, 'C:/unrelated', 'ppt'), 1);
  assert.equal(selectDefaultProjectIndex(projects, 'C:/work/Reprise', '', 'C:/work/Reprise/docs/.local/data'), 0);
  assert.equal(selectDefaultProjectIndex(projects, 'C:/work/Reprise', 'ppt', 'C:/work/Reprise/docs/.local/data'), 1);
});

test('unindexed rollouts stay in projectless even when transcript cwd is present', () => {
  const grouped = groupSessionsByProject([
    { ...session('unindexed', 'C:\\work\\notes', '2026-08-13T01:00:00.000Z', 'Loose rollout'), availability: 'unindexed', sourceKind: 'rollout-only' },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.key, 'projectless');
});

test('unindexed rollouts join a catalog project when cwd is under that root', () => {
  const grouped = groupSessionsByProject(
    [{ ...session('unindexed', 'C:\\work\\notes\\app', '2026-08-13T01:00:00.000Z', 'Loose rollout'), availability: 'unindexed', sourceKind: 'rollout-only' }],
    [{ key: 'codex\0c:/work/notes', label: 'notes', path: 'C:\\work\\notes' }],
  );
  assert.equal(grouped[0]?.key, 'codex\0c:/work/notes');
  assert.equal(grouped[0]?.sessions.length, 1);
});

test('project grouping keeps products and unknown workspaces isolated', () => {
  const grouped = groupSessionsByProject([
    session('codex-session', 'C:\\work\\notes', '2026-08-13T01:00:00.000Z', 'Codex'),
    { ...session('claude-session', 'C:\\work\\notes', '2026-08-13T02:00:00.000Z', 'Claude'), productId: 'claude-code' },
    session('unknown-a', undefined, '2026-08-13T03:00:00.000Z', 'A'),
    session('unknown-b', undefined, '2026-08-13T04:00:00.000Z', 'B'),
  ]);
  assert.deepEqual(grouped.map((item) => item.label).filter((label) => label.includes('work/notes')).sort(), ['claude-code · work/notes', 'codex · work/notes']);
  assert.equal(grouped.filter((item) => item.label === 'Unknown project').length, 2);
});

test('intake search matches project name, path, time, and task text', () => {
  const item = session('id-1', 'C:\\Users\\example\\slides', '2026-08-13T07:19:57.610Z', 'Fix the three-column layout');
  assert.equal(matchesIntakeQuery(item, 'slides'), true);
  assert.equal(matchesIntakeQuery(item, 'layout'), true);
  assert.equal(matchesIntakeQuery(item, 'three-column'), true);
  assert.equal(matchesIntakeQuery(item, '07:19'), true);
  assert.equal(matchesIntakeQuery(item, 'clash'), false);
});

test('duplicate project basenames keep the parent directory', () => {
  const grouped = groupSessionsByProject([
    session('a', 'C:\\work\\notes', '2026-08-13T01:00:00.000Z', 'One'),
    session('b', 'C:\\home\\notes', '2026-08-13T02:00:00.000Z', 'Two'),
  ]);
  assert.deepEqual(grouped.map((item) => item.label).sort(), ['Projectless sessions', 'home/notes', 'work/notes']);
});

test('inspection freezes the whole session from the first user task', () => {
  const theme = createTheme(120, false);
  const inspection = {
    productId: 'codex',
    sessionId: 'session-1',
    sourcePath: 'C:\\tmp\\rollout-session-1.jsonl',
    startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source',
    summary: 'Fix the bug.',
    signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    transcript: [
      { id: 'message-1', role: 'user', text: 'Fix the bug.' },
      { id: 'message-2', role: 'assistant', text: 'Fixed it.' },
      { id: 'message-3', role: 'user', text: 'Verify the regression.' },
    ],
    finalMessage: 'Fixed it.',
  } as SessionInspection;
  const first = renderInspection(theme, 120, {
    inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false,
  }).join('\n');
  assert.match(first, /Session start:[\s\S]*Fix the bug\./);
  assert.match(first, /Later user turns \(Controller will see these\)/);
  assert.match(first, /2\/2\s+Verify the regression\./);
  assert.match(first, /Source:/);
  assert.match(first, /Review session/);
  assert.match(first, /Nothing is written until you press Enter/);
  assert.doesNotMatch(first, /Choose task start|Select task start|Freeze this message:/);
  const ignoredSelection = renderInspection(theme, 120, {
    inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 1, showOutcome: false,
  }).join('\n');
  assert.match(ignoredSelection, /Session start:/);
  assert.match(ignoredSelection, /Fix the bug\./);
  assert.match(ignoredSelection, /Later user turns \(Controller will see these\)[\s\S]*2\/2\s+Verify the regression\./);
});

test('inspection start skips an injected instruction block', () => {
  const theme = createTheme(120, false);
  const inspection = {
    productId: 'codex',
    sessionId: 'session-agents',
    sourcePath: 'C:\\tmp\\rollout-agents.jsonl',
    startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source',
    summary: '# AGENTS.md\nFollow these rules.',
    signals: { userMessages: 2, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
    transcript: [
      { id: 'message-1', role: 'user', text: '# AGENTS.md\nFollow these rules. don\'t re-write it' },
      { id: 'message-2', role: 'assistant', text: 'Loaded.' },
      { id: 'message-3', role: 'user', text: 'Fix the login regression.' },
    ],
    finalMessage: 'Loaded.',
  } as SessionInspection;
  const text = renderInspection(theme, 120, {
    inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false,
  }).join('\n');
  assert.match(text, /Session start:[\s\S]*Fix the login regression\./);
  assert.doesNotMatch(text, /don't re-write it/i);
  const laterSection = text.split(/Later user turns \(Controller will see these\)/)[1] ?? '';
  assert.doesNotMatch(laterSection, /AGENTS\.md/);
});

test('a 24-row inspection still shows the freeze decision', () => {
  const theme = createTheme(120, false);
  const inspection = {
    productId: 'codex',
    sessionId: 'session-1',
    sourcePath: 'C:\\tmp\\rollout-session-1.jsonl',
    startedAt: '2026-08-13T07:19:57.610Z',
    cwd: 'C:\\yanjiusheng\\本子与项目撰写\\CNCERT项目-漏洞整理\\20260810汇报ppt',
    summary: '对于"C:\\\\tmp\\\\a.pptx"这个ppt，现在需要做的修改如下，请截图理解对应的页',
    signals: { userMessages: 3, assistantMessages: 4, toolCalls: 60, completedTurns: 3 },
    transcript: [
      { id: 'message-1', role: 'user', text: '对于"C:\\\\tmp\\\\重点研发计划中期报告-0811.pptx"这个ppt，现在需要做的修改如下，请截图理解对应的页，然后写一个文档，告诉我各个页怎么改：三列技术路线。'.repeat(3) },
      { id: 'message-2', role: 'assistant', text: 'ok' },
      { id: 'message-3', role: 'user', text: '请你给出修改后的这几页的ppt' },
      { id: 'message-4', role: 'user', text: '你自己截图看看，现在整个页面都不对了' },
    ],
    finalMessage: '已重排修改稿',
  } as SessionInspection;
  const frame = renderInspection(theme, 120, {
    inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false,
  }, 19).join('\n');
  assert.match(frame, /Nothing is written until you press Enter/);
  assert.match(frame, /Session start:/);
  assert.match(frame, /Review session/);
  assert.doesNotMatch(frame, /yanjiusheng/);
});

test('inspection without user input does not show a freeze card', () => {
  const theme = createTheme(120, false);
  const inspection = {
    productId: 'codex',
    sessionId: 'session-empty',
    sourcePath: 'C:/tmp/empty.jsonl',
    startedAt: '2026-08-11T00:00:00.000Z',
    cwd: 'C:/source',
    transcript: [{ id: 'message-1', role: 'assistant', text: 'No user asked anything.' }],
    signals: { userMessages: 0, assistantMessages: 1, toolCalls: 0, completedTurns: 0 },
  } as SessionInspection;
  const frame = renderInspection(theme, 120, {
    inspection, privacy: { allowModelText: false, allowBinary: false, redactions: [] }, selectedTaskInput: 0, showOutcome: false,
  }).join('\n');
  assert.match(frame, /Cannot replay: no eligible user input/);
  assert.doesNotMatch(frame, /Session start:/);
});

function session(id: string, cwd: string | undefined, startedAt: string, summary: string) {
  return {
    productId: 'codex', sessionId: id, sourcePath: `${id}.jsonl`, startedAt, ...(cwd ? { cwd } : {}), summary,
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
}

test('project sessions use sourcePath as a deterministic time tie-breaker', () => {
  const at = '2026-08-13T01:00:00.000Z';
  const grouped = groupSessionsByProject([
    { ...session('z', 'C:\\work\\notes', at, 'Z'), sourcePath: 'C:/sessions/z.jsonl', updatedAt: at },
    { ...session('a', 'C:\\work\\notes', at, 'A'), sourcePath: 'C:/sessions/a.jsonl', updatedAt: at },
  ]);
  assert.deepEqual(grouped[0]?.sessions.map((item) => item.sourcePath), ['C:/sessions/a.jsonl', 'C:/sessions/z.jsonl']);
});

test('project grouping canonicalizes only absolute workspaces and never merges relative paths', () => {
  const grouped = groupSessionsByProject([
    session('absolute-a', 'C:\\work\\notes', '2026-08-13T01:00:00.000Z', 'Absolute A'),
    session('absolute-b', 'c:/work/notes/', '2026-08-13T02:00:00.000Z', 'Absolute B'),
    session('relative-a', 'work/notes', '2026-08-13T03:00:00.000Z', 'Relative A'),
    session('relative-b', 'work/notes', '2026-08-13T04:00:00.000Z', 'Relative B'),
  ]);
  assert.equal(grouped.length, 4);
  assert.equal(grouped.find((item) => item.sessions.some((entry) => entry.sessionId === 'absolute-a'))?.sessions.length, 2);
  assert.equal(grouped.filter((item) => item.label === 'Unknown project').length, 2);
});

test('project grouping disambiguates duplicate workspace basenames with parent paths', () => {
  const grouped = groupSessionsByProject([
    session('alpha', 'C:/work/alpha/app', '2026-08-13T01:00:00.000Z', 'Alpha'),
    session('beta', 'C:/work/beta/app', '2026-08-13T02:00:00.000Z', 'Beta'),
  ]);
  assert.deepEqual(grouped.map((project) => project.label).sort(), ['Projectless sessions', 'alpha/app', 'beta/app']);
});

test('partial discovery summaries omit uncounted assistant and tool signals', () => {
  const counted = {
    signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  };
  const partial = {
    ...counted,
    partial: true as const,
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
  const catalogOnly = {
    ...counted,
    availability: 'catalog-only' as const,
    signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
  assert.equal(formatDiscoverySignals(counted), 'u1 a1 t0');
  assert.equal(formatDiscoverySignals(partial), 'u1');
  assert.equal(formatDiscoverySignals(catalogOnly), 'u1');
  const theme = createTheme(120, false);
  const listed = renderSessions(theme, 120, {
    level: 'sessions',
    projects: [{ key: 'app', label: 'app', path: 'C:/work/app', sessions: [{
      productId: 'codex', sessionId: 's1', sourcePath: 's1.jsonl', startedAt: '2026-08-13T00:00:00.000Z',
      cwd: 'C:/work/app', summary: 'Catalog row', partial: true,
      signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    }], latestAt: '2026-08-13T00:00:00.000Z' }],
    sessions: [{
      productId: 'codex', sessionId: 's1', sourcePath: 's1.jsonl', startedAt: '2026-08-13T00:00:00.000Z',
      cwd: 'C:/work/app', summary: 'Catalog row', partial: true,
      signals: { userMessages: 1, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
    }],
    selected: 0, filterEligible: false, query: '', searching: false, locale: 'en',
  }, 16).join('\n');
  assert.match(listed, /u1/);
  assert.doesNotMatch(listed, /a0/);
  assert.doesNotMatch(listed, /\[partial summary\]/);
});

test('a selected session product uses a filled header lamp', () => {
  const unset = renderWorkbench({
    page: 'home', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: false,
    message: 'Welcome back.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
  }, 120).join('\n');
  const selected = renderWorkbench({
    page: 'sessions', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: false, hasTaskCase: false,
    productLabel: 'Codex', productConfigured: true,
    message: 'Select an agent product.',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: false, composer: '', showSuggestions: false },
    sessions: {
      level: 'products', projects: [], sessions: [], selected: 0, filterEligible: false, query: '', searching: false,
      products: [{ productId: 'codex', displayName: 'Codex', packVersion: '0.1.0', discoveryStatus: 'idle' }],
    },
  } as never, 120).join('\n');
  assert.match(unset, /○ Product unset|o Product unset/);
  assert.match(selected, /● Codex|\* Codex/);
  assert.doesNotMatch(selected, /Product unset/);
});

test('discovery messages wrap on semantic lines instead of mid-phrase', () => {
  const text = renderWorkbench({
    page: 'sessions', cwd: 'C:\\src', hasApiConfig: true, hasUsableAuth: true, hasTaskCase: false,
    productLabel: 'Codex', productConfigured: true,
    message: 'Choose a historical session. Enter opens the review; Enter again freezes and starts recovery.\nLoaded 3 projects and 2 sessions.\n2 shown · 0 skipped · 2 scanned.\nThe catalog is complete; m does not paginate.\nDiagnostics: catalog index unavailable (not this row) (1).',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
    sessions: {
      level: 'sessions',
      projects: [{ key: 'reprise', label: 'reprise', path: 'C:/reprise', sessions: [], latestAt: '' }],
      sessions: [], selected: 0, filterEligible: false, query: '', searching: false,
    },
  } as never, 72).join('\n');
  assert.match(text, /2 shown · 0 skipped · 2 scanned/);
  assert.doesNotMatch(text, /2\n sessions/);
  assert.match(text, /catalog index unavailable \(not this row\)/);
});
