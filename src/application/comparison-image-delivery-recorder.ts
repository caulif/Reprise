import { Value } from "@sinclair/typebox/value";
import { AgentImageRefSchema } from "../core/agent-model-input-schema.js";

type DeliveryEvent = { type: string; payload: Record<string, unknown> };

export function createComparisonImageDeliveryRecorder(delivered: Set<string>): (event: DeliveryEvent) => void {
  let hasRequestManifest = false;
  return (event) => {
    if (event.type === "agent.session_started") {
      delivered.clear();
      hasRequestManifest = false;
      return;
    }
    if (event.type === "agent.model_request" && event.payload.scope !== "compaction" && Array.isArray(event.payload.images)) {
      if (!hasRequestManifest) delivered.clear();
      hasRequestManifest = true;
      for (const image of event.payload.images) {
        if (!Value.Check(AgentImageRefSchema, image)) throw new Error("Invalid actual image delivery manifest.");
        delivered.add(image.contentHash);
      }
    } else if (!hasRequestManifest) recordDeliveredImageContentHashes(event, delivered);
  };
}

function recordDeliveredImageContentHashes(
  event: { type: string; payload: Record<string, unknown> },
  delivered: Set<string>,
): void {
  if (event.type === "agent.message_appended") {
    const images = event.payload.images;
    if (!Array.isArray(images)) return;
    for (const image of images) {
      if (image && typeof image === "object" && typeof (image as { contentHash?: unknown }).contentHash === "string") {
        delivered.add((image as { contentHash: string }).contentHash);
      }
    }
    return;
  }
  if (event.type !== "agent.tool_completed") return;
  const types = event.payload.contentTypes;
  if (!Array.isArray(types) || !types.includes("image")) return;
  const body = event.payload.body;
  if (!body || typeof body !== "object" || (body as { encoding?: unknown }).encoding !== "inline") return;
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const block of parsed) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: unknown }).type === "image"
        && typeof (block as { contentHash?: unknown }).contentHash === "string"
      ) {
        delivered.add((block as { contentHash: string }).contentHash);
      }
    }
  } catch {
    // Tool body is not JSON image blocks; nothing to record for visual-claim delivery.
  }
}
