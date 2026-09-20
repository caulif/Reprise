import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import {
  activityRoleLabel,
  activityStatusLabel,
  captionPublicLive,
  collapseAgentRows,
  entryRole,
  errorFingerprint,
  excerptId,
  isTurnBoundary,
  lastLiveVerb,
  projectAgentTool,
  projectWorkingNow,
  toolCaption,
} from '../../src/tui/agent-activity.js';
import { foldProcessEntries, paneOf } from '../../src/tui/fold-process.js';
import { activityDetailModel, helpLines, renderActivityDetail } from '../../src/tui/overlays.js';
import { layoutScrollback, matchesFilter, resetScrollbackLayoutCache } from '../../src/tui/scrollback.js';
import { createTheme } from '../../src/tui/theme.js';
import {
  appendTimelineEntries,
  flushFoldTitle,
  projectTimelineEvent,
  type TimelineEntry,
} from '../../src/tui/timeline.js';
import { wrapBodyLine } from '../../src/tui/widgets.js';

const timestamp = '2026-09-20T07:00:00.000Z';

function event(type: string, payload: unknown, extras: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: extras.sequence ?? 1,
    eventId: extras.eventId ?? `event-${extras.sequence ?? 1}`,
    occurredAt: extras.occurredAt ?? timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

test('T05 R05: same error ×5 keeps refs; cross-role errors stay separate', () => {
  const timeline: TimelineEntry[] = [];
  const message = 'Path must be a relative path without ..';
  for (let index = 0; index < 5; index += 1) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
      role: 'comparison',
      tool: 'read',
      message,
    }, { sequence: index + 1, eventId: `cmp-${index}` })));
  }
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_failed', {
    role: 'recovery',
    tool: 'read',
    message,
  }, { sequence: 6, eventId: 'rec-1' })));
  const failed = timeline.filter((entry) => !entry.hidden && entry.level === 'error');
  assert.equal(failed.length, 2);
  const comparison = failed.find((entry) => entryRole(entry) === 'comparison');
  const recovery = failed.find((entry) => entryRole(entry) === 'recovery');
  assert.ok(comparison);
  assert.ok(recovery);
  assert.equal(comparison.eventRefs?.length, 5);
  assert.equal(comparison.count, 5);
  assert.equal(recovery.eventRefs?.length, 1);
  assert.notEqual(errorFingerprint(comparison), errorFingerprint(recovery));
});

test('T05 R06: read aggregation separates call count from unique objects', () => {
  const timeline: TimelineEntry[] = [];
  for (const [index, path] of ['dir/a.md', 'dir/a.md', 'other/b.md'].entries()) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
      role: 'controller',
      tool: 'read',
      toolCallId: `c${index}`,
      params: { path },
    }, { sequence: index + 1, eventId: `read-${index}` })));
  }
  const flush = timeline.find((entry) => entry.hidden && entry.itemId === 'flush:controller');
  assert.ok(flush);
  assert.equal(flush.count, 3);
  const title = flushFoldTitle(flush);
  assert.match(title, /3次/);
  assert.match(title, /2项/);
});

test('T05 R07: identical delivery text still yields two turn boundaries', () => {
  const timeline: TimelineEntry[] = [];
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  for (const turn of [0, 1]) {
    appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
      status: 'completed',
      value: { type: 'send', message },
    }, { sequence: turn * 2 + 1, eventId: `send-${turn}` })));
    appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', {
      turnIndex: turn,
      clientMessageId: `client-${turn}`,
      text: message,
    }, { sequence: turn * 2 + 2, eventId: `input-${turn}` })));
  }
  const inputs = timeline.filter((entry) => entry.title.startsWith('Input to Target'));
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every((entry) => isTurnBoundary(entry)));
  assert.notEqual(inputs[0]?.deliveryId, inputs[1]?.deliveryId);
});

