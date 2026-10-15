import { record, text } from '../core/json.js';
import type { EventEnvelope } from '../core/schema.js';
import type { TimingFacts } from '../core/timing-schema.js';

type Row = { body: Record<string, unknown>; at: number | undefined; id: string | undefined; ref: string };
type Measurement = { value: number; source: TimingFacts['sources'][number]; interval?: readonly [number, number] };

function time(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function duration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function difference(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined;
}

function turnId(body: Record<string, unknown>): string | undefined {
  return text(body.turn_id) ?? text(body.turnId) ?? text(record(body.turn).id);
}

function row(event: Record<string, unknown>, index: number, historical: boolean): Row {
  const body = { ...event, ...record(event.payload) };
  return {
    body, id: turnId(body),
    at: time(event.timestamp) ?? time(event.occurredAt) ?? time(body.timestamp),
    ref: typeof event.eventId === 'string' ? `event:${event.eventId}` : `${historical ? 'historical' : 'candidate'}:${index}`,
  };
}

function facts(completed: number, open: number, measurements: Measurement[], diagnostics: Set<string>): TimingFacts {
  const intervals = measurements.flatMap(item => item.interval ? [item.interval] : []).sort((left, right) => left[0] - right[0]);
  let previousEnd = -Infinity;
  for (const [start, end] of intervals) {
    if (start < previousEnd) diagnostics.add('overlapping_turn_intervals_summed');
    previousEnd = Math.max(previousEnd, end);
  }
  const total = measurements.reduce((sum, item) => sum + item.value, 0);
  const valid = Number.isFinite(total);
  if (!valid) diagnostics.add('duration_sum_overflow');
  const measured = valid ? measurements.length : 0;
  return {
    ...(measured ? { valueMs: total } : {}),
    basis: 'turn_wall_clock_sum',
    coverage: { completedTurns: completed, measuredTurns: measured, openTurns: open,
      status: measured === 0 ? 'unavailable' : measured === completed && open === 0 ? 'complete' : 'partial' },
    sources: valid ? measurements.map(item => item.source) : [],
    diagnostics: [...diagnostics],
  };
}

function groupCompletions(rows: Row[], diagnostics: Set<string>): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const item of rows) {
    const key = item.id ? `turn:${item.id}` : `anonymous:${item.at ?? item.ref}:${JSON.stringify(item.body)}`;
    const group = groups.get(key) ?? [];
    if (group.length) diagnostics.add('duplicate_completion');
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function deduplicateStarts(starts: Row[], diagnostics: Set<string>): Row[] {
  const seen = new Set<string>();
  return starts.filter(start => {
    const key = `${start.id ?? 'anonymous'}:${start.at ?? start.ref}`;
    if (seen.has(key)) { diagnostics.add('duplicate_start'); return false; }
    seen.add(key);
    return true;
  });
}

function matchingStart(end: Row, starts: Row[], diagnostics: Set<string>): Row | undefined {
  const matching = starts.filter(start => (end.id ? start.id === end.id : !start.id) &&
    start.at !== undefined && end.at !== undefined && start.at <= end.at);
  if (matching.length > 1) {
    diagnostics.add('ambiguous_start');
    return undefined;
  }
  return matching[0];
}

function nativeSeconds(value: unknown): number | undefined {
  // Codex started_at/completed_at are Unix seconds. Millisecond epochs must not be silently reinterpreted.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 100_000_000_000
    ? value * 1000 : undefined;
}

export function historicalTurnTiming(events: readonly Record<string, unknown>[]): TimingFacts {
  const diagnostics = new Set<string>();
  let starts: Row[] = [];
  const ends: Row[] = [];
  const aborted: Row[] = [];
  for (let i = 0; i < events.length; i++) {
    const item = row(events[i]!, i, true);
    if (item.body.type === 'task_started') starts.push(item);
    if (item.body.type === 'task_complete') ends.push(item);
    if (item.body.type === 'turn_aborted') { aborted.push(item); diagnostics.add('aborted_turn'); }
  }
  starts = deduplicateStarts(starts, diagnostics);
  const measurements: Measurement[] = [];
  const groups = groupCompletions(ends, diagnostics);
  const usedStarts = new Set<Row>();
  for (const group of groups) {
    const end = group[0]!;
    const durations = group.map(item => duration(item.body.duration_ms)).filter(value => value !== undefined);
    if (group.some(item => item.body.duration_ms !== undefined && duration(item.body.duration_ms) === undefined)) diagnostics.add('invalid_duration_ms');
    if (new Set(durations).size > 1) {
      diagnostics.add('conflicting_duration_ms');
      continue;
    }
    const start = matchingStart(end, starts.filter(item => !usedStarts.has(item)), diagnostics);
    if (start) usedStarts.add(start);
    if (durations.length) {
      measurements.push({ value: durations[0]!, source: { kind: 'duration_ms', refs: group.filter(item => duration(item.body.duration_ms) !== undefined).map(item => item.ref) },
        ...(difference(start?.at, end.at) === undefined ? {} : { interval: [start!.at!, end.at!] as const }) });
      continue;
    }
    const paired = difference(start?.at, end.at);
    if (paired !== undefined) {
      measurements.push({ value: paired, source: { kind: 'matched_events', refs: [start!.ref, end.ref] }, interval: [start!.at!, end.at!] });
      continue;
    }
    const from = nativeSeconds(end.body.started_at);
    const to = nativeSeconds(end.body.completed_at);
    const native = difference(from, to);
    if (native !== undefined) measurements.push({ value: native, source: { kind: 'turn_timestamps', refs: [end.ref] }, interval: [from!, to!] });
    else diagnostics.add(end.body.started_at !== undefined || end.body.completed_at !== undefined ? 'invalid_turn_timestamps' : 'missing_turn_boundaries');
  }
  const openRows = starts.filter(start => !usedStarts.has(start) && !groups.some(group => group.some(end =>
    start.id && start.id === end.id && start.at !== undefined && end.at !== undefined && start.at <= end.at)));
  for (const abort of aborted) {
    if (!openRows.some(start => abort.id ? start.id === abort.id : !start.id)) openRows.push(abort);
  }
  const open = new Set(openRows.map(item => item.id ?? item.ref)).size;
  if (open) diagnostics.add('unsettled_turns');
  return facts(groups.length, open, measurements, diagnostics);
}

export function candidateTurnTiming(events: readonly EventEnvelope[]): TimingFacts {
  const diagnostics = new Set<string>();
  const rows = events.map((event, index) => row(event as unknown as Record<string, unknown>, index, false));
  const inputs = rows.filter(item => item.body.type === 'input.submitted');
  const allDeliveries = rows.filter(item => item.body.type === 'runtime.delivery_observed' && item.body.receipt !== undefined);
  const deliveries = allDeliveries.filter(item => record(item.body.receipt).delivery === 'accepted');
  const starts = deduplicateStarts(rows.filter(item => item.body.type === 'runtime.turn_started'), diagnostics);
  const ends = rows.filter(item => item.body.type === 'runtime.turn_settled');
  const groups = groupCompletions(ends, diagnostics);
  const measurements: Measurement[] = [];
  const usedInputs = new Set<Row>();
  for (const group of groups) {
    // Prefer the Host-normalized settlement over the adapter's raw notification for the same turn.
    const end = group.find(item => typeof item.body.turnId === 'string' && typeof item.body.observedAt === 'string') ?? group[0]!;
    const bound = deliveries.filter(delivery => text(record(delivery.body.receipt).turnId) === end.id);
    const boundInputs = inputs.filter(input => bound.some(delivery =>
      typeof input.body.clientMessageId === 'string' && input.body.clientMessageId === delivery.body.clientMessageId));
    let input: Row | undefined;
    if (boundInputs.length === 1) input = boundInputs[0];
    else if (boundInputs.length > 1) diagnostics.add('ambiguous_submission');
    if (!input && !boundInputs.length) {
      // Some adapters accept a message before they know its turn ID. A unique pending accepted submission still binds the Host settlement.
      const pending = inputs.filter(item => !usedInputs.has(item) && item.at !== undefined && end.at !== undefined && item.at <= end.at &&
        !allDeliveries.some(delivery => typeof item.body.clientMessageId === 'string' && delivery.body.clientMessageId === item.body.clientMessageId &&
          record(delivery.body.receipt).delivery !== 'accepted') &&
        !deliveries.some(delivery => delivery.body.clientMessageId === item.body.clientMessageId &&
          typeof delivery.body.clientMessageId === 'string' && turnId(record(delivery.body.receipt)) !== undefined &&
          turnId(record(delivery.body.receipt)) !== end.id));
      if (pending.length === 1) input = pending[0];
    }
    const nativeStart = matchingStart(end, starts, diagnostics);
    const start = input ?? nativeStart;
    const elapsed = difference(start?.at, end.at);
    if (input) usedInputs.add(input);
    if (end.body.status === 'failed' || end.body.status === 'aborted') diagnostics.add('noncompleted_settlement');
    const rawDurations = group.flatMap(item => [item.body.duration_ms, record(item.body.turn).duration_ms]).filter(value => value !== undefined);
    if (rawDurations.some(value => duration(value) === undefined)) diagnostics.add('invalid_duration_ms');
    const durations = rawDurations.map(duration).filter(value => value !== undefined);
    if (new Set(durations).size > 1) { diagnostics.add('conflicting_duration_ms'); continue; }
    if (durations.length) {
      measurements.push({ value: durations[0]!, source: { kind: 'duration_ms', refs: group.map(item => item.ref) },
        ...(elapsed === undefined ? {} : { interval: [start!.at!, end.at!] as const }) });
      continue;
    }
    if (elapsed === undefined) { diagnostics.add('missing_turn_boundaries'); continue; }
    measurements.push({ value: elapsed, source: { kind: input ? 'submission_settlement' : 'matched_events', refs: [start!.ref, end.ref] }, interval: [start!.at!, end.at!] });
  }
  const unmatchedInputs = inputs.filter(input => !usedInputs.has(input));
  const unmatchedStarts = starts.filter(start => !groups.some(group => group.some(end => start.id && start.id === end.id &&
    start.at !== undefined && end.at !== undefined && start.at <= end.at)) &&
    !unmatchedInputs.some(input => input.at !== undefined && start.at !== undefined && input.at <= start.at));
  const open = unmatchedInputs.length + new Set(unmatchedStarts.map(start => start.id ?? start.ref)).size;
  if (open) diagnostics.add('unsettled_submissions');
  return facts(groups.length, open, measurements, diagnostics);
}

export function timingComparable(left: TimingFacts | undefined, right: TimingFacts | undefined, products?: { baseline: string; candidate: string }): boolean {
  if (!left || !right || left.coverage.status !== 'complete' || right.coverage.status !== 'complete' ||
    !products || products.baseline !== products.candidate || left.basis !== 'turn_wall_clock_sum' || right.basis !== left.basis ||
    [...left.diagnostics, ...right.diagnostics].some(item => item !== 'duplicate_completion' && item !== 'duplicate_start')) return false;
  const kinds = new Set([...left.sources, ...right.sources].map(source => source.kind));
  return kinds.size === 1 && kinds.has('duration_ms');
}
