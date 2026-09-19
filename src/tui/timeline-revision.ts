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

/** Cheap identity of a painted/folded entry list — catches fold expand without a revision bump. */
export function timelineEntriesKey(
  entries: readonly {
    readonly sequence: number;
    readonly kind?: string;
    readonly itemId?: string;
    readonly title: string;
    readonly detail?: string;
  }[],
): string {
  let out = String(entries.length);
  for (const entry of entries) {
    out += `\0${entry.sequence}:${entry.kind ?? ''}:${entry.itemId ?? ''}:${entry.title.length}:${entry.detail?.length ?? 0}`;
  }
  return out;
}
