import { matchesKey } from '@earendil-works/pi-tui';
import { isTextInput } from './format.js';

export type TextEdit = {
  readonly value: string;
  readonly cursor: number;
  readonly handled: boolean;
};

/** Applies the terminal editing keys shared by the workbench's plain-text fields. */
export function applyTextEdit(value: string, cursor: number, input: string): TextEdit {
  const position = Math.max(0, Math.min(value.length, cursor));
  if (matchesKey(input, 'left')) return { value, cursor: previousBoundary(value, position), handled: true };
  if (matchesKey(input, 'right')) return { value, cursor: nextBoundary(value, position), handled: true };
  if (matchesKey(input, 'home')) return { value, cursor: 0, handled: true };
  if (matchesKey(input, 'end')) return { value, cursor: value.length, handled: true };
  if (matchesKey(input, 'backspace')) {
    const start = previousBoundary(value, position);
    return { value: value.slice(0, start) + value.slice(position), cursor: start, handled: true };
  }
  if (matchesKey(input, 'delete')) {
    const end = nextBoundary(value, position);
    return { value: value.slice(0, position) + value.slice(end), cursor: position, handled: true };
  }
  if (isTextInput(input)) return { value: value.slice(0, position) + input + value.slice(position), cursor: position + input.length, handled: true };
  return { value, cursor: position, handled: false };
}

export function caretAt(value: string, cursor: number): string {
  const position = Math.max(0, Math.min(value.length, cursor));
  return `${value.slice(0, position)}▌${value.slice(position)}`;
}

function previousBoundary(value: string, cursor: number): number {
  if (!cursor) return 0;
  const prefix = value.slice(0, cursor);
  const last = Array.from(prefix).at(-1);
  return cursor - (last?.length ?? 0);
}

function nextBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const first = Array.from(value.slice(cursor))[0];
  return cursor + (first?.length ?? 0);
}