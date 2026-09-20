import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { isStructuredEnvelope, visibleAssistantText } from '../../src/infrastructure/agent/assistant-visible.js';
import { matchesFilter, renderScrollback, layoutScrollback, hitAtBodyRow } from '../../src/tui/scrollback.js';
import { renderTimeline } from '../../src/tui/pages/run.js';
import { createTheme } from '../../src/tui/theme.js';
import { foldProcessEntries, paneOf, projectAssistantVisible, splitRunEntries } from '../../src/tui/fold-process.js';
import { appendTimelineEntries, filterTraceForSurface, projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';
import type { EventEnvelope } from '../../src/core/schema.js';

const timestamp = '2026-09-02T12:00:00.000Z';

function event(type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: 'event-1',
    occurredAt: timestamp,
    type,
    payload,
    checksum: '0'.repeat(64),
  };
}

test('visible assistant text drops JSON envelopes and thinking-only content', () => {
  assert.equal(visibleAssistantText([{ type: 'text', text: '{"status":"recovered"}' }]), '');
  assert.equal(isStructuredEnvelope('{"type":"send","message":"hi"}'), true);
  assert.equal(visibleAssistantText([{ type: 'thinking', text: 'secret' }]), '');
  assert.match(visibleAssistantText([{ type: 'text', text: '先看隔离副本是不是仓库。' }]) ?? '', /隔离副本/);
  assert.equal(visibleAssistantText([{ type: 'text', text: '<think>hidden</think>{"type":"done","reason":"satisfied"}' }]), '');
});

test('assistant_visible is a narrate row on the main column', () => {
  const [row] = projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery',
    text: '先看隔离副本是不是仓库。',
    turn: 1,
  }));
  assert.equal(row?.kind, 'narrate');
  assert.match(row?.title ?? '', /隔离副本/);
  assert.equal(projectTimelineEvent(event('agent.message_appended', { role: 'recovery', byteLength: 12 })).length, 0);
});

test('right pane is product session, not Controller tools, and user text is input voice', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    params: { path: 'history/outline.tsv' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: 'Run the focused test.' },
  })));
  const { left, right } = splitRunEntries(timeline);
  assert.ok(left.some((entry) => entry.lane === 'controller' || entry.title.startsWith('Input to Target')));
  assert.equal(right.some((entry) => entry.title.includes('outline') && entry.lane === 'controller' || entry.lane === 'controller' && entry.title.startsWith('Controller') && !entry.title.startsWith('Decision')), false);
  const input = right.find((entry) => entry.title.startsWith('Input to Target'))
    ?? left.find((entry) => entry.title.startsWith('Input to Target'));
  assert.ok(input);
  assert.equal(matchesFilter(input, 'INPUT'), true);
  assert.equal(matchesFilter(input, 'PRODUCT'), false);
  assert.equal(paneOf(input), 'both');
});

test('candidate canvas keeps Controller tools and delivered input on one column', () => {
  const theme = createTheme(120, false);
  const entries: TimelineEntry[] = [];
  appendTimelineEntries(entries, projectTimelineEvent(event('agent.tool_called', {
    role: 'controller',
    tool: 'read',
    params: { path: 'history/outline.tsv' },
  })));
  appendTimelineEntries(entries, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: 'Please run the tests.' },
  })));
  const text = renderTimeline(theme, 120, {
    entries,
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: 'awaiting_controller', elapsed: '00:12', turns: { used: 1 }, calls: { used: 1 },
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.match(text, /Please run the tests|请/);
  const projected = projectAssistantVisible({ role: 'controller', text: '先看候选有没有跑测试。' });
  assert.equal(projected.extra.lane, 'controller');
});

test('scrollback does not reprint the same delivered sentence', () => {
  const message = '请先查看当前目录中的 Excel 数据和参考 PPT。';
  const theme = createTheme(80, false);
  const painted = renderScrollback(theme, 80, [
    { sequence: 1, occurredAt: timestamp, source: 'CONTROLLER', title: 'Input to Target', detail: message },
    { sequence: 2, occurredAt: timestamp, source: 'TARGET', title: `Prompt · ${message}`, detail: message },
  ], 0, 'zh', 'Claude Code').join('\n');
  assert.equal(painted.split(message).length - 1, 1);
});

