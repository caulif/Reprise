import { Value } from "@sinclair/typebox/value";
import { PublicActivityPayloadSchema } from "../core/public-activity.js";
import type { EventEnvelope } from "../core/schema.js";
import type { UserSurfaceProjection } from "../products/contract.js";

type EventWriter = {
  append(input: {
    type: string;
    runId?: string;
    payload: unknown;
    occurredAt?: string;
  }): Promise<EventEnvelope>;
};

/** Writes pack-translated operator activities as product-agnostic events. Translator failures leave the raw event as the record. */
export async function persistPublicActivities(input: {
  store: EventWriter;
  envelope: EventEnvelope;
  translator: UserSurfaceProjection;
}): Promise<void> {
  if (input.envelope.type === "runtime.public_activity") return;
  let entries;
  try {
    entries = input.translator.translate(input.envelope);
  } catch {
    // Pack translate threw; the raw Target event is already committed.
    return;
  }
  for (const item of entries) {
    const payload = {
      schemaVersion: 1 as const,
      sourceEventId: input.envelope.eventId,
      sourceEventType: input.envelope.type,
      activity: item.activity,
      ...(item.correlationId ? { correlationId: item.correlationId } : {}),
      ...(item.merge ? { merge: item.merge } : {}),
    };
    if (!Value.Check(PublicActivityPayloadSchema, payload)) continue;
    await input.store.append({
      type: "runtime.public_activity",
      ...(input.envelope.runId ? { runId: input.envelope.runId } : {}),
      payload,
      occurredAt: input.envelope.occurredAt,
    });
  }
}
