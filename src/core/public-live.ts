import { Value } from "@sinclair/typebox/value";
import { record } from "./json.js";
import { PublicLiveActivitySchema, type PublicLiveActivity } from "./schema.js";

/** Trust-boundary reader: only a validated `live` object is operator-visible process. */
export function publicLiveOf(payload: unknown): PublicLiveActivity | undefined {
  const live = record(payload).live;
  return Value.Check(PublicLiveActivitySchema, live) ? live : undefined;
}