test('recovery keeps one live row then flushes tools on the next sentence', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '先看隔离副本是不是仓库。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_called', {
    role: 'recovery', tool: 'read', params: { path: 'INDEX.md' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'INDEX.md' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'session.json' },
  })));
  const live = timeline.filter((entry) => !entry.hidden && entry.kind === 'live');
  assert.equal(live.length, 1);
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '接着写 recovery.md。',
  })));
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.ok(visible.some((entry) => entry.title.includes('▸ 阅读证据')));
  assert.equal(visible.some((entry) => /compact/.test(entry.title)), false);
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.context_compacted', {
    role: 'recovery', retainedCount: 75,
  })));
  assert.equal(timeline.filter((entry) => !entry.hidden).some((entry) => /compact/.test(entry.title)), false);
});

test('recovery.completed uses the user-facing recovery word', () => {
  const [row] = projectTimelineEvent(event('recovery.completed', { status: 'completed', finalStatus: '部分恢复' }));
  assert.equal(row?.title, '部分恢复');
  const recovered = projectTimelineEvent(event('recovery.completed', { status: 'recovered' }))[0];
  assert.equal(recovered?.title, '已恢复');
  const blocked = projectTimelineEvent(event('recovery.completed', {
    status: 'completed',
    value: { status: 'blocked', summary: 'Required input is missing from source.' },
  }))[0];
  assert.equal(blocked?.title, '缺关键输入，补上后可重跑');
  assert.notEqual(blocked?.level, 'error');
  assert.equal(blocked?.detail, 'Required input is missing from source.');
});

test('controller send is an Input card without Decision: SEND', () => {
  const rows = projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', intent: 'verify', message: '在吗', rationale: 'probe' },
  })).filter((entry) => !entry.hidden);
  assert.equal(rows.some((entry) => entry.title.startsWith('Input to Target')), true);
  assert.equal(rows.some((entry) => entry.title.includes('Decision: SEND')), false);
  const done = projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'done', reason: 'no_further_value', rationale: '候选只回了开场寒暄。' },
  })).filter((entry) => !entry.hidden);
  assert.match(done[0]?.title ?? '', /没有继续的价值/);
  assert.doesNotMatch(done[0]?.title ?? '', /no_further_value/);
  assert.match(done[0]?.detail ?? '', /寒暄/);
});

test('comparison completion shows headline not limitation codes', () => {
  const [row] = projectTimelineEvent(event('comparison.completed', {
    status: 'completed',
    value: { status: 'completed', headline: '候选只寒暄，没有做出两页 PPT。', limitationCodes: ['isolation'], reportPath: 'report.html' },
  }));
  assert.equal(row?.title, '对照完成');
  assert.match(row?.detail ?? '', /寒暄/);
  assert.doesNotMatch(row?.title ?? '', /report.html/);
});

test('shell_exec live title is a single verb', () => {
  const [row] = projectTimelineEvent(event('agent.tool_called', {
    role: 'recovery',
    tool: 'shell_exec',
    params: { command: 'Get-ChildItem -LiteralPath .' },
  }));
  assert.doesNotMatch(row?.title ?? '', /shell_exec shell_exec/);
  assert.doesNotMatch(`${row?.title ?? ''} ${row?.detail ?? ''}`, /shell_exec shell_exec/);
});

test('unsettled candidate keeps a working row then visible response replaces it', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', {
    turnIndex: 0, text: '在吗',
  })));
  const live = timeline.filter((entry) => !entry.hidden && entry.kind === 'live');
  assert.equal(live.length, 1);
  assert.match(live[0]?.title ?? '', /working/);
  appendTimelineEntries(timeline, projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 0, status: 'completed', observedAt: timestamp, assistantText: '你好，需要什么帮助？',
  })));
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.ok(visible.some((entry) => entry.title === 'Visible response'));
  assert.equal(visible.filter((entry) => entry.kind === 'live').length, 0);
});

