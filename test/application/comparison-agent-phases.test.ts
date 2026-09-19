import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { ComparisonAgent, COMPARISON_TURN_PROMPTS, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { AgentHost, type AgentAuditEvent, type ProviderAdapter } from "../../src/infrastructure/agent/host.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExperiment } from '../../src/application/experiment.js';
import { extractHostZoneSnapshot, renderComparisonReportShell } from '../../src/application/comparison-report-shell.js';
import { input, patientPolicy, VerifiedRuntime } from '../codex-experiment-support.js';

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId: "attempt-1",
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
  const comparison = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, host: new AgentHost({ createSession: () => ({
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
  const sessions: Array<{ input: Parameters<ProviderAdapter["createSession"]>[0]; appended: string[] }> = [];
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession(input) {
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
  assert.match(sessions[0]?.input.systemPrompt ?? "", /In this session you will receive, in order/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /最后一轮不能使用工具/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /read_observation/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /configuration/);
  assert.equal(comparison.timeoutMs, 0);
});

test("Comparison refuses to start a Session without attemptId", async () => {
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: () => ({ append: async () => "", cancel() {} }) }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const { attemptId: _omit, ...rest } = context();
  await assert.rejects(
    comparison.compare(rest as ComparisonContext),
    /attemptId is required/,
  );
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
    host: new AgentHost({
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

test("Comparison keeps owned short refs and drops unknown extras", async () => {
  const owned = "ev-01";
  const keep = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          evidenceRefs: [owned, "ev-99", "event:foreign-1"],
        }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const kept = await keep.compare({ ...context(), shortEvidenceRefs: [owned] });
  assert.equal(kept.status, "completed");
  if (kept.status === "completed") assert.deepEqual(kept.value.evidenceRefs, [owned]);
  const reject = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          evidenceRefs: ["ev-99"],
        }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const dropped = await reject.compare({ ...context(), shortEvidenceRefs: [owned] });
  assert.equal(dropped.status, "completed");
  if (dropped.status === "completed") assert.deepEqual(dropped.value.evidenceRefs, []);
});

test("Comparison keeps valid short refs when the Host did not provide an allowlist", async () => {
  const agent = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({ status: "completed", evidenceRefs: ["ev-01", "event:foreign-1"] }),
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare(context());
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.value.evidenceRefs, ["ev-01"]);
});

test("Comparison drops path-shaped evidence refs when none remain owned", async () => {
  const agent = new ComparisonAgent({
    host: new AgentHost({
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
  const host = new AgentHost({ createSession: () => ({
    inputCapabilities: ["text", "image"], append: async ({ content }) => { prompt = content; return JSON.stringify({ ok: true }); }, cancel() {},
  }) });
  const result = await host.request({
    role: "comparison", systemPrompt: "test", schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000, maxRepairAttempts: 0, allowModelText: true,
    promptContent: "return json",
    audit: { append: async (event) => { audit.push(event); } },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(audit.find((event) => event.type === "agent.session_started")?.payload.inputCapabilities, ["text", "image"]);
  assert.match(prompt, /^Native media types this model accepts: text,image\./);
});

test("Host preserves native image blocks in prompts and tool results without auditing their bytes", async () => {
  const events: AgentAuditEvent[] = [];
  const image = { type: "image" as const, data: Buffer.from("pixel-bytes").toString("base64"), mimeType: "image/png" };
  let promptImageData = "";
  let toolImageData = "";
  const host = new AgentHost({
    inputCapabilities: ["text", "image"],
    createSession: (input) => ({
    inputCapabilities: ["text", "image"],
    append: async ({ images }) => {
      promptImageData = images?.[0]?.data ?? "";
      const result = await input.tools[0]?.execute({}, new AbortController().signal);
      toolImageData = result?.contentBlocks?.find((block) => block.type === "image")?.data ?? "";
      return JSON.stringify({ ok: true });
    },
    cancel() {},
  }) });
  const result = await host.request({
    role: "test", systemPrompt: "test", schema: Type.Object({ ok: Type.Boolean() }),
    timeoutMs: 5_000, maxRepairAttempts: 0, allowModelText: true, promptImages: [image],
    promptContent: "return json",
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
  const { workspaceTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = workspaceTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  let round = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({
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

test("compose turn sees the Host metrics shell already on disk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-comparison-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { workspaceTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = workspaceTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  const shell = "<html data-host-shell=\"1\"><section data-host=\"metrics\"></section></html>";
  let round = 0;
  let composeSawShell = false;
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async () => {
          round += 1;
          if (round === 3) {
            const page = await input.tools.find((tool) => tool.name === "read")?.execute({ path: "report.html" }, new AbortController().signal);
            composeSawShell = (page?.content ?? "").includes("data-host=\"metrics\"");
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
  await writeFile(join(root, "report.html"), shell);
  const result = await comparison.compare(context(), tools);
  assert.equal(result.status, "completed");
  assert.equal(composeSawShell, true);
  assert.match(await readFile(join(root, "report.html"), "utf8"), /data-host="metrics"/);
});

test("Comparison stops later turns when the first freeform request is cancelled", async () => {
  let appends = 0;
  const ac = new AbortController();
  const comparison = new ComparisonAgent({
    host: new AgentHost({
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

test("Host zone edits trigger one extra repair turn in the same Session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-host-zone-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { workspaceTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = workspaceTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  const shell = renderComparisonReportShell({
    task: context().task.summary,
    facts: context().reportFacts,
    metrics: {},
  });
  const snapshot = extractHostZoneSnapshot(shell);
  assert.ok(snapshot);
  const prompts: string[] = [];
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          prompts.push(content);
          if (prompts.length === 3) {
            const page = await input.tools.find((tool) => tool.name === "read")?.execute({ path: "report.html" }, new AbortController().signal);
            await input.tools.find((tool) => tool.name === "write")?.execute({
              path: "report.html",
              content: (page?.content ?? shell).replace('data-id="host-header"', 'data-id="host-header" data-edited="1"'),
            }, new AbortController().signal);
          }
          if (content.includes("A Host zone was altered")) {
            await input.tools.find((tool) => tool.name === "write")?.execute({
              path: "report.html",
              content: shell,
            }, new AbortController().signal);
          }
          if (prompts.length < 5) return "working";
          return JSON.stringify({ status: "completed", evidenceRefs: [] });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  await writeFile(join(root, "report.html"), shell);
  const result = await comparison.compare({ ...context(), ...(snapshot ? { hostZoneSnapshot: snapshot } : {}) }, tools);
  assert.equal(result.status, "completed");
  assert.equal(prompts.length, 5);
  assert.match(prompts[3] ?? "", /A Host zone was altered/);
});

test("review turn can read and rewrite Agent regions of report.html", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-comparison-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { workspaceTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = workspaceTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  const shell = renderComparisonReportShell({
    task: context().task.summary,
    facts: context().reportFacts,
    metrics: {},
    slots: { headline: "初稿结论。", "key-differences": "<p>初稿差异</p>" },
  });
  let reviewWrote = false;
  let reviewHadTools = false;
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          if (content.includes("reopen report.html")) {
            reviewHadTools = Boolean(input.tools.find((tool) => tool.name === "read") && input.tools.find((tool) => tool.name === "write"));
            const page = await input.tools.find((tool) => tool.name === "read")?.execute({ path: "report.html" }, new AbortController().signal);
            await input.tools.find((tool) => tool.name === "write")?.execute({
              path: "report.html",
              content: (page?.content ?? shell).replace("初稿差异", "审阅后的差异"),
            }, new AbortController().signal);
            reviewWrote = true;
          }
          if (!content.includes("status")) return "working";
          return JSON.stringify({ status: "completed", evidenceRefs: [], headline: "审阅后的结论。" });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  await writeFile(join(root, "report.html"), shell);
  const result = await comparison.compare(context(), tools);
  assert.equal(result.status, "completed");
  assert.equal(reviewHadTools, true);
  assert.equal(reviewWrote, true);
  assert.match(await readFile(join(root, "report.html"), "utf8"), /审阅后的差异/);
});

test("invalid review JSON is salvaged once without discarding report.html", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-comparison-json-salvage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { workspaceTools } = await import("../../src/infrastructure/recovery-tools.js");
  const tools = workspaceTools(root, {
    allowWrite: (path) => path === "report.html",
    completionPaths: new Set(["report.html"]),
  });
  const shell = renderComparisonReportShell({
    task: context().task.summary,
    facts: context().reportFacts,
    metrics: {},
    slots: { headline: "保留结论。", "key-differences": "<p>保留差异</p>" },
  });
  const pages: string[] = [];
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          pages.push(content);
          if (pages.length === 3) {
            await input.tools.find((tool) => tool.name === "write")?.execute({ path: "report.html", content: shell }, new AbortController().signal);
          }
          if (pages.length < 4) return "working";
          if (pages.length === 4) return "not-json";
          return JSON.stringify({ status: "completed", evidenceRefs: [], headline: "保留结论。" });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  await writeFile(join(root, "report.html"), shell);
  const result = await comparison.compare(context(), tools);
  assert.equal(result.status, "completed");
  assert.equal(pages.length, 5);
  assert.match(pages[4] ?? "", /Do not read or modify report\.html/);
  assert.match(await readFile(join(root, "report.html"), "utf8"), /保留差异/);
});
