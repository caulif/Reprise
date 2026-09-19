import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateEventUsage,
  aggregateHistoricalUsage,
  busyMsFromHistoricalEvents,
  usageCostUsd,
} from "../../src/application/session-usage.js";
import { calculateUsageCostUsd, MODEL_PRICING_TABLE_VERSION } from "../../src/application/model-pricing.js";
import type { EventEnvelope } from "../../src/core/schema.js";

function envelope(payload: Record<string, unknown>, type = "runtime.usage_reported"): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence: 1,
    eventId: "event-1",
    occurredAt: "2026-09-11T00:00:00.000Z",
    type,
    runId: "run-1",
    payload,
    checksum: "a".repeat(64),
  };
}

test("Codex last_token_usage is summed and total_token_usage is not treated as a new delta", () => {
  const events = [
    envelope({ info: { last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 0 }, total_token_usage: { total_tokens: 5000 } } }),
    envelope({ info: { last_token_usage: { input_tokens: 80, output_tokens: 5, cached_input_tokens: 0 }, total_token_usage: { total_tokens: 9000 } } }),
  ];
  const usage = aggregateEventUsage(events);
  assert.ok(usage);
  assert.equal(usage.inputIncludesCache, true);
  assert.equal(usage.parts.input, 180);
  assert.equal(usage.parts.output, 15);
  assert.equal(usage.display, 195);
  assert.notEqual(usage.display, 9000);
});

test("Codex total_token_usage is a watermark only when last_token_usage is absent", () => {
  const events = [
    envelope({ info: { total_token_usage: { total_tokens: 128 } } }),
    envelope({ info: { total_token_usage: { total_tokens: 256 } } }),
  ];
  const usage = aggregateEventUsage(events);
  assert.equal(usage?.display, 256);
});

test("Claude usage_reported rows are added per turn instead of taking the last request", () => {
  const events = [
    envelope({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 } }),
    envelope({ usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 200 } }),
  ];
  const usage = aggregateEventUsage(events);
  assert.equal(usage?.inputIncludesCache, false);
  assert.equal(usage?.parts.input, 30);
  assert.equal(usage?.parts.output, 5);
  assert.equal(usage?.parts.cacheRead, 300);
  assert.equal(usage?.display, 30 + 5 + 300);
  assert.notEqual(usage?.display, 20 + 3 + 200);
});

test("historical Codex task_started/task_complete pairs sum busy time and ignore the session span", () => {
  const events = [
    { timestamp: "2026-09-11T00:00:00.000Z", type: "event_msg", payload: { type: "session_meta" } },
    { timestamp: "2026-09-11T00:01:00.000Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-09-11T00:03:00.000Z", type: "event_msg", payload: { type: "task_complete" } },
    { timestamp: "2026-09-11T00:10:00.000Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-09-11T00:11:00.000Z", type: "event_msg", payload: { type: "task_complete" } },
    { timestamp: "2026-09-11T01:00:00.000Z", type: "event_msg", payload: { type: "turn_aborted" } },
  ];
  assert.equal(busyMsFromHistoricalEvents(events), 3 * 60_000);
});

test("unknown model prices stay uncollected and tests can inject a fixed table", () => {
  assert.match(MODEL_PRICING_TABLE_VERSION, /^2026-09-19/);
  const usage = aggregateHistoricalUsage([
    { type: "result", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } },
  ]);
  assert.equal(usageCostUsd(usage, "unknown-model-xyz"), undefined);
  assert.equal(
    calculateUsageCostUsd(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheCreation: 0 },
      { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
      false,
    ),
    18,
  );
});