test('comparison narrate stays on the compare surface without Input cards', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: '在吗' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'comparison', text: '先核对隔离副本有没有两页 PPT。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_called', {
    role: 'comparison', tool: 'read', params: { path: 'report.html' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'comparison', tool: 'read', params: { path: 'INDEX.md' },
  })));
  const live = timeline.filter((entry) => !entry.hidden && entry.kind === 'live' && entry.lane === 'comparison');
  assert.equal(live.length, 1);
  const compare = filterTraceForSurface(timeline.filter((entry) => !entry.hidden), 'compare');
  assert.ok(compare.some((entry) => entry.kind === 'narrate' && /两页 PPT/.test(entry.title)));
  assert.equal(compare.some((entry) => entry.title.startsWith('Input to Target')), false);
  assert.equal(compare.some((entry) => entry.title.includes('Decision: SEND')), false);
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: [...compare],
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: 'finished', elapsed: '01:00', turns: { used: 4 }, calls: { used: 2 },
    preparePhase: 'compare',
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.doesNotMatch(painted, /第 4 轮/);
  assert.doesNotMatch(painted, /inspect artifact/);
  assert.match(painted, /对照Agent/);
});

test('candidate surface hides recovery blocks, compact, and session UUID', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('recovery.completed', {
    status: 'completed', finalStatus: '已恢复',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.context_compacted', {
    role: 'controller', retainedCount: 12,
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('candidate.session_bound', {
    sessionId: '0194abcd-1234-5678-90ab-cdef01234567', productId: 'codex',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('controller.decision', {
    status: 'completed',
    value: { type: 'send', message: '继续' },
  })));
  const candidate = filterTraceForSurface(timeline.filter((entry) => !entry.hidden), 'candidate');
  assert.equal(candidate.some((entry) => entry.title === '已恢复'), false);
  assert.equal(candidate.some((entry) => /compact/.test(entry.title)), false);
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: [...candidate],
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: 'awaiting_controller', elapsed: '00:12', turns: { used: 1 }, calls: { used: 1 },
    productLabel: 'Codex',
    locale: 'zh',
  }).join('\n');
  assert.doesNotMatch(painted, /0194abcd-1234-5678-90ab-cdef01234567/);
  assert.doesNotMatch(painted, /仍在等待本轮结束/);
  assert.doesNotMatch(painted, /compact tail/);
});

test('mixed assistant prose peels a trailing send envelope', () => {
  assert.match(visibleAssistantText([{
    type: 'text',
    text: '先投递探测。\n{"type":"send","message":"在吗"}',
  }]) ?? '', /先投递探测/);
  assert.doesNotMatch(visibleAssistantText([{
    type: 'text',
    text: '先投递探测。\n{"type":"send","message":"在吗"}',
  }]) ?? '', /"type":"send"/);
});

test('candidate live keeps the leaf after tool_finished and flushes on user view', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: '在吗' })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_started', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
    live: { schemaVersion: 1, verb: 'read', leaf: 'foo.md' },
  })));
  const during = timeline.filter((entry) => !entry.hidden && entry.kind === 'live');
  assert.match(during[0]?.title ?? '', /阅读/);
  assert.equal(during[0]?.detail, 'foo.md');
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.tool_finished', {
    schemaVersion: 1, sessionId: 's', evidenceRefs: [],
  })));
  const after = timeline.filter((entry) => !entry.hidden && entry.kind === 'live');
  assert.equal(after[0]?.detail, 'foo.md');
  appendTimelineEntries(timeline, projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 0, status: 'completed', observedAt: timestamp, assistantText: '看过了。',
  })));
  const visible = timeline.filter((entry) => !entry.hidden);
  assert.ok(visible.some((entry) => entry.title === 'Visible response'));
  assert.ok(visible.some((entry) => entry.kind === 'fold' && /阅读证据|写入/.test(entry.title)));
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: visible,
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: 'awaiting_controller', elapsed: '03:21', turns: { used: 1 }, calls: { used: 1 },
    productLabel: 'Claude Code',
    locale: 'zh',
  }).join('\n');
  assert.doesNotMatch(painted, /Candidate · working/);
  assert.doesNotMatch(painted, /"type":"send"/);
  assert.doesNotMatch(painted, /\[o\]/);
  assert.doesNotMatch(painted, /write_denied/);
});

