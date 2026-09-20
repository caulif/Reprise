import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { ControllerHandle } from '../../src/tui/controller-input.js';
import { hitFileLink } from '../../src/tui/format.js';
import { homeHints } from '../../src/tui/pages/home.js';
import { applyResultPointer, yieldPointerToApp } from '../../src/tui/pointer-dispatch.js';
import { resultPointerAction, renderResult, renderResultWithHits, resolveResultLinkAction } from '../../src/tui/pages/result.js';
import type { ResultPathLinks } from '../../src/application/result-paths.js';
import type { ResultAction } from '../../src/tui/page-input.js';
import { keepSelectedVisible } from '../../src/tui/scrollback.js';
import { createTheme } from '../../src/tui/theme.js';
import { workbenchBodyOrigin, type WorkbenchView } from '../../src/tui/workbench.js';

function visibleSpan(line: string, needle: string): { x0: number; x1: number } | undefined {
  const plain = stripTerminalSequences(line);
  const index = plain.indexOf(needle);
  if (index < 0) return undefined;
  const x0 = visibleWidth(plain.slice(0, index)) + 1;
  return { x0, x1: x0 + visibleWidth(needle) - 1 };
}

function pointerAt(
  lines: readonly string[],
  row: number,
  col: number,
  locale: 'en' | 'zh',
  pathLinks: ResultPathLinks,
  rowHits: ReadonlyMap<number, readonly { action: ResultAction; x0: number; x1: number }[]>,
): ResultAction | undefined {
  return resultPointerAction(lines, row, col, locale, pathLinks, rowHits);
}

test('keepSelectedVisible only changes offset when the selection would leave the window', () => {
  assert.equal(keepSelectedVisible(0, 0, 40, 10), 0);
  assert.equal(keepSelectedVisible(5, 0, 40, 10), 0);
  assert.equal(keepSelectedVisible(12, -12, 40, 10), 3 - 12);
});

test('home idle footer does not repeat Enter', () => {
  const hints = homeHints('en', {
    taskCase: undefined,
    recentExperiment: { experimentId: 'e1', taskCaseId: 'c1', path: 'C:/e', sizeBytes: 1 },
    hasApiConfig: true,
    composer: '',
    showSuggestions: false,
  });
  assert.deepEqual(hints.map(([key]) => key), ['/', 'Ctrl+C']);
});

test('result pointer hits OSC 8 short labels and ignores blank rows', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const theme = createTheme(120, false);
  const pathLinks = {
    report: 'C:\\exp\\report.html',
    trace: 'C:\\exp\\runs\\run-1',
    replica: 'C:\\exp\\environment\\runs\\run-1',
  };
  const { lines, rowHits } = renderResultWithHits(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks,
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'completed' } },
  } as never, 'en', 'Codex', true);
  const reportLine = lines.findIndex((line) => line.includes('report.html'));
  assert.ok(reportLine >= 0);
  let hitCol = 0;
  for (let col = 1; col <= 120; col += 1) {
    if (hitFileLink(lines[reportLine] ?? '', col)?.includes('report.html')) {
      hitCol = col;
      break;
    }
  }
  assert.ok(hitCol > 0);
  assert.equal(resultPointerAction(lines, reportLine, hitCol, 'en', pathLinks, rowHits), 'open-report');
  assert.equal(resultPointerAction(lines, 0, 2, 'en', pathLinks, rowHits), undefined);
  const compareLine = lines.findIndex((line) => line.includes('Generate comparison card'));
  assert.ok(compareLine >= 0);
  assert.equal(resultPointerAction(lines, compareLine, 4, 'en', pathLinks, rowHits), 'compare');
});

test('result pointer matches final framed screen coords without OSC 8', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const theme = createTheme(120, false);
  assert.equal(theme.framed, true);
  const pathLinks = {
    historyFinal: 'C:\\exp\\environment\\baselines\\deck.html',
  };
  const { lines, rowHits } = renderResultWithHits(theme, 120, {
    experimentRoot: 'C:\\exp',
    pathLinks,
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'skipped' } },
  } as never, 'en');
  const row = lines.findIndex((line) => line.includes('deck.html') && line.includes('History'));
  assert.ok(row >= 0);
  const line = lines[row] ?? '';
  const value = visibleSpan(line, 'environment/baselines/deck.html');
  assert.ok(value);
  assert.equal(hitFileLink(line, value.x0), undefined);
  assert.equal(pointerAt(lines, row, value.x0, 'en', pathLinks, rowHits), 'open-history-final');
  assert.equal(pointerAt(lines, row, value.x1, 'en', pathLinks, rowHits), 'open-history-final');
  assert.equal(pointerAt(lines, row, value.x0 - 1, 'en', pathLinks, rowHits), undefined);
  assert.equal(pointerAt(lines, row, value.x0 - 2, 'en', pathLinks, rowHits), undefined);
});