test('T05 R16: JSON assistant_visible stays readable as public narrate excerpt', () => {
  resetScrollbackLayoutCache();
  const json = '{\n  "status": "ok",\n  "items": [1, 2, 3],\n  "note": "用户需要的内容"\n}\nextra line five\nextra line six';
  const projected = projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery',
    text: json,
  }, { sequence: 1, eventId: 'json-1' }));
  const row = projected[0];
  assert.ok(row);
  assert.equal(row.kind, 'narrate');
  assert.match(row.detail ?? '', /用户需要的内容/);
  const theme = createTheme(40, false);
  const layout = layoutScrollback(theme, 40, [row], 0, 'zh', 'Codex', undefined, 0, 0, '00:00', true, -1, new Set());
  const painted = layout.lines.join('\n');
  assert.match(painted, /恢复 Agent/);
  assert.match(painted, /展开剩余/);
  assert.doesNotMatch(painted, /agent\.model_request/);
  const expanded = layoutScrollback(
    theme, 40, [row], 0, 'zh', 'Codex', undefined, 0, 0, '00:00', true, -1, new Set([excerptId(row)]),
  ).lines.join('\n');
  assert.match(expanded, /用户需要的内容/);
  assert.match(expanded, /收起/);
});

test('T05 wrap-then-3-line excerpt and resize keep excerpt identity', () => {
  const text = '中文一行足够长会被换行成多行内容，用来验证宽度变化后的摘录身份保持不变。'.repeat(4);
  const entry: TimelineEntry = {
    sequence: 1,
    occurredAt: timestamp,
    source: 'HARNESS',
    title: '摘要',
    detail: text,
    kind: 'narrate',
    role: 'recovery',
    eventRefs: [{ eventId: 'stable-1', sequence: 1 }],
  };
  const id = excerptId(entry);
  assert.equal(id, 'excerpt:ev:stable-1');
  // Width/content length change rewraps lines; identity stays tied to eventRefs.
  assert.equal(excerptId({ ...entry, detail: text.slice(0, 10) }), id);
  assert.equal(excerptId({ ...entry, detail: `${text}更多` }), id);
  const narrow = wrapBodyLine(text, 20);
  const wide = wrapBodyLine(text, 60);
  assert.ok(narrow.length > 3);
  assert.ok(wide.length >= 1);
  assert.ok(wide.length < narrow.length);
});

test('T05 voice/pane use structured role instead of title startsWith', () => {
  const projected = projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    toolCallId: 't1',
    params: { path: 'history/outline.tsv' },
  }, { sequence: 1, eventId: 'tool-1' }));
  const tool = projected[0];
  assert.ok(tool);
  assert.equal(entryRole(tool), 'controller');
  assert.equal(paneOf(tool), 'left');
  assert.equal(matchesFilter(tool, 'PRODUCT'), false);
  assert.equal(activityRoleLabel('recovery', 'X', 'zh'), '恢复 Agent');
  assert.equal(activityRoleLabel('candidate', 'Claude Code', 'zh'), 'Claude Code');
  assert.equal(activityRoleLabel('comparison', 'X', 'zh'), '对照Agent');
  assert.equal(activityRoleLabel('system', 'X', 'zh'), '系统');
  assert.equal(activityRoleLabel(undefined, '', 'zh'), '候选');
  assert.equal(entryRole({ sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: 'x' }), 'system');
  assert.equal(entryRole({ sequence: 1, occurredAt: timestamp, source: 'TARGET', title: 'x', lane: 'other' as never }), undefined);
});

test('T05 fold ids use first stable event identity, not turn index', () => {
  const entries: TimelineEntry[] = [];
  for (const turn of [0, 1, 2]) {
    appendTimelineEntries(entries, projectTimelineEvent(event('controller.decision', {
      status: 'completed',
      value: { type: 'send', message: `msg-${turn}` },
    }, { sequence: turn * 2 + 1, eventId: `send-${turn}` })));
    appendTimelineEntries(entries, projectTimelineEvent(event('agent.tool_completed', {
      role: 'controller', tool: 'read', toolCallId: `r${turn}`, params: { path: `a${turn}.md` },
    }, { sequence: turn * 2 + 2, eventId: `read-${turn}` })));
  }
  const folded = foldProcessEntries(entries, new Set());
  const fold = folded.find((entry) => entry.kind === 'fold' && entry.itemId?.startsWith('fold:turn:'));
  assert.ok(fold?.itemId);
  assert.match(fold.itemId, /fold:turn:/);
  assert.doesNotMatch(fold.itemId, /^fold:turn:\d+$/);
});

