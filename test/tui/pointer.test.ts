import test from 'node:test';
import assert from 'node:assert/strict';
import { setCapabilities } from '@earendil-works/pi-tui';
import type { ControllerHandle } from '../../src/tui/controller-input.js';
import { hitFileLink } from '../../src/tui/format.js';
import { homeHints } from '../../src/tui/pages/home.js';
import { applyResultPointer, yieldPointerToApp } from '../../src/tui/pointer-dispatch.js';
import { resultPointerAction, renderResult } from '../../src/tui/pages/result.js';
import { keepSelectedVisible } from '../../src/tui/scrollback.js';
import { createTheme } from '../../src/tui/theme.js';
import { workbenchBodyOrigin, type WorkbenchView } from '../../src/tui/workbench.js';

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
  const lines = renderResult(theme, 120, {
    reportPath: 'C:\\exp\\report.html',
    experimentRoot: 'C:\\exp',
    record: {
      attempt: { runId: 'run-1' },
      outcome: { task: { status: 'complete' }, termination: { kind: 'completed', code: 'completed' }, cleanup: { status: 'complete' } },
    },
    decision: { status: 'completed' },
    comparison: { result: { status: 'completed' } },
  } as never, 'en', 'Codex', true);
  const reportLine = lines.findIndex((line) => line.includes('report.html'));
  assert.ok(reportLine >= 0);
  assert.equal(resultPointerAction(lines, reportLine, 20, 'en'), 'open-report');
  assert.equal(resultPointerAction(lines, 0, 2, 'en'), undefined);
  const compareLine = lines.findIndex((line) => line.includes('Start comparison'));
  assert.ok(compareLine >= 0);
  assert.equal(resultPointerAction(lines, compareLine, 4, 'en'), 'compare');
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

function resultController(opened: { report: number }): ControllerHandle {
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
  } as unknown as ControllerHandle;
}

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

