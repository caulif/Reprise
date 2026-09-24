import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLocalHistory } from '../../src/tui/local-history.js';
import { createActivityIndex } from '../../src/tui/activity-index.js';
import { IntakeTui_historyInput, type HistoryPanel } from '../../src/tui/intake-tui-history.js';
import { renderHistoryDetail } from '../../src/tui/pages/history.js';
import { createTheme } from '../../src/tui/theme.js';
import { waitFor } from '../codex-intake-support.js';

test('clicking damaged history opens its format diagnosis without a readable event log', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-history-click-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const missing = join(dataDir, 'experiments', 'missing');
  const invalid = join(dataDir, 'experiments', 'invalid');
  await Promise.all([mkdir(missing, { recursive: true }), mkdir(invalid, { recursive: true })]);
  await writeFile(join(invalid, 'experiment.json'), '{broken json');
  await writeFile(join(invalid, 'events.jsonl'), '{broken event}\n');
  const history = await readLocalHistory(dataDir);

  for (const [experimentId, diagnosis] of [
    ['missing', '缺少实验元数据'],
    ['invalid', '实验元数据无法读取或格式无效'],
  ] as const) {
    const item = history.experiments.find((entry) => entry.experimentId === experimentId);
    assert.ok(item);
    const panel = panelFor(dataDir, item);
    IntakeTui_historyInput.call(panel, '\r');
    await waitFor(() => panel.page === 'history-detail');
    assert.equal(panel.historyDetail, item);
    assert.deepEqual(panel.timeline, []);
    assert.match(renderHistoryDetail(createTheme(80, false), 80, panel.historyDetail, 'zh').join('\n'), new RegExp(diagnosis));
  }
});

test('a regular history entry still reports a missing event log', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-history-click-regular-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const panel = panelFor(dataDir, {
    experimentId: 'regular', taskCaseId: 'case', path: join(dataDir, 'experiments', 'regular'), sizeBytes: 0,
  });
  IntakeTui_historyInput.call(panel, '\r');
  await waitFor(() => panel.page === 'error');
  assert.equal(panel.historyDetail, undefined);
});

test('a damaged history entry reports event log I/O errors', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-history-click-io-'));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const experiment = join(dataDir, 'experiments', 'damaged');
  await mkdir(join(experiment, 'events.jsonl'), { recursive: true });
  const history = await readLocalHistory(dataDir);
  const item = history.experiments[0];
  assert.ok(item);
  assert.equal(item.formatError, 'missing_metadata');
  const panel = panelFor(dataDir, item);
  IntakeTui_historyInput.call(panel, '\r');
  await waitFor(() => panel.page === 'error');
  assert.equal(panel.historyDetail, undefined);
});

function panelFor(dataDir: string, item: HistoryPanel['historyExperiments'][number]): HistoryPanel {
  const panel = {
    dataDir, locale: 'zh', generation: 0, page: 'history', message: '',
    historyTab: 'runs', historySelected: 0, historyCases: [], historyExperiments: [item],
    historyTotalBytes: 0, invalidHistoryCaseCount: 0, historyDetail: undefined,
    recentExperiment: undefined, timeline: [], activityIndex: createActivityIndex(),
    timelineRevision: 0, timelineSelected: 0, timelineFollowing: false,
    timelineReadOffset: 0, processExpanded: false,
    historyItems() { return this.historyExperiments; },
    beginNavigation() { return ++this.generation; },
    render() {},
    showError() { this.page = 'error'; },
    visibleTimeline() { return this.timeline; },
  };
  return panel as HistoryPanel;
}