test('T05 detail model exposes public refs only and never model_request payload', () => {
  const entry: TimelineEntry = {
    sequence: 9,
    occurredAt: timestamp,
    source: 'HARNESS',
    title: '工具失败',
    detail: '路径不在可写范围',
    original: 'write_denied: outside the Host write policy',
    role: 'comparison',
    verb: 'error',
    activityStatus: 'failed',
    eventType: 'agent.tool_failed',
    truncated: true,
    linkUnknown: true,
    eventRefs: [
      { eventId: 'e1', sequence: 1 },
      { eventId: 'e2', sequence: 2 },
    ],
    level: 'error',
  };
  const model = activityDetailModel(entry, 'Claude Code', 'zh');
  assert.equal(model.roleLabel, '对照Agent');
  assert.equal(model.eventRefs.length, 2);
  assert.match(model.body, /路径不在可写范围/);
  assert.match(model.body, /write_denied/);
  assert.equal(model.truncated, true);
  assert.equal(model.linkUnknown, true);
  const painted = renderActivityDetail(createTheme(80, false), 80, model, 'zh').join('\n');
  assert.match(painted, /活动详情/);
  assert.match(painted, /打开原记录/);
  const privateRow: TimelineEntry = {
    ...entry,
    eventType: 'agent.model_request',
    detail: '{"messages":[{"role":"system","content":"SECRET"}]}',
  };
  assert.equal(activityDetailModel(privateRow, 'X', 'zh').body, privateRow.title);
  const help = helpLines('running', 'en').join('\n');
  assert.match(help, /Expand fold/);
  assert.match(helpLines('home', 'en').join('\n'), /\/command/);
  assert.match(helpLines(undefined, 'en').join('\n'), /\?/);
});

test('T05 working caption waits for visible activity', () => {
  const theme = createTheme(80, false);
  const live: TimelineEntry = {
    sequence: 1,
    occurredAt: timestamp,
    source: 'TARGET',
    title: 'working',
    kind: 'live',
    placeholder: true,
    itemId: 'now:target',
    role: 'candidate',
    verb: 'working',
    activityStatus: 'started',
    voice: 'candidate',
  };
  const lines = layoutScrollback(theme, 80, [live], 0, 'zh', 'Claude Code', 6, 0, 0, '00:12', true, -1).lines.join('\n');
  assert.match(lines, /等待新的可见活动/);
  assert.match(lines, /Claude Code/);
});

test('T05 captions status labels and excerpt identity fallbacks', () => {
  assert.equal(activityStatusLabel('started', 'zh'), '进行中');
  assert.equal(activityStatusLabel('updated', 'zh'), '更新中');
  assert.equal(activityStatusLabel('completed', 'zh'), '已完成');
  assert.equal(activityStatusLabel('failed', 'zh'), '失败');
  assert.equal(activityStatusLabel('cancelled', 'zh'), '已取消');
  assert.equal(activityStatusLabel(undefined, 'zh'), '');
  assert.match(toolCaption({
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '阅读',
    verb: 'read', object: 'a.md', activityStatus: 'completed',
  }, 'zh'), /阅读/);
  assert.match(toolCaption({
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '检查',
    verb: 'inspect', object: 'x', activityStatus: 'started',
  }, 'zh'), /检查/);
  assert.match(toolCaption({
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '写入',
    verb: 'write', object: 'y', activityStatus: 'completed',
  }, 'zh'), /写入/);
  assert.match(toolCaption({
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '运行',
    verb: 'run',
  }, 'zh'), /运行/);
  assert.equal(excerptId({ sequence: 9, occurredAt: timestamp, source: 'TARGET', title: 'x', itemId: 'now:target' }), 'excerpt:id:now:target');
  assert.equal(excerptId({ sequence: 9, occurredAt: timestamp, source: 'TARGET', title: 'x', correlationId: 'c1' }), 'excerpt:corr:c1');
  assert.equal(excerptId({ sequence: 9, occurredAt: timestamp, source: 'TARGET', title: 'x' }), 'excerpt:seq:9');
  const working = projectWorkingNow('recovery');
  assert.equal(working.extra.verb, 'working');
  assert.equal(captionPublicLive('working').title, 'working');
  assert.equal(captionPublicLive('read', 'leaf.md').detail, 'leaf.md');
  assert.equal(captionPublicLive('run').title, '运行');
  assert.equal(captionPublicLive('write', 'out.txt').title, '写入');
  assert.equal(captionPublicLive('custom').title, 'custom');
  assert.match(lastLiveVerb([{
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '阅读', kind: 'live', placeholder: true, lane: 'recovery',
  }]) ?? '', /阅读|read/);
});

