import test from 'node:test';
import assert from 'node:assert/strict';
import type { EventEnvelope } from '../../src/core/schema.js';
import {
  activityRoleLabel,
  entryRole,
  errorFingerprint,
  excerptId,
  isTurnBoundary,
} from '../../src/tui/agent-activity.js';
import { foldProcessEntries, paneOf } from '../../src/tui/fold-process.js';
import { activityDetailModel, renderActivityDetail } from '../../src/tui/overlays.js';
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
  assert.equal(comparison?.eventRefs?.length, 5);
  assert.equal(comparison?.count, 5);
  assert.equal(recovery?.eventRefs?.length, 1);
  assert.notEqual(errorFingerprint(comparison!), errorFingerprint(recovery!));
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
  const [row] = projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery',
    text: json,
  }, { sequence: 1, eventId: 'json-1' }));
  assert.equal(row?.kind, 'narrate');
  assert.match(row?.detail ?? '', /用户需要的内容/);
  const theme = createTheme(40, false);
  const layout = layoutScrollback(theme, 40, [row!], 0, 'zh', 'Codex', undefined, 0, 0, '00:00', true, -1, new Set());
  const painted = layout.lines.join('\n');
  assert.match(painted, /恢复 Agent/);
  assert.match(painted, /展开剩余/);
  assert.doesNotMatch(painted, /agent\.model_request/);
  const expanded = layoutScrollback(
    theme, 40, [row!], 0, 'zh', 'Codex', undefined, 0, 0, '00:00', true, -1, new Set([excerptId(row!)]),
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
  const tool = projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    toolCallId: 't1',
    params: { path: 'history/outline.tsv' },
  }, { sequence: 1, eventId: 'tool-1' }))[0]!;
  assert.equal(entryRole(tool), 'controller');
  assert.equal(paneOf(tool), 'left');
  assert.equal(matchesFilter(tool, 'PRODUCT'), false);
  assert.equal(activityRoleLabel('recovery', 'X', 'zh'), '恢复 Agent');
  assert.equal(activityRoleLabel('candidate', 'Claude Code', 'zh'), 'Claude Code');
  assert.equal(activityRoleLabel('comparison', 'X', 'zh'), '对照Agent');
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
  assert.match(fold!.itemId!, /fold:turn:/);
  assert.doesNotMatch(fold!.itemId!, /^fold:turn:\d+$/);
});

test('T05 detail model exposes public refs only and never model_request payload', () => {
  const entry: TimelineEntry = {
    sequence: 9,
    occurredAt: timestamp,
    source: 'HARNESS',
    title: '工具失败',
    detail: '路径不在可写范围',
    role: 'comparison',
    verb: 'error',
    activityStatus: 'failed',
    eventType: 'agent.tool_failed',
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
  const painted = renderActivityDetail(createTheme(80, false), 80, model, 'zh').join('\n');
  assert.match(painted, /活动详情/);
  assert.match(painted, /打开原记录/);
  const privateRow: TimelineEntry = {
    ...entry,
    eventType: 'agent.model_request',
    detail: '{"messages":[{"role":"system","content":"SECRET"}]}',
  };
  assert.equal(activityDetailModel(privateRow, 'X', 'zh').body, privateRow.title);
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
