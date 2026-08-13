import { stripTerminalSequences, type Terminal, type TUI } from '@earendil-works/pi-tui';

/** Minimal Terminal that records writes for layout-engine tests. */
export class FakeTerminal implements Terminal {
  #columns: number;
  #rows: number;
  #writes: string[] = [];
  kittyProtocolActive = false;

  constructor(columns = 120, rows = 30) {
    this.#columns = columns;
    this.#rows = rows;
  }

  start(): void { /* tests drive input through CodexIntakeTui.handleInput */ }
  stop(): void { /* no raw mode */ }
  async drainInput(): Promise<void> { /* no stdin */ }
  write(data: string): void { this.#writes.push(data); }
  get columns(): number { return this.#columns; }
  get rows(): number { return this.#rows; }
  resize(columns: number, rows: number): void {
    this.#columns = columns;
    this.#rows = rows;
  }
  drainWrites(): string {
    const text = this.#writes.join('');
    this.#writes = [];
    return text;
  }
  moveBy(): void { /* unused */ }
  hideCursor(): void { /* unused */ }
  showCursor(): void { /* unused */ }
  clearLine(): void { /* unused */ }
  clearFromCursor(): void { /* unused */ }
  clearScreen(): void { /* unused */ }
  setTitle(): void { /* unused */ }
  setProgress(): void { /* unused */ }
}

export function renderFrame(tui: TUI, term: FakeTerminal, rows = 30, cols = 120): string {
  term.resize(cols, rows);
  tui.renderNow(true);
  const raw = term.drainWrites();
  const lines = Array.from({ length: rows }, () => '');
  const positioned = /\x1b\[(\d+);1H(?:\x1b\[2K)?([^\x1b]*)/g;
  let match: RegExpExecArray | null;
  while ((match = positioned.exec(raw))) {
    const row = Number(match[1]) - 1;
    if (row >= 0 && row < rows) lines[row] = match[2] ?? '';
  }
  const stripped = stripTerminalSequences(raw);
  if (lines.every((line) => line === '') && stripped.trim()) {
    return stripped.split('\n').map((line) => line.trimEnd()).join('\n');
  }
  return lines.map((line) => stripTerminalSequences(line).trimEnd()).join('\n');
}
