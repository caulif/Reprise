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