test('result pointer stays aligned when metrics wrap at compact width', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const pathLinks = {
    report: 'C:\\exp\\report.html',
    historyFinal: 'C:\\exp\\environment\\baselines\\deck.html',
    candidateFinal: 'C:\\exp\\environment\\runs\\run-1\\out.html',
  };
  const fixture = {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks,
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'apparently_completed' }, termination: { kind: 'completed', code: 'completed.controller_satisfied' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed', value: { type: 'done', reason: 'satisfied' } },
    comparison: { result: { status: 'completed' } },
    facts: { wallClockMs: 72_000, turns: 3, controllerCalls: 2, tokenCount: 4096, costUsd: 1.23 },
  } as never;
  for (const width of [48, 60]) {
    const theme = createTheme(width, false);
    assert.equal(theme.framed, false);
    const { lines, rowHits } = renderResultWithHits(theme, width, fixture, 'en');
    const reportRow = lines.findIndex((line) => {
      const plain = stripTerminalSequences(line);
      return plain.includes('report.html') && /Comparison report|Report/.test(plain);
    });
    const historyRow = lines.findIndex((line) => stripTerminalSequences(line).includes('deck.html'));
    const metricsRow = lines.findIndex((line) => {
      const plain = stripTerminalSequences(line);
      return plain.includes('72s') || plain.includes('4096');
    });
    assert.ok(reportRow >= 0, `report row at width ${width}`);
    assert.ok(historyRow >= 0, `history row at width ${width}`);
    assert.ok(metricsRow >= 0, `metrics row at width ${width}`);
    assert.doesNotMatch(stripTerminalSequences(lines[metricsRow] ?? ''), /4096/, 'compact density drops secondary token metrics');
    const reportLine = lines[reportRow] ?? '';
    const historyLine = lines[historyRow] ?? '';
    const metricsLine = lines[metricsRow] ?? '';
    const reportValue = visibleSpan(reportLine, 'report.html');
    const historyValue = visibleSpan(historyLine, 'deck.html');
    const metricsValue = visibleSpan(metricsLine, '72s') ?? visibleSpan(metricsLine, '3 turns');
    assert.ok(reportValue);
    assert.ok(historyValue);
    assert.ok(metricsValue);
    assert.equal(pointerAt(lines, metricsRow, metricsValue.x0, 'en', pathLinks, rowHits), undefined);
    assert.equal(pointerAt(lines, reportRow, reportValue.x0, 'en', pathLinks, rowHits), 'open-report');
    assert.equal(pointerAt(lines, historyRow, historyValue.x0, 'en', pathLinks, rowHits), 'open-history-final');
  }
});

test('result pointer matches final unframed screen coords without OSC 8', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const theme = createTheme(48, false);
  assert.equal(theme.framed, false);
  const pathLinks = {
    replica: 'C:\\exp\\environment\\runs\\run-1',
  };
  const { lines, rowHits } = renderResultWithHits(theme, 48, {
    experimentRoot: 'C:\\exp',
    pathLinks,
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'skipped' } },
  } as never, 'zh');
  const row = lines.findIndex((line) => line.includes('environment/runs/run-1/') && line.includes('隔离副本'));
  assert.ok(row >= 0);
  const line = lines[row] ?? '';
  const value = visibleSpan(line, 'environment/runs/run-1/');
  assert.ok(value);
  assert.equal(hitFileLink(line, value.x0), undefined);
  assert.equal(pointerAt(lines, row, value.x0, 'zh', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x1, 'zh', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x0 - 1, 'zh', pathLinks, rowHits), undefined);
  assert.equal(pointerAt(lines, row, value.x0 - 2, 'zh', pathLinks, rowHits), undefined);
});

test('result pointer treats environment baselines html as history final', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const baselinePath = 'C:\\exp\\environment\\baselines\\deck.html';
  const href = pathToFileURL(baselinePath).href;
  const pathLinks = {
    report: 'C:\\exp\\report.html',
    historyFinal: baselinePath,
    candidateFinal: 'C:\\exp\\environment\\runs\\run-1\\deck.html',
    trace: 'C:\\exp\\runs\\run-1',
    replica: 'C:\\exp\\environment\\runs\\run-1',
  };
  const theme = createTheme(120, false);
  const { lines, rowHits } = renderResultWithHits(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks,
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'completed' } },
  } as never, 'en');
  const historyLine = lines.findIndex((line) => line.includes('deck.html') && line.includes('History'));
  assert.ok(historyLine >= 0);
  let hitCol = 0;
  for (let col = 1; col <= 120; col += 1) {
    if (hitFileLink(lines[historyLine] ?? '', col) === href) {
      hitCol = col;
      break;
    }
  }
  assert.ok(hitCol > 0);
  assert.equal(resultPointerAction(lines, historyLine, hitCol, 'en', pathLinks, rowHits), 'open-history-final');
  assert.equal(resolveResultLinkAction(href, pathLinks), 'open-history-final');
});

const resultFixture = {
  reportPath: 'C:\\exp\\report.html',
  experimentRoot: 'C:\\exp',
  record: {
    attempt: { runId: 'run-1' },
    outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
  },
  decision: { status: 'completed' },
  comparison: { result: { status: 'completed' } },
} as never;

