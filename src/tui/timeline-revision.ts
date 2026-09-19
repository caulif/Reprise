export type TimelineRevisionState = {
  timelineRevision: number;
};

export function bumpTimelineRevision(state: TimelineRevisionState): number {
  state.timelineRevision += 1;
  return state.timelineRevision;
}

export function expandedFoldsKey(folds: readonly string[]): string {
  return folds.length ? [...folds].sort().join('\0') : '';
}
