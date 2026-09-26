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
import { measureWorkbenchGeometry, renderWorkbench, workbenchBodyOrigin, type WorkbenchView } from '../../src/tui/workbench.js';
import { bodyCellAt } from '../../src/tui/workbench-layout.js';

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

test('home idle footer lists action navigation', () => {
  const hints = homeHints('en', {
    taskCase: undefined,
    recentExperiment: { experimentId: 'e1', taskCaseId: 'c1', path: 'C:/e', sizeBytes: 1 },
    hasApiConfig: true,
    composer: '',
    showSuggestions: false,
  });
  assert.deepEqual(hints.map(([key]) => key), ['↑↓', 'Enter', '/', 'Ctrl+C']);
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
    comparison: { result: { status: 'completed', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, sessionId: 'cmp-1' } },
  } as never, 'en', 'Codex', false);
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
  assert.equal(lines.some((line) => line.includes('Compare with original result')), false);
});

test('result pointer matches final framed screen coords without OSC 8', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const theme = createTheme(120, false);
  assert.equal(theme.framed, true);
  const pathLinks = {
    replica: 'C:\\exp\\environment\\runs\\run-1',
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
  const row = lines.findIndex((line) => line.includes('run-1') && line.includes('Open this run folder'));
  assert.ok(row >= 0);
  const line = lines[row] ?? '';
  const value = visibleSpan(line, 'run-1');
  assert.ok(value);
  assert.equal(hitFileLink(line, value.x0), undefined);
  assert.equal(pointerAt(lines, row, value.x0, 'en', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x1, 'en', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x0 - 1, 'en', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, 0, 'en', pathLinks, rowHits), undefined);
});

test('result pointer stays aligned when metrics wrap at compact width', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const pathLinks = {
    report: 'C:\\exp\\report.html',
    replica: 'C:\\exp\\environment\\runs\\run-1',
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
    comparison: { result: { status: 'completed', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, sessionId: 'cmp-1' } },
    facts: { wallClockMs: 72_000, turns: 3, controllerCalls: 2, tokenCount: 4096, costUsd: 1.23 },
  } as never;
  for (const width of [48, 60]) {
    const theme = createTheme(width, false);
    assert.equal(theme.framed, false);
    const { lines, rowHits } = renderResultWithHits(theme, width, fixture, 'en', undefined, false, { detailsExpanded: true });
    const reportRow = lines.findIndex((line) => {
      const plain = stripTerminalSequences(line);
      return plain.includes('report.html') && plain.includes('Open report');
    });
    const replicaRow = lines.findIndex((line) => stripTerminalSequences(line).includes('run-1'));
    const metricsRow = lines.findIndex((line) => stripTerminalSequences(line).includes('4096'));
    assert.ok(reportRow >= 0, `report row at width ${width}`);
    assert.ok(replicaRow >= 0, `run folder row at width ${width}`);
    assert.ok(metricsRow >= 0, `metrics row at width ${width}`);
    const reportLine = lines[reportRow] ?? '';
    const replicaLine = lines[replicaRow] ?? '';
    const metricsLine = lines[metricsRow] ?? '';
    const reportValue = visibleSpan(reportLine, 'report.html');
    const replicaValue = visibleSpan(replicaLine, 'run-1');
    const metricsValue = visibleSpan(metricsLine, '4096');
    assert.ok(reportValue);
    assert.ok(replicaValue);
    assert.ok(metricsValue);
    assert.equal(pointerAt(lines, metricsRow, metricsValue.x0, 'en', pathLinks, rowHits), undefined);
    assert.equal(pointerAt(lines, reportRow, reportValue.x0, 'en', pathLinks, rowHits), 'open-report');
    assert.equal(pointerAt(lines, replicaRow, replicaValue.x0, 'en', pathLinks, rowHits), 'open-replica');
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
  const row = lines.findIndex((line) => line.includes('run-1') && line.includes('打开本次执行路径'));
  assert.ok(row >= 0);
  const line = lines[row] ?? '';
  const value = visibleSpan(line, 'run-1');
  assert.ok(value);
  assert.equal(hitFileLink(line, value.x0), undefined);
  assert.equal(pointerAt(lines, row, value.x0, 'zh', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x1, 'zh', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, value.x0 - 1, 'zh', pathLinks, rowHits), 'open-replica');
  assert.equal(pointerAt(lines, row, 0, 'zh', pathLinks, rowHits), undefined);
});

test('result link resolver keeps historical links for older saved reports', () => {
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
  comparison: { result: { status: 'completed', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, sessionId: 'cmp-1' } },
} as never;

function resultController(opened: { report: number; replica?: number; artifact?: string | undefined }): ControllerHandle {
  const view: WorkbenchView = { page: 'result', cwd: 'C:/', hasApiConfig: true, hasTaskCase: false, message: '', result: resultFixture };
  return {
    locale: 'en',
    result: resultFixture,
    timeline: [],
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
      opened.replica = (opened.replica ?? 0) + 1;
      return { consume: true };
    },
    openResultArtifactHref(href: string | undefined, _side: 'history' | 'candidate') {
      opened.artifact = href;
      return { consume: true };
    },
  } as unknown as ControllerHandle;
}