function resultController(opened: { report: number; artifact?: string | undefined }): ControllerHandle {
  const view: WorkbenchView = { page: 'result', cwd: 'C:/', hasApiConfig: true, hasTaskCase: false, message: '' };
  return {
    locale: 'en',
    result: resultFixture,
    compareChoice: undefined,
    timelineReadOffset: 0,
    columns: () => 120,
    viewport: () => ({ height: 40 }),
    view: () => view,
    render() {},
    openReport() {
      opened.report += 1;
      return { consume: true };
    },
    openTrace() {
      return { consume: true };
    },
    openReplica() {
      return { consume: true };
    },
    openResultArtifactHref(href: string | undefined, _side: 'history' | 'candidate') {
      opened.artifact = href;
      return { consume: true };
    },
  } as unknown as ControllerHandle;
}

test('result SGR click on history final opens the clicked href', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0, artifact: undefined as string | undefined };
  const handle = resultController(opened);
  const baselinePath = join('C:\\exp', 'environment', 'baselines', 'deck.html');
  const resultWithBaselines = {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks: {
      report: 'C:\\exp\\report.html',
      historyFinal: baselinePath,
      candidateFinal: join('C:\\exp', 'environment', 'runs', 'run-1', 'deck.html'),
      trace: 'C:\\exp\\runs\\run-1',
      replica: 'C:\\exp\\environment\\runs\\run-1',
    },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'completed' } },
  } as typeof resultFixture;
  handle.result = resultWithBaselines;
  const origin = workbenchBodyOrigin(handle.view(), 120, 40);
  const lines = renderResult(createTheme(120), 120, resultWithBaselines, 'en', undefined, false);
  const historyLine = lines.findIndex((line) => line.includes('deck.html'));
  assert.ok(historyLine >= 0);
  const href = pathToFileURL(baselinePath).href;
  let hitCol = 0;
  for (let col = 1; col <= 120; col += 1) {
    if (hitFileLink(lines[historyLine] ?? '', col) === href) {
      hitCol = col;
      break;
    }
  }
  assert.ok(hitCol > 0);
  applyResultPointer(handle, `\x1b[<0;${hitCol};${historyLine + 1 + origin.header}M`);
  assert.equal(opened.artifact, href);
});

test('result SGR click on a short label opens the report; a blank cell does not', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0 };
  const handle = resultController(opened);
  const origin = workbenchBodyOrigin(handle.view(), 120, 40);
  const lines = renderResult(createTheme(120), 120, resultFixture, 'en', undefined, false);
  const reportLine = lines.findIndex((line) => line.includes('report.html'));
  assert.ok(reportLine >= 0);
  let hitCol = 0;
  for (let col = 1; col <= 120; col += 1) {
    if (hitFileLink(lines[reportLine] ?? '', col)?.includes('report.html')) {
      hitCol = col;
      break;
    }
  }
  assert.ok(hitCol > 0);
  applyResultPointer(handle, `\x1b[<0;${hitCol};${reportLine + 1 + origin.header}M`);
  assert.equal(opened.report, 1);
  applyResultPointer(handle, `\x1b[<0;2;${1 + origin.header}M`);
  assert.equal(opened.report, 1);
});

test('result SGR wheel changes the reading offset', () => {
  const opened = { report: 0 };
  const handle = resultController(opened);
  applyResultPointer(handle, '\x1b[<65;1;2M');
  assert.equal(handle.timelineReadOffset, 1);
  applyResultPointer(handle, '\x1b[<64;1;2M');
  assert.equal(handle.timelineReadOffset, 0);
});

test('viewport TUI swallows SGR wheel unless yielded to the application', () => {
  const host = {
    handleViewportInput(_data: string) {
      return { consume: true as const };
    },
  };
  const seen: string[] = [];
  const listeners = new Set<(data: string) => { consume?: true } | undefined>();
  listeners.add((data) => {
    seen.push('viewport');
    return host.handleViewportInput(data);
  });
  listeners.add(() => {
    seen.push('app');
    return { consume: true };
  });
  let consumed = false;
  for (const listener of listeners) {
    const result = listener('\x1b[<64;1;2M');
    if (result?.consume) {
      consumed = true;
      break;
    }
  }
  assert.equal(consumed, true);
  assert.deepEqual(seen, ['viewport']);
});

test('viewport TUI yields SGR wheel to the application listener', () => {
  const host = {
    handleViewportInput(_data: string) {
      return { consume: true as const };
    },
  };
  const seen: string[] = [];
  const listeners = new Set<(data: string) => { consume?: true } | undefined>();
  listeners.add((data) => {
    seen.push('viewport');
    return host.handleViewportInput(data);
  });
  listeners.add((data) => {
    seen.push('app');
    return data.includes('<64;') ? { consume: true } : undefined;
  });
  yieldPointerToApp(host);
  let consumed = false;
  for (const listener of listeners) {
    const result = listener('\x1b[<64;1;2M');
    if (result?.consume) {
      consumed = true;
      break;
    }
  }
  assert.equal(consumed, true);
  assert.deepEqual(seen, ['viewport', 'app']);
});

