import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { ComparisonAgent, COMPARISON_TURN_PROMPTS, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { PiAgentHost, type AgentAuditEvent, type PiTextCaller } from "../../src/infrastructure/agent/host.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExperiment } from '../../src/application/experiment.js';
import { input, patientPolicy, VerifiedRuntime } from '../codex-experiment-support.js';

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: { run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" }, models: { candidate: "fixture" }, activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" }, delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" }, replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" } },
  };
}

test('experiment cancellation interrupts Comparison without changing the candidate outcome', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-comparison-cancel-'));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let signal: AbortSignal | undefined;
  const comparison = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, host: new PiAgentHost({ createSession: () => ({
    append: async (request) => {
      signal = request.signal;
      started();
      return new Promise<string>(() => {});
    }, cancel() {},
  }) }) });
  const handle = startExperiment({ ...base, policy: patientPolicy, comparison, deferComparison: true });
  const candidate = await handle.candidateFinished;
  await handle.runComparison();
  await ready;
  await handle.cancel();
  const result = await handle.result;
  assert.equal(signal?.aborted, true);
  assert.equal(result.comparison.result.status, 'cancelled');
  assert.deepEqual(result.record.outcome, candidate.record.outcome);
  const persisted = JSON.parse(await readFile(join(result.experimentRoot, 'comparison.json'), 'utf8')) as { status: string };
  assert.equal(persisted.status, 'cancelled');
});

test("Comparison reuses one Session for an attempt and isolates different attempts", async () => {
  const envelope = JSON.stringify({ status: "completed", reportPath: "report.html", evidenceRefs: [] });
  const sessions: Array<{ input: Parameters<PiTextCaller["createSession"]>[0]; appended: string[] }> = [];
  const comparison = new ComparisonAgent({
    host: new PiAgentHost({ createSession(input) {
      const record = { input, appended: [] as string[] };
      sessions.push(record);
      return { append: async ({ content }) => { record.appended.push(content); return envelope; }, cancel() {} };
    } }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const first = await comparison.compare({ ...context(), attemptId: "attempt-a", promptContent: "short-orientation" });
  const other = await comparison.compare({ ...context(), attemptId: "attempt-b" });
  assert.equal(first.status, "completed");
  assert.equal(other.status, "completed");
  assert.notEqual(first.sessionId, other.sessionId);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.appended.length, 4);
  assert.equal(sessions[1]?.appended.length, 4);
  assert.match(sessions[0]?.appended[0] ?? "", /short-orientation/);
  assert.match(sessions[0]?.appended[0] ?? "", /INDEX\.tsv/);
  assert.match(sessions[0]?.appended[1] ?? "", /briefing\/facts\/context\.json/);
  assert.match(sessions[0]?.appended[2] ?? "", /report\.html/);
  assert.match(sessions[0]?.appended[3] ?? "", /headline/);
  assert.doesNotMatch(sessions[0]?.appended[0] ?? "", /Return only JSON matching the contract/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /四次连续的工作委托/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /configuration/);
  assert.equal(comparison.timeoutMs, 0);
});

test("Comparison freeform turns ignore invalid JSON and only the envelope round validates", async () => {
  const responses = [
    "not-json",
    JSON.stringify({ status: "completed", reportPath: "report.html", evidenceRefs: ["event:foreign-1"] }),
    "drafted report.html",
    JSON.stringify({ status: "completed", reportPath: "report.html", evidenceRefs: [] }),
  ];
  const appended: string[] = [];
  const comparison = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async ({ content }) => {
          appended.push(content);
          return responses.shift() ?? "";
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await comparison.compare(context());
  assert.equal(result.status, "completed");
  assert.equal(appended.length, 4);
  assert.match(appended[0] ?? "", new RegExp(COMPARISON_TURN_PROMPTS.understand.slice(0, 12)));
});

test("Comparison keeps owned observation refs and drops unknown extras", async () => {
  const owned = "event:run-owned-1";
  const keep = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          reportPath: "report.html",
          evidenceRefs: [owned, "event:foreign-1"],
        }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const kept = await keep.compare({ ...context(), ownedEvidenceRefs: [owned] });
  assert.equal(kept.status, "completed");
  if (kept.status === "completed") assert.deepEqual(kept.value.evidenceRefs, [owned]);
  const reject = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          reportPath: "report.html",
          evidenceRefs: ["event:foreign-1"],
        }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const rejected = await reject.compare({ ...context(), ownedEvidenceRefs: [owned] });
  assert.equal(rejected.status, "failed");
  if (rejected.status === "failed") assert.match(rejected.failure.message, /unknown evidence reference/);
});

test("Comparison drops path-shaped evidence refs when none remain owned", async () => {
  const agent = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          reportPath: "report.html",
          evidenceRefs: [String.raw`C:\Temp\clip.png`],
        }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare(context());
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.value.evidenceRefs, []);
});

test("Host records Pi model input capabilities without inventing a Reprise capability enum", async () => {
  const audit: AgentAuditEvent[] = [];
  let prompt = "";
  const host = new PiAgentHost({ createSession: () => ({
    inputCapabilities: ["text", "image"], append: async ({ content }) => { prompt = content; return JSON.stringify({ ok: true }); }, cancel() {},
  }) });
  const result = await host.request({
    role: "comparison", systemPrompt: "test", context: {}, schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000, maxRepairAttempts: 0, allowModelText: true,
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
    timeoutMs: 5_000, maxRepairAttempts: 0, allowModelText: true, promptImages: [image],
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

test("Comparison draft written in round two is readable later in the same Session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-comparison-draft-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { recoveryTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = recoveryTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  let round = 0;
  const comparison = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: (input) => ({
        append: async () => {
          round += 1;
          const write = input.tools.find((tool) => tool.name === "write");
          const read = input.tools.find((tool) => tool.name === "read");
          if (round === 2) {
            await write?.execute({ path: "report.html", content: "<p>draft</p>" }, new AbortController().signal);
          }
          if (round >= 3) {
            const page = await read?.execute({ path: "report.html" }, new AbortController().signal);
            assert.match(page?.content ?? "", /draft/);
          }
          if (round < 4) return "working";
          return JSON.stringify({ status: "completed", reportPath: "report.html", evidenceRefs: [] });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await comparison.compare(context(), tools);
  assert.equal(result.status, "completed");
  assert.equal(round, 4);
  assert.equal(await readFile(join(root, "report.html"), "utf8"), "<p>draft</p>");
});

test("Comparison stops later turns when the first freeform request is cancelled", async () => {
  let appends = 0;
  const ac = new AbortController();
  const comparison = new ComparisonAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async ({ signal }) => {
          appends += 1;
          return await new Promise<string>((_, reject) => {
            const fail = () => reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
            if (signal.aborted) fail();
            else signal.addEventListener("abort", fail, { once: true });
            queueMicrotask(() => ac.abort());
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await comparison.compare(context(), [], undefined, ac.signal);
  assert.equal(result.status, "cancelled");
  assert.equal(appends, 1);
});