test('result SGR click on the run folder opens the recorded path', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0, replica: 0, artifact: undefined as string | undefined };
  const handle = resultController(opened);
  const replicaPath = join('C:\\exp', 'environment', 'runs', 'run-1');
  const resultWithBaselines = {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    pathLinks: {
      report: 'C:\\exp\\report.html',
      historyFinal: join('C:\\exp', 'environment', 'baselines', 'deck.html'),
      candidateFinal: join('C:\\exp', 'environment', 'runs', 'run-1', 'deck.html'),
      trace: 'C:\\exp\\runs\\run-1',
      replica: replicaPath,
    },
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'completed', value: { status: 'completed', reportPath: 'report.html', evidenceRefs: [] }, sessionId: 'cmp-1' } },
  } as typeof resultFixture;
  handle.result = resultWithBaselines;
  const origin = workbenchBodyOrigin(handle.view(), 120, 40);
  const lines = renderResult(createTheme(120), 120, resultWithBaselines, 'en', undefined, false);
  const replicaLine = lines.findIndex((line) => /Open this run folder/.test(line) && line.includes('run-1'));
  assert.ok(replicaLine >= 0);
  const href = pathToFileURL(replicaPath).href;
  let hitCol = 0;
  for (let col = 1; col <= 120; col += 1) {
    if (hitFileLink(lines[replicaLine] ?? '', col) === href) {
      hitCol = col;
      break;
    }
  }
  assert.ok(hitCol > 0);
  applyResultPointer(handle, `\x1b[<0;${hitCol};${replicaLine + 1 + origin.header}M`);
  assert.equal(opened.replica, 1);
  assert.equal(opened.artifact, undefined);
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

test('result pointer uses the same comparison timing rows as the visible result', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0 };
  const handle = resultController(opened);
  const result = Object.assign({}, resultFixture, { facts: { elapsedMs: 70_000, wallClockMs: 10_000 } });
  const phaseClocks = { comparisonStartedAt: 1_000, comparisonEndedAt: 61_000 };
  handle.result = result;
  handle.view = () => ({ page: 'result', cwd: 'C:/', hasApiConfig: true, hasTaskCase: false, message: '', running: { entries: [], phaseClocks } }) as unknown as WorkbenchView;
  const origin = workbenchBodyOrigin(handle.view(), 120, 40);
  const lines = renderResult(createTheme(120), 120, result, 'en', undefined, false, { phaseClocks });
  const reportLine = lines.findIndex((line) => line.includes('report.html'));
  assert.ok(reportLine >= 0);
  const hitCol = Array.from({ length: 120 }, (_, index) => index + 1)
    .find((col) => hitFileLink(lines[reportLine] ?? '', col)?.includes('report.html'));
  assert.ok(hitCol);
  applyResultPointer(handle, `\x1b[<0;${hitCol};${reportLine + 1 + origin.header}M`);
  assert.equal(opened.report, 1);
});

test('result SGR click on header chrome does not open the report', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0 };
  const handle = resultController(opened);
  // Row 1 is above the body origin — must not clamp into the first body line.
  applyResultPointer(handle, '\x1b[<0;4;1M');
  assert.equal(opened.report, 0);
});

test('result pointer hover follows the report hit and clears on blank space', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  const handle = resultController({ report: 0 });
  handle.timeline = [{ sequence: 1, occurredAt: '', source: 'TARGET', title: 'A recorded step' }];
  handle.resultAction = 'open-report';
  handle.view = () => ({
    page: 'result', cwd: 'C:/', hasApiConfig: true, hasTaskCase: true, message: '',
    result: handle.result,
    resultAction: handle.resultAction,
    resultHover: handle.resultHover,
    running: { entries: handle.timeline, phaseClocks: {} },
  }) as unknown as WorkbenchView;
  const lines = renderWorkbench(handle.view(), 120, 40);
  const reportRow = lines.findIndex((line) => line.includes('Open report'));
  assert.ok(reportRow > 0);
  applyResultPointer(handle, `\x1b[<32;6;${reportRow + 1}M`);
  assert.equal(handle.resultHover, 'open-report');
  assert.match(renderWorkbench(handle.view(), 120, 40).join('\n'), /\x1b\[4mOpen report/);
  applyResultPointer(handle, `\x1b[<32;2;${reportRow + 1}M`);
  assert.equal(handle.resultHover, undefined);
});

test('result SGR wheel changes the reading offset', () => {
  const opened = { report: 0 };
  const handle = resultController(opened);
  handle.viewport = () => ({ height: 8 });
  handle.resultDetails = true;
  handle.view = () => ({
    page: 'result', cwd: 'C:/', hasApiConfig: true, hasTaskCase: false, message: '',
    result: handle.result, resultDetails: true,
  }) as WorkbenchView;
  applyResultPointer(handle, '\x1b[<65;1;2M');
  assert.equal(handle.timelineReadOffset, 1);
  for (let index = 0; index < 50; index += 1) applyResultPointer(handle, '\x1b[<65;1;2M');
  const bottom = handle.timelineReadOffset;
  assert.ok(bottom > 1);
  applyResultPointer(handle, '\x1b[<65;1;2M');
  assert.equal(handle.timelineReadOffset, bottom);
  applyResultPointer(handle, '\x1b[<64;1;2M');
  assert.equal(handle.timelineReadOffset, bottom - 1);
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

test('header and footer clicks miss the body; they do not hit the first result row', () => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: true });
  const opened = { report: 0 };
  const handle = resultController(opened);
  const geometry = measureWorkbenchGeometry(handle.view(), 120, 40);
  assert.ok(geometry.header.height >= 1);
  // Header row 1 must not clamp into body row 0.
  applyResultPointer(handle, '\x1b[<0;4;1M');
  assert.equal(opened.report, 0);
  applyResultPointer(handle, `\x1b[<0;4;${geometry.header.height}M`);
  assert.equal(opened.report, 0);
  // Footer is below the body.
  const footerRow = geometry.footer.row + 1; // 1-based SGR
  applyResultPointer(handle, `\x1b[<0;4;${footerRow}M`);
  assert.equal(opened.report, 0);
  assert.equal(bodyCellAt(geometry, 1, 4), undefined);
  assert.ok(bodyCellAt(geometry, geometry.body.row + 1, 4));
});

