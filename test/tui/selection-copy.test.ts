import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTerminalSequences, TuiAltScreen, type Terminal } from '@earendil-works/pi-tui';
import { IntakeTui } from '../../src/tui/intake-tui.js';

class InputTerminal implements Terminal {
  #input: ((data: string) => void) | undefined;
  #writes: string[] = [];

  constructor(readonly columns = 120, readonly rows = 30) {}

  get kittyProtocolActive(): boolean { return false; }
  start(onInput: (data: string) => void, _onResize: () => void): void { this.#input = onInput; }
  stop(): void { this.#input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.#writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  input(data: string): void {
    assert.ok(this.#input, 'terminal input callback must be registered by TuiAltScreen.start');
    this.#input(data);
  }

  drainWrites(): string {
    const writes = this.#writes.join('');
    this.#writes = [];
    return writes;
  }
}

const privacy = { allowModelText: false, allowBinary: false, redactions: [] };

async function runningApp(t: test.TestContext): Promise<{ app: IntakeTui; tui: TuiAltScreen; terminal: InputTerminal }> {
  const root = await mkdtemp(join(tmpdir(), 'reprise-selection-copy-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const terminal = new InputTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  t.after(() => tui.stop());
  const app = new IntakeTui({ dataDir: join(root, 'data'), tui, privacy });
  await app.start();
  app.page = 'running';
  app.timeline = [
    { sequence: 1, occurredAt: '2026-09-23T00:00:00.000Z', source: 'TARGET', title: 'Visible response', detail: 'COPY_TARGET' },
    { sequence: 2, occurredAt: '2026-09-23T00:00:01.000Z', source: 'TARGET', title: 'Visible response', detail: 'SECOND_TARGET' },
  ];
  app.timelineFollowing = false;
  app.timelineSelected = 0;
  app.render(true);
  terminal.drainWrites();
  return { app, tui, terminal };
}

function renderedLine(tui: TuiAltScreen, terminal: InputTerminal, needle: string): { row: number; column: number } {
  const lines = tui.render(terminal.columns).map((line) => stripTerminalSequences(line));
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `expected ${needle} in the rendered terminal frame`);
  return { row: index + 1, column: (lines[index] ?? '').indexOf(needle) + 1 };
}

function copiedText(writes: string): string | undefined {
  const match = /\x1b\]52;c;([^\x07]+)\x07/.exec(writes);
  return match ? Buffer.from(match[1] ?? '', 'base64').toString('utf8') : undefined;
}

test('selection mode routes a real SGR drag through TuiAltScreen and copies its selected text', async (t) => {
  const { app, tui, terminal } = await runningApp(t);
  terminal.input('v');
  assert.equal(app.readingMode, true);
  const target = renderedLine(tui, terminal, 'COPY_TARGET');
  const end = target.column + 'COPY_TARGET'.length - 1;

  terminal.input(`\x1b[<0;${target.column};${target.row}M`);
  terminal.input(`\x1b[<32;${end};${target.row}M`);
  terminal.input(`\x1b[<0;${end};${target.row}m`);
  tui.renderNow();
  const output = terminal.drainWrites();

  assert.equal(copiedText(output), 'COPY_TARGET');
  assert.match(output, /Copied!/);
  assert.equal(app.timelineSelected, 0);
});

test('ordinary running mode still routes a primary click to the application timeline', async (t) => {
  const { app, tui, terminal } = await runningApp(t);
  const target = renderedLine(tui, terminal, 'SECOND_TARGET');

  terminal.input(`\x1b[<0;${target.column};${target.row}M`);

  assert.equal(app.readingMode, false);
  assert.equal(app.timelineSelected, 1);
});