test('candidate working row without live includes elapsed', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', { turnIndex: 0, text: '在吗' })));
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: timeline.filter((entry) => !entry.hidden),
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: 'awaiting_target', elapsed: '03:21', turns: { used: 1 }, calls: { used: 1 },
    productLabel: 'Claude Code',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /working/);
  assert.match(painted, /03:21/);
  assert.doesNotMatch(painted, /working · 03:21/);
  assert.doesNotMatch(painted, /Candidate · working/);
});

test('Host write_denied english stays off the default title', () => {
  const [row] = projectTimelineEvent(event('agent.tool_failed', {
    role: 'controller',
    tool: 'write',
    message: 'write_denied: path is outside the Host write policy.',
  }));
  assert.equal(row?.title, '写入失败');
  assert.doesNotMatch(row?.title ?? '', /write_denied/);
  assert.doesNotMatch(`${row?.title ?? ''} ${row?.detail ?? ''}`, /outside the Host write policy/);
});

test('expanded fold lists leaf names in the tree', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '先读索引。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'secret-leaf.md' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '接着写报告。',
  })));
  const fold = timeline.find((entry) => !entry.hidden && entry.kind === 'fold');
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: timeline.filter((entry) => !entry.hidden),
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    expandedFolds: fold?.itemId ? [fold.itemId] : [],
    runPhase: 'recovery',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /secret-leaf\.md/);
});

test('unexpanded fold does not list leaf names and visible_output stays off the column', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '先读索引。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'secret-leaf.md' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '接着写报告。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('runtime.visible_output', {
    message: { content: [{ type: 'text', text: 'PRIVATE_VISIBLE_OUTPUT' }] },
  })));
  const painted = renderTimeline(createTheme(120, false), 120, {
    entries: timeline.filter((entry) => !entry.hidden),
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    runPhase: 'recovery',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /▸ 阅读证据/);
  assert.doesNotMatch(painted, /secret-leaf\.md/);
  assert.doesNotMatch(painted, /PRIVATE_VISIBLE_OUTPUT/);
});

test('clicking a fold hit writes that itemId into expandedFolds', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '先读索引。',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.tool_completed', {
    role: 'recovery', tool: 'read', params: { path: 'secret-leaf.md' },
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('agent.assistant_visible', {
    role: 'recovery', text: '接着写报告。',
  })));
  const visible = timeline.filter((entry) => !entry.hidden);
  const folded = foldProcessEntries(visible, new Set());
  const theme = createTheme(120, false);
  const layout = layoutScrollback(theme, 120, folded, 0, 'zh', 'Codex', undefined, 0, 0, '00:08');
  const foldHit = layout.hits.find((hit) => hit.fold && hit.itemId);
  assert.ok(foldHit?.itemId);
  const clicked = hitAtBodyRow(layout.hits, foldHit.y);
  assert.equal(clicked?.itemId, foldHit.itemId);
  assert.ok(clicked.itemId);
  const expandedFolds = [clicked.itemId];
  const painted = renderTimeline(theme, 120, {
    entries: visible,
    selected: 0, filter: 'ALL', following: true, cancelUi: 'idle' as const,
    currentState: undefined, elapsed: '00:08', turns: { used: 0 }, calls: { used: 0 },
    expandedFolds,
    runPhase: 'recovery',
    locale: 'zh',
  }).join('\n');
  assert.match(painted, /secret-leaf\.md/);
});

