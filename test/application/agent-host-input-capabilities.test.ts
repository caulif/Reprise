import test from "node:test";
import assert from "node:assert/strict";
import { AgentHost } from "../../src/infrastructure/agent/host.js";
import { Type } from "@sinclair/typebox";

test("text-only sessions strip prompt and tool image blocks; image sessions deliver and record hashes", async () => {
  const image = { type: "image" as const, data: Buffer.from("pixel-bytes").toString("base64"), mimeType: "image/png" };
  let textPromptImages: unknown;
  let textToolHasImage = true;
  const textHost = new AgentHost({
    createSession: (input) => ({
      inputCapabilities: ["text"],
      append: async ({ images }) => {
        textPromptImages = images;
        const result = await input.tools[0]?.execute({}, new AbortController().signal);
        textToolHasImage = Boolean(result?.contentBlocks?.some((block) => block.type === "image"));
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const textSession = await textHost.createSession({
    role: "test",
    systemPrompt: "test",
    tools: [{
      name: "preview",
      description: "return an image",
      parameters: Type.Object({}),
      execute: async () => ({
        content: "image preview",
        contentBlocks: [{ type: "text" as const, text: "image preview" }, image],
      }),
    }],
  });
  const textResult = await textSession.request({
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
    promptContent: "return json",
    promptImages: [image],
  });
  assert.equal(textResult.status, "completed");
  assert.equal(textPromptImages, undefined);
  assert.equal(textToolHasImage, false);
  assert.deepEqual(textSession.deliveredImageContentHashes(), []);
  await textSession.close();

  let imagePromptData = "";
  const imageHost = new AgentHost({
    createSession: () => ({
      inputCapabilities: ["text", "image"],
      append: async ({ images }) => {
        imagePromptData = images?.[0]?.data ?? "";
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const imageSession = await imageHost.createSession({ role: "test", systemPrompt: "test" });
  const imageResult = await imageSession.request({
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
    promptContent: "return json",
    promptImages: [image],
  });
  assert.equal(imageResult.status, "completed");
  assert.equal(imagePromptData, image.data);
  assert.equal(imageSession.deliveredImageContentHashes().length, 1);
  assert.match(imageSession.deliveredImageContentHashes()[0] ?? "", /^[a-f0-9]{64}$/);
  await imageSession.close();
});

test("cancelled text-only image request does not deliver images", async () => {
  const image = { type: "image" as const, data: Buffer.from("x").toString("base64"), mimeType: "image/png" };
  const host = new AgentHost({
    createSession: () => ({
      inputCapabilities: ["text"],
      append: async () => JSON.stringify({ ok: true }),
      cancel() {},
    }),
  });
  const session = await host.createSession({ role: "test", systemPrompt: "test" });
  const abort = new AbortController();
  abort.abort();
  const result = await session.request({
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
    promptContent: "return json",
    promptImages: [image],
    signal: abort.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.deepEqual(session.deliveredImageContentHashes(), []);
  await session.close();
});
