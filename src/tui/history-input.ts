import { matchesKey } from '@earendil-works/pi-tui';

export type HistoryTab = 'runs' | 'cases';

export type HistoryInputState = {
  readonly tab: HistoryTab;
  readonly selected: number;
};

export type HistoryInputResult<T> = {
  readonly state: HistoryInputState;
  readonly consume: true;
  readonly detail?: T;
};

/** Applies keyboard navigation without coupling it to history storage or TUI rendering. */
export function handleHistoryInput<T>(state: HistoryInputState, data: string, items: readonly T[]): HistoryInputResult<T> | undefined {
  if (matchesKey(data, 'up')) return move(state, items.length, -1);
  if (matchesKey(data, 'down')) return move(state, items.length, 1);
  if (matchesKey(data, 'tab')) return { state: { tab: state.tab === 'runs' ? 'cases' : 'runs', selected: 0 }, consume: true };
  if (!matchesKey(data, 'enter')) return undefined;
  const detail = items[state.selected];
  return detail === undefined ? { state, consume: true } : { state, detail, consume: true };
}

function move(state: HistoryInputState, count: number, amount: number): HistoryInputResult<never> {
  return { state: { ...state, selected: Math.max(0, Math.min(Math.max(0, count - 1), state.selected + amount)) }, consume: true };
}