test('T05 collapseAgentRows merges completed reads and keeps failures separate', () => {
  const first: TimelineEntry = {
    sequence: 1, occurredAt: timestamp, source: 'HARNESS', title: '阅读', detail: 'a.md',
    kind: 'investigate', role: 'recovery', lane: 'recovery', activityStatus: 'completed', object: 'a.md',
    eventRefs: [{ eventId: 'a', sequence: 1 }],
  };
  const second: TimelineEntry = {
    sequence: 2, occurredAt: timestamp, source: 'HARNESS', title: '阅读', detail: 'b.md',
    kind: 'investigate', role: 'recovery', lane: 'recovery', activityStatus: 'completed', object: 'b.md',
    eventRefs: [{ eventId: 'b', sequence: 2 }],
  };
  const timeline = [first];
  assert.equal(collapseAgentRows(timeline, second), true);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0]?.count, 2);
  assert.match(timeline[0]?.detail ?? '', /2次|×2|2项/);
  const failed: TimelineEntry = {
    sequence: 3, occurredAt: timestamp, source: 'HARNESS', title: '工具失败', detail: 'boom',
    kind: 'investigate', role: 'recovery', lane: 'recovery', level: 'error', activityStatus: 'failed',
  };
  assert.equal(collapseAgentRows(timeline, failed), false);
  const compactPrev: TimelineEntry = {
    sequence: 4, occurredAt: timestamp, source: 'HARNESS', title: 'compact', detail: 'tail ×1',
    kind: 'compact', role: 'recovery', lane: 'recovery', activityStatus: 'completed',
  };
  const compactNext: TimelineEntry = {
    sequence: 5, occurredAt: timestamp, source: 'HARNESS', title: 'compact', detail: 'tail ×1',
    kind: 'compact', role: 'recovery', lane: 'recovery', activityStatus: 'completed',
  };
  const compactTimeline = [compactPrev];
  assert.equal(collapseAgentRows(compactTimeline, compactNext), true);
  assert.match(compactTimeline[0]?.detail ?? '', /tail ×2/);
});