test('timeline projection never reads message.content', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../src/tui/timeline.ts'), 'utf8');
  assert.doesNotMatch(source, /message\.content/);
});

test('scrollback gutter keeps body default, mutes folds, and pins the clock', () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  try {
    const colored = createTheme(100, true);
    assert.notEqual(colored.style.danger('x'), colored.style.target('x'));
    const stamp = timestamp;
    const say: TimelineEntry = {
      sequence: 1, occurredAt: stamp, source: 'HARNESS', kind: 'narrate', lane: 'recovery', title: '先看隔离副本。',
    };
    const fold: TimelineEntry = {
      sequence: 2, occurredAt: stamp, source: 'HARNESS', kind: 'fold', lane: 'recovery', title: '▸ 阅读证据 · 12', itemId: 'fold:1',
    };
    const reply: TimelineEntry = {
      sequence: 3, occurredAt: stamp, source: 'TARGET', title: 'Visible response', detail: '长回复像告警墙', voice: 'candidate',
    };
    const now: TimelineEntry = {
      sequence: 4, occurredAt: stamp, source: 'TARGET', kind: 'live', title: 'working', itemId: 'now:target', placeholder: true, voice: 'candidate',
    };
    const painted = renderScrollback(colored, 80, [say, fold, reply, now], 3, 'zh', 'Claude Code', undefined, 0, 0, '25:10', true);
    const body = painted.join('\n');
    assert.match(body, /先看隔离副本/);
    assert.doesNotMatch(body, /\u001b\[38;2;167;217;190m先看|\u001b\[36m先看/);
    assert.doesNotMatch(body, /\u001b\[38;2;238;176;155m长回复|\u001b\[33m长回复/);
    assert.match(body, /\u001b\[90m[^\n]*▸ 阅读证据|\u001b\[38;2;74;92;86m/);
    const status = painted.at(-1) ?? '';
    const plain = painted.map((line) => line.replace(/\u001b\[[0-9;]*m/g, '')).join('\n');
    assert.match(status.replace(/\u001b\[[0-9;]*m/g, ''), /25:10\s*$/);
    assert.doesNotMatch(status.replace(/\u001b\[[0-9;]*m/g, ''), /working · 25:10/);
    assert.equal([...plain.matchAll(/working/g)].length, 1);
    const behind = renderScrollback(colored, 80, [say, fold], 0, 'zh', 'Codex', undefined, 0, 0, '00:08', false).join('\n');
    assert.match(behind, /▼|↓/);
    assert.match(behind, /新 1|1 new/);
    const host = createTheme(80, true, true);
    assert.doesNotMatch(host.style.fillCanvas('hello'), /48;2;12;16;18/);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
});

test('result surface hides live product working now-row after terminal outcome', () => {
  const timeline: TimelineEntry[] = [];
  appendTimelineEntries(timeline, projectTimelineEvent(event('input.submitted', {
    turnIndex: 0, text: '在吗',
  })));
  appendTimelineEntries(timeline, projectTimelineEvent(event('candidate.user_view_persisted', {
    turnIndex: 0, status: 'completed', observedAt: timestamp, assistantText: '你好',
  })));
  // Re-introduce a stale live now-row the way a late tool event can leave one visible.
  timeline.push({
    sequence: 99,
    occurredAt: timestamp,
    source: 'TARGET',
    title: 'working',
    kind: 'live',
    placeholder: true,
    itemId: 'now:target',
    voice: 'candidate',
  });
  const onResult = filterTraceForSurface(timeline.filter((entry) => !entry.hidden), 'result');
  assert.equal(onResult.some((entry) => entry.itemId?.startsWith('now:')), false);
  const painted = layoutScrollback(
    createTheme(100, false),
    100,
    onResult,
    0,
    'zh',
    'Claude Code',
    undefined,
    0,
    0,
    '12:00',
    true,
  ).lines.join('\n');
  assert.doesNotMatch(painted, /Claude Code · working/);
  assert.doesNotMatch(painted, /working/);
});
