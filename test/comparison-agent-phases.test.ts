import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { ComparisonAgent, type ComparisonContext } from "../src/agents/comparison-agent.js";
import { PiAgentHost, type AgentAuditEvent, type PiTextCaller } from "../src/infrastructure/pi-agent-host.js";

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: { run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" }, models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" }, delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" }, replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" } },
  };
}

test("Comparison Planner and Reporter use isolated sessions and the Reporter may replace the plan", async () => {
  const responses = [
    JSON.stringify({ status: "planned", planPath: "work/comparison-plan.md" }),
    JSON.stringify({ status: "completed", reportPath: "report.html", evidenceRefs: [] }),
  ];
  const sessions: Array<{ input: Parameters<PiTextCaller["createSession"]>[0]; appended: string[] }> = [];
  const comparison = new ComparisonAgent({
    host: new PiAgentHost({ createSession(input) {
      const record = { input, appended: [] as string[] };
      sessions.push(record);
      return { append: async ({ content }) => { record.appended.push(content); return responses.shift() ?? ""; }, cancel() {} };
    } }),
    timeoutMs: 50,
    maxRepairAttempts: 0,
  });
  const planned = await comparison.plan(context());
  const reported = await comparison.report({ ...context(), promptContent: "planStatus=ready\nThe Reporter may reject work/comparison-plan.md." });
  assert.equal(planned.status, "completed");
  assert.equal(reported.status, "completed");
  assert.notEqual(planned.sessionId, reported.sessionId);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.appended.length, 1);
  assert.equal(sessions[1]?.appended.length, 1);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /Planner phase/);
  assert.match(sessions[1]?.input.systemPrompt ?? "", /report a user reads/);
});

test("Host records Pi model input capabilities without inventing a Reprise capability enum", async () => {
  const audit: AgentAuditEvent[] = [];
  let prompt = "";
  const host = new PiAgentHost({ createSession: () => ({
    inputCapabilities: ["text", "image"], append: async ({ content }) => { prompt = content; return JSON.stringify({ ok: true }); }, cancel() {},
  }) });
  const result = await host.request({
    role: "comparison", systemPrompt: "test", context: {}, schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50, maxRepairAttempts: 0, allowModelText: true,
    audit: { append: async (event) => { audit.push(event); } },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(audit.find((event) => event.type === "agent.session_started")?.payload.inputCapabilities, ["text", "image"]);
  assert.match(prompt, /^modelInputCapabilities=text,image\n/);
});

test("Host preserves native image blocks in prompts and tool results without auditing their bytes", async () => {
  const events: AgentAuditEvent[] = [];
  const image = { type: "image" as const, data: Buffer.from("pixel-bytes").toString("base64"), mimeType: "image/png" };
  let promptImageData = "";
  let toolImageData = "";
  const host = new PiAgentHost({ createSession: (input) => ({
    append: async ({ images }) => {
      promptImageData = images?.[0]?.data ?? "";
      const result = await input.tools[0]?.execute({}, new AbortController().signal);
      toolImageData = result?.contentBlocks?.find((block) => block.type === "image")?.data ?? "";
      return JSON.stringify({ ok: true });
    },
    cancel() {},
  }) });
  const result = await host.request({
    role: "test", systemPrompt: "test", context: {}, schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 50, maxRepairAttempts: 0, allowModelText: true, promptImages: [image],
    tools: [{ name: "preview", description: "return an image", parameters: Type.Object({}), execute: async () => ({ content: "image preview", contentBlocks: [{ type: "text", text: "image preview" }, image], details: { evidenceRefs: ["artifact:image-1"] } }) }],
    audit: { append: async (event) => { events.push(event); } },
  });
  assert.equal(result.status, "completed");
  assert.equal(promptImageData, image.data);
  assert.equal(toolImageData, image.data);
  assert.match(JSON.stringify(events), /contentTypes/);
  assert.doesNotMatch(JSON.stringify(events), /cGl4ZWwtYnl0ZXM=/);
  const completed = events.find((event) => event.type === "agent.tool_completed");
  assert.match(String(completed?.payload.contentDigest), /^[a-f0-9]{64}$/);
  assert.deepEqual((completed?.payload.details as { evidenceRefs?: string[] } | undefined)?.evidenceRefs, ["artifact:image-1"]);
});
