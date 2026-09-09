import { findProductPack } from '../../src/products/index.js';
import { packProjection } from '../../src/products/pack-access.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { projectTimelineEvent, type TimelineEntry } from '../../src/tui/timeline.js';

export function publicActivityEntry(event: EventEnvelope): TimelineEntry | undefined {
  return projectPackEntries(event)[0];
}

export function projectPackEntries(event: EventEnvelope, productId = event.type.startsWith('claude-code.') ? 'claude-code' : 'codex'): TimelineEntry[] {
  return packProjection(findProductPack(productId)).translate(event).flatMap((item, index) => projectTimelineEvent({
    ...event,
    eventId: `pub-${event.eventId}-${index}`,
    type: 'runtime.public_activity',
    payload: {
      schemaVersion: 1,
      sourceEventId: event.eventId,
      sourceEventType: event.type,
      activity: item.activity,
      ...(item.correlationId ? { correlationId: item.correlationId } : {}),
      ...(item.merge ? { merge: item.merge } : {}),
    },
  }));
}
