import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme } from '../src/tui/theme.js';
import {
  groupSessionsByProject, matchesIntakeQuery, projectLabel, renderInspection, sessionTitle,
} from '../src/tui/pages/intake.js';
import type { SessionInspection } from '../src/products/contract.js';

test('session titles drop leading Windows paths from PPT prompts', () => {
  const title = sessionTitle('For "C:\\Users\\example\\slides\\report.pptx", make the requested changes.');
  assert.doesNotMatch(title, /C:\\Users\\example\\slides/);
  assert.match(title, /make the requested changes/i);
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
  assert.equal(grouped.at(-1)?.label, 'Unknown project');
  assert.equal(projectLabel('C:\\Users\\example\\slides'), 'slides');
});

test('unindexed rollouts stay in projectless even when transcript cwd is present', () => {
  const grouped = groupSessionsByProject([
    { ...session('unindexed', 'C:\\work\\notes', '2026-08-13T01:00:00.000Z', 'Loose rollout'), availability: 'unindexed', sourceKind: 'rollout-only' },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]?.key, 'projectless');
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
  assert.deepEqual(grouped.map((item) => item.label).sort(), ['home/notes', 'work/notes']);
});

test('inspection freezes the whole session from the first user message', () => {
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
  assert.equal(grouped.length, 3);
  assert.equal(grouped.find((item) => item.sessions.some((entry) => entry.sessionId === 'absolute-a'))?.sessions.length, 2);
  assert.equal(grouped.filter((item) => item.label === 'Unknown project').length, 2);
});

test('project grouping disambiguates duplicate workspace basenames with parent paths', () => {
  const grouped = groupSessionsByProject([
    session('alpha', 'C:/work/alpha/app', '2026-08-13T01:00:00.000Z', 'Alpha'),
    session('beta', 'C:/work/beta/app', '2026-08-13T02:00:00.000Z', 'Beta'),
  ]);
  assert.deepEqual(grouped.map((project) => project.label).sort(), ['alpha/app', 'beta/app']);
});