test('T05 projectAgentTool maps failure fingerprints and shell verbs', () => {
  const denied = projectAgentTool({ role: 'comparison', tool: 'write', message: 'write_denied: outside the Host write policy', params: { path: 'x/y.md' } }, 'agent.tool_failed');
  assert.equal(denied.title, '写入失败');
  const budget = projectAgentTool({ role: 'recovery', tool: 'edit', message: 'destructive change budget of 16 exceeded' }, 'agent.tool_failed');
  assert.match(budget.detail ?? '', /destructive change budget/);
  const toolBudget = projectAgentTool({ role: 'recovery', tool: 'read', message: 'tool-call budget of 32 exceeded' }, 'agent.tool_failed');
  assert.match(toolBudget.detail ?? '', /investigation budget/);
  const git = projectAgentTool({ role: 'recovery', tool: 'shell_exec', message: 'fatal: not a git repository' }, 'agent.tool_failed');
  assert.match(git.detail ?? '', /不是 Git 仓库/);
  const generic = projectAgentTool({ role: 'recovery', tool: 'read', message: 'boom: exploded' }, 'agent.tool_failed');
  assert.equal(generic.title, '工具失败');
  const shell = projectAgentTool({
    role: 'comparison',
    tool: 'shell_exec',
    toolCallId: 's1',
    params: { command: 'pwsh -Command "Get-ChildItem \'C:\\\\repo\\\\src\'"' },
  }, 'agent.tool_called');
  assert.match(shell.title, /检查|Get-ChildItem|阅读/);
  const completedGit = projectAgentTool({
    role: 'recovery',
    tool: 'shell_exec',
    content: 'fatal: not a git repository',
    params: { command: 'git status' },
  }, 'agent.tool_completed');
  assert.equal(completedGit.detail, '不是 Git 仓库');
  const mutate = projectAgentTool({
    role: 'comparison',
    tool: 'shell_exec',
    toolCallId: 'w1',
    params: { command: 'Copy-Item -Path a -Destination C:\\\\candidate\\\\out' },
  }, 'agent.tool_called');
  assert.equal(mutate.extra.level, 'warning');
});

test('T05 scrollback paints role headers errors and legacy voices', () => {
  resetScrollbackLayoutCache();
  const theme = createTheme(60, false);
  const message: TimelineEntry = {
    sequence: 1, occurredAt: timestamp, source: 'TARGET', title: 'Visible response',
    detail: 'line1\nline2\nline3\nline4\nline5', role: 'candidate', voice: 'candidate',
  };
  const err: TimelineEntry = {
    sequence: 2, occurredAt: timestamp, source: 'HARNESS', title: '工具失败', detail: '路径不在可写范围',
    level: 'error', role: 'comparison', verb: 'error', activityStatus: 'failed', count: 3,
  };
  const deliver: TimelineEntry = {
    sequence: 3, occurredAt: timestamp, source: 'HARNESS', title: 'DONE · recovered',
    detail: 'ok', kind: 'deliver', role: 'recovery', lane: 'recovery',
  };
  const leaf: TimelineEntry = {
    sequence: 4, occurredAt: timestamp, source: 'HARNESS', title: '⎿ outline.tsv', lane: 'recovery',
  };
  const fold: TimelineEntry = {
    sequence: 5, occurredAt: timestamp, source: 'CONTROLLER', title: '▸ 阅读证据 · 2', kind: 'fold',
    itemId: 'fold:think:seq:1', role: 'controller', lane: 'controller',
  };
  const thinking: TimelineEntry = {
    sequence: 6, occurredAt: timestamp, source: 'TARGET', title: '思考', detail: '…', kind: 'thinking',
    voice: 'candidate',
  };
  const input: TimelineEntry = {
    sequence: 7, occurredAt: timestamp, source: 'CONTROLLER', title: 'Input to Target',
    detail: 'please fix', verb: 'send', role: 'controller',
  };
  const painted = layoutScrollback(
    theme, 60, [message, err, deliver, leaf, fold, thinking, input], 0, 'zh', 'Codex',
    undefined, 0, 0, '00:01', true, -1, new Set(),
  ).lines.join('\n');
  assert.match(painted, /Codex/);
  assert.match(painted, /展开剩余|line1/);
  assert.match(painted, /失败|路径不在可写范围/);
  assert.match(painted, /DONE · recovered|恢复/);
  assert.equal(matchesFilter(message, 'PRODUCT'), true);
  assert.equal(matchesFilter(input, 'INPUT'), true);
  assert.equal(matchesFilter({
    sequence: 8, occurredAt: timestamp, source: 'HARNESS', title: 'Working…',
  }, 'ALL'), false);
  assert.equal(matchesFilter({
    sequence: 9, occurredAt: timestamp, source: 'HARNESS', title: '对照完成', lane: 'comparison', kind: 'narrate', role: 'comparison',
  }, 'ALL'), true);
});
