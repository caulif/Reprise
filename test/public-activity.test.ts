import test from "node:test";
import assert from "node:assert/strict";
import { persistPublicActivities } from "../src/application/public-activity.js";
import { PublicActivityPayloadSchema } from "../src/core/public-activity.js";
import type { EventEnvelope } from "../src/core/schema.js";
import { Value } from "@sinclair/typebox/value";
import { findProductPack } from "../src/products/index.js";
import { packActivity } from "../src/products/pack-access.js";

const envelope: EventEnvelope = {
  schemaVersion: 1,
  sequence: 1,
  eventId: "evt-1",
  occurredAt: "2026-09-08T00:00:00.000Z",
  type: "codex.turn_started",
  runId: "run-1",
  payload: { turnId: "turn-1" },
  checksum: "0".repeat(64),
};

test("persistPublicActivities writes schema-checked runtime.public_activity rows", async () => {
  const written: EventEnvelope[] = [];
  await persistPublicActivities({
    store: {
      async append(input) {
        const event: EventEnvelope = {
          schemaVersion: 1,
          sequence: written.length + 2,
          eventId: `pub-${written.length}`,
          occurredAt: envelope.occurredAt,
          type: input.type,
          payload: input.payload,
          checksum: "1".repeat(64),
        };
        written.push(event);
        return event;
      },
    },
    envelope,
    translator: packActivity(findProductPack("codex")),
  });
  assert.ok(written.length >= 1);
  for (const event of written) {
    assert.equal(event.type, "runtime.public_activity");
    assert.equal(Value.Check(PublicActivityPayloadSchema, event.payload), true);
  }
});

test("invalid public activity payloads are not appended", async () => {
  const written: unknown[] = [];
  await persistPublicActivities({
    store: {
      async append(input) {
        written.push(input);
        throw new Error("should not append");
      },
    },
    envelope,
    translator: { translate: () => [{ activity: { kind: "not-a-kind" } as never }], inspectRunFacts: () => ({ commands: [], rejectedApprovals: 0, evidenceEvents: [] }) },
  });
  assert.deepEqual(written, []);
});
