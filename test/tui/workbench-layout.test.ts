import test from 'node:test';
import assert from 'node:assert/strict';
import { getLayoutNode } from '@earendil-works/pi-tui/dist/layout-node.js';
import { measureWorkbenchGeometry, renderWorkbench, Workbench, type WorkbenchView } from '../../src/tui/workbench.js';

test('layout root hides the normal workbench below the minimum viewport height', () => {
  const view: WorkbenchView = {
    page: 'home', cwd: 'C:\\src', hasApiConfig: true, hasTaskCase: false, message: '',
    home: { taskCase: undefined, recentExperiment: undefined, hasApiConfig: true, hasUsableAuth: true, composer: '', showSuggestions: false },
  };
  let height = 7;
  const root = new Workbench(() => view, () => ({ height })).createLayoutRoot();
  const node = getLayoutNode(root);
  assert.equal(node?.type, 'vstack');
  if (!node || node.type !== 'vstack') return;
  const shortEntries = node.entries.filter((entry) => entry.visible?.({ width: 120, height }) ?? true);
  assert.equal(shortEntries.length, 1);
  assert.match(shortEntries[0]!.component.render(120).join('\n'), /Terminal is too short|终端太矮/);
  height = 30;
  assert.equal(node.entries.filter((entry) => entry.visible?.({ width: 120, height }) ?? true).length, 7);
});

test('short cancelling workbench keeps live status when body budget is under four', () => {
  const live = {
    sequence: 99,
    occurredAt: '2026-08-11T00:10:00.000Z',
    source: 'TARGET' as const,
    title: 'working',
    kind: 'live' as const,
    placeholder: true as const,
    itemId: 'now:target',
    voice: 'candidate' as const,
  };
  const entries = [
    ...Array.from({ length: 12 }, (_, index) => ({
      sequence: index + 1,
      occurredAt: '2026-08-11T00:10:00.000Z',
      source: 'TARGET' as const,
      title: `Event ${index + 1}`,
      detail: 'detail',
      voice: 'candidate' as const,
    })),
    live,
  ];
  const view = {
    page: 'running' as const,
    cwd: 'C:\\src',
    hasApiConfig: true,
    hasUsableAuth: true,
    hasTaskCase: true,
    message: 'Cancellation requested.',
    cancelling: true,
    productLabel: 'Codex',
    locale: 'zh' as const,
    running: {
      entries,
      selected: entries.length - 1,
      filter: 'ALL' as const,
      following: true,
      cancelling: true,
      currentState: 'awaiting_target' as const,
      elapsed: '03:00',
      turns: { used: 1 },
      calls: { used: 1 },
      productLabel: 'Codex',
      candidateModel: 'gpt-5.6-luna',
      taskTitle: 'Fix the bug.',
      locale: 'zh' as const,
      tick: Date.parse('2026-08-11T00:13:00.000Z'),
      runStartedAt: Date.parse('2026-08-11T00:10:00.000Z'),
      lastRuntimeEventAt: '2026-08-11T00:10:00.000Z',
    },
  };
  const geometry = measureWorkbenchGeometry(view, 120, 8);
  assert.ok(geometry.body.height < 4, `expected tight body, got ${geometry.body.height}`);
  const lines = renderWorkbench(view, 120, 8);
  assert.ok(lines.length <= 8, `expected <= 8 lines, got ${lines.length}`);
  const text = lines.join('\n');
  assert.match(text, /Codex · (working|等待新的可见活动)|working/);
  assert.match(text, /03:00/);
});
