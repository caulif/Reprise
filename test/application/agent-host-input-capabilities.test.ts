import test from "node:test";
import assert from "node:assert/strict";
import { AgentHost, type AgentAuditEvent } from "../../src/infrastructure/agent/host.js";
import { Type } from "@sinclair/typebox";

test("text-only sessions strip prompt and tool image blocks; image sessions deliver via outbound/audit", async () => {
  const image = { type: "image" as const, data: Buffer.from("pixel-bytes").toString("base64"), mimeType: "image/png" };
  let textPromptImages: unknown;
  let textToolHasImage = true;
  const textAudit: AgentAuditEvent[] = [];
  const textHost = new AgentHost({
    inputCapabilities: ["text"],
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
    audit: { append: async (event) => { textAudit.push(event); } },
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
  const textAppended = textAudit.find((event) => event.type === "agent.message_appended");
  assert.deepEqual(textAppended?.payload.images, []);
  await textSession.close();

  let imagePromptData = "";
  const imageAudit: AgentAuditEvent[] = [];
  const imageHost = new AgentHost({
    inputCapabilities: ["text", "image"],
    createSession: () => ({
      inputCapabilities: ["text", "image"],
      append: async ({ images }) => {
        imagePromptData = images?.[0]?.data ?? "";
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const imageSession = await imageHost.createSession({
    role: "test",
    systemPrompt: "test",
    audit: { append: async (event) => { imageAudit.push(event); } },
  });
  const imageResult = await imageSession.request({
    schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
    promptContent: "return json",
    promptImages: [image],
  });
  assert.equal(imageResult.status, "completed");
  assert.equal(imagePromptData, image.data);
  const imageAppended = imageAudit.find((event) => event.type === "agent.message_appended");
  const refs = imageAppended?.payload.images as Array<{ contentHash?: string }> | undefined;
  assert.equal(refs?.length, 1);
  assert.match(refs?.[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
  await imageSession.close();
});

test("cancelled text-only image request does not append outbound images", async () => {
  const image = { type: "image" as const, data: Buffer.from("x").toString("base64"), mimeType: "image/png" };
  const audit: AgentAuditEvent[] = [];
  let appendCalled = false;
  const host = new AgentHost({
    inputCapabilities: ["text"],
    createSession: () => ({
      inputCapabilities: ["text"],
      append: async () => {
        appendCalled = true;
        return JSON.stringify({ ok: true });
      },
      cancel() {},
    }),
  });
  const session = await host.createSession({
    role: "test",
    systemPrompt: "test",
    audit: { append: async (event) => { audit.push(event); } },
  });
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
  assert.equal(appendCalled, false);
  assert.equal(audit.some((event) => event.type === "agent.message_appended"), false);
  await session.close();
});
