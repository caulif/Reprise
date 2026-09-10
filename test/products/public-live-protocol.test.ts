import test from "node:test";
import assert from "node:assert/strict";
import { claudeFrameEvents } from "../../src/products/packs/claude-code/protocol.js";
import { codexNotificationEvent } from "../../src/products/packs/codex/protocol.js";
import { publicLiveOf } from "../../src/core/public-live.js";

test("Claude assistant tool_use emits public live without requiring TUI to read the frame", () => {
  const events = claudeFrameEvents({
    type: "assistant",
    sessionId: "sess-1",
    message: {
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "tool_use", id: "call-1", name: "Read", input: { path: "content/hugo.toml" } },
      ],
    },
  });
  assert.equal(events[0]?.type, "runtime.visible_output");
  assert.equal(events[1]?.type, "runtime.tool_started");
  const live = publicLiveOf(events[1]?.payload);
  assert.deepEqual(live, { schemaVersion: 1, verb: "read", leaf: "hugo.toml" });
  assert.equal(JSON.stringify(events[1]?.payload).includes("secret"), false);
});

test("Claude thinking-only assistant does not emit tool_started", () => {
  const events = claudeFrameEvents({
    type: "assistant",
    sessionId: "sess-1",
    message: { content: [{ type: "thinking", thinking: "secret" }] },
  });
  assert.deepEqual(events.map((event) => event.type), ["runtime.visible_output"]);
});

test("Codex item/started attaches public live from the item kind", () => {
  const event = codexNotificationEvent("item/started", {
    item: { type: "command_execution", command: "hugo --gc", id: "item-1" },
  });
  assert.equal(event?.type, "runtime.tool_started");
  assert.deepEqual(publicLiveOf(event?.payload), { schemaVersion: 1, verb: "run", leaf: "hugo" });
});
