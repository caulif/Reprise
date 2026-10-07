import assert from "node:assert/strict";
import test from "node:test";
import { createComparisonImageDeliveryRecorder } from "../../src/application/comparison-image-delivery-recorder.js";

const image = (letter = "a") => ({ type: "image", mimeType: "image/png", contentHash: letter.repeat(64), byteLength: 1 });

test("fresh review session discards old delivery and requires its own generation manifest", () => {
  const delivered = new Set<string>();
  const record = createComparisonImageDeliveryRecorder(delivered);
  record({ type: "agent.session_started", payload: { sessionId: "analysis" } });
  record({ type: "agent.model_request", payload: { images: [image()] } });
  assert.ok(delivered.has(image().contentHash));
  record({ type: "agent.session_started", payload: { sessionId: "review" } });
  assert.equal(delivered.size, 0);
  record({ type: "agent.model_request", payload: { scope: "compaction", images: [image()] } });
  assert.equal(delivered.size, 0);
  record({ type: "agent.model_request", payload: { images: [image("b")] } });
  assert.deepEqual([...delivered], [image("b").contentHash]);
  record({ type: "agent.model_request", payload: { images: [] } });
  assert.deepEqual([...delivered], [image("b").contentHash]);
  record({ type: "agent.message_appended", payload: { images: [image()] } });
  assert.equal(delivered.has(image().contentHash), false);
});

test("single-session legacy custom ports retain tool/message image fallback until actual manifest", () => {
  const delivered = new Set<string>();
  const record = createComparisonImageDeliveryRecorder(delivered);
  record({ type: "agent.message_appended", payload: { images: [image()] } });
  record({ type: "agent.tool_completed", payload: { contentTypes: ["image"], body: {
    encoding: "inline", text: JSON.stringify([image("b")]),
  } } });
  assert.deepEqual([...delivered], [image().contentHash, image("b").contentHash]);
  record({ type: "agent.model_request", payload: { scope: "compaction", images: [image("c")] } });
  assert.equal(delivered.has(image("c").contentHash), false);
  record({ type: "agent.model_request", payload: { images: [] } });
  assert.equal(delivered.size, 0);
  record({ type: "agent.session_started", payload: { sessionId: "legacy-review" } });
  record({ type: "agent.message_appended", payload: { images: [image()] } });
  assert.ok(delivered.has(image().contentHash));
  assert.throws(() => record({ type: "agent.model_request", payload: { images: [{ contentHash: "invalid" }] } }),
    /Invalid actual image delivery manifest/);
});
