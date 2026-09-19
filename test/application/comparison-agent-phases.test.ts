import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "@sinclair/typebox";
import { ComparisonAgent, COMPARISON_SYSTEM_PROMPT, COMPARISON_TURN_PROMPTS, type ComparisonContext } from "../../src/agents/comparison-agent.js";
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
  assert.match(sessions[0]?.appended[0] ?? "", /user-input/);
  assert.match(sessions[0]?.appended[1] ?? "", /Investigate the questions/);
  assert.match(sessions[0]?.appended[2] ?? "", /data-agent-zone="comparison"/);
  assert.match(sessions[0]?.appended[3] ?? "", /preview_report/);
  assert.doesNotMatch(sessions[0]?.appended[0] ?? "", /Return only JSON matching the contract/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /In this session you will receive, in order/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /render_artifact/);
  assert.match(sessions[0]?.input.systemPrompt ?? "", /register_evidence/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /最后一轮不能使用工具/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /read_observation/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /pair-pages/);
  assert.doesNotMatch(sessions[0]?.input.systemPrompt ?? "", /at most three bullets/);
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

test("Comparison keeps owned short refs and rejects unknown extras without silent drop", async () => {
  const owned = "ev-01";
  const keep = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async () => JSON.stringify({
          status: "completed",
          evidenceRefs: [owned],
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

  const prompts: string[] = [];
  const reject = new ComparisonAgent({
    host: new AgentHost({
      createSession: () => ({
        append: async ({ content }) => {
          prompts.push(content);
          if (prompts.length < 4) return "working";
          if (prompts.length === 4) {
            return JSON.stringify({
              status: "completed",
              evidenceRefs: ["ev-99"],
            });
          }
          return JSON.stringify({
            status: "completed",
            evidenceRefs: [owned],
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 1,
  });
  const repaired = await reject.compare({ ...context(), shortEvidenceRefs: [owned] }, [{
    name: "read",
    description: "read",
    parameters: Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
    execute: async () => ({ content: "<html><body>draft</body></html>" }),
  }]);
  assert.equal(repaired.status, "completed");
  if (repaired.status === "completed") assert.deepEqual(repaired.value.evidenceRefs, [owned]);
  assert.equal(prompts.length, 5);
  assert.match(prompts[4] ?? "", /Do not read or modify report\.html/);
  assert.doesNotMatch(prompts[4] ?? "", /register_evidence|preview_report|render_artifact/);
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

test("Comparison envelope uses live getEvidenceCatalog refs registered mid-session", async () => {
  const catalog = { shortEvidenceRefs: ["ev-01"] as string[] };
  const prompts: string[] = [];
  const catalogOptions = {
    getEvidenceCatalog: () => ({
      links: catalog.shortEvidenceRefs.map((shortRef) => ({
        side: "candidate" as const,
        inspectPath: "candidate/a",
        shortRef,
      })),
      media: [],
    }),
  };
  const agent = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          prompts.push(content);
          if (prompts.length === 2) {
            const register = input.tools.find((tool) => tool.name === "register_evidence");
            const result = await register?.execute({ path: "scratch/note.txt", sourceRefs: ["ev-01"], label: "check" }, new AbortController().signal);
            assert.match(result?.content ?? "", /ev-02/);
            catalog.shortEvidenceRefs = ["ev-01", "ev-02"];
          }
          if (prompts.length < 4) return "working";
          return JSON.stringify({ status: "completed", evidenceRefs: ["ev-02"], headline: "Registered mid-session." });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare({
    ...context(),
    shortEvidenceRefs: ["ev-01"],
  }, [{
    name: "register_evidence",
    description: "register",
    parameters: Type.Object({
      path: Type.String(),
      sourceRefs: Type.Array(Type.String()),
      label: Type.String(),
    }),
    execute: async () => ({ content: "registered ev-02 revision=2" }),
  }], undefined, undefined, catalogOptions);
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.deepEqual(result.value.evidenceRefs, ["ev-02"]);
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
    slots: { headline: "初稿结论。", "comparison": "<p>初稿差异</p>" },
  });
  let reviewWrote = false;
  let reviewHadTools = false;
  const comparison = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          if (content.includes("preview_report")) {
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
    slots: { headline: "保留结论。", "comparison": "<p>保留差异</p>" },
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

test("B7 loop: investigate registers evidence, compose fills comparison zone, review previews and cites new refs", async () => {
  const catalog = { shortEvidenceRefs: ["ev-01"] as string[], revision: 1 };
  let previewCalls = 0;
  let previewDigest = "digest-v1";
  let reportBody = [
    "<html><body>",
    '<section data-host-zone="metrics">host-metrics</section>',
    '<section data-agent-zone="comparison"></section>',
    "</body></html>",
  ].join("");
  const toolCalls: string[] = [];
  const prompts: string[] = [];
  const tools = [
    {
      name: "register_evidence",
      description: "register derived evidence",
      parameters: Type.Object({
        path: Type.String(),
        sourceRefs: Type.Array(Type.String()),
        label: Type.String(),
      }),
      execute: async () => {
        toolCalls.push("register_evidence");
        catalog.revision += 1;
        catalog.shortEvidenceRefs = [...catalog.shortEvidenceRefs, "ev-02"];
        return { content: `registered ev-02 revision=${catalog.revision}` };
      },
    },
    {
      name: "render_artifact",
      description: "render registered artifact",
      parameters: Type.Object({ sourceRef: Type.String() }),
      execute: async () => {
        toolCalls.push("render_artifact");
        catalog.revision += 1;
        catalog.shortEvidenceRefs = [...catalog.shortEvidenceRefs, "media-01"];
        return { content: `rendered media-01 revision=${catalog.revision}` };
      },
    },
    {
      name: "preview_report",
      description: "preview draft report",
      parameters: Type.Object({}),
      execute: async () => {
        toolCalls.push("preview_report");
        previewCalls += 1;
        return {
          content: JSON.stringify({
            status: "ok",
            reportDigest: previewDigest,
            catalogRevision: catalog.revision,
            assetsLoad: true,
            hostMetricsVisible: reportBody.includes("host-metrics"),
          }),
        };
      },
    },
    {
      name: "read",
      description: "read",
      parameters: Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
      execute: async ({ path }: { path: string }) => ({
        content: path === "report.html" ? reportBody : "",
      }),
    },
    {
      name: "write",
      description: "write",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async ({ path, content }: { path: string; content: string }) => {
        if (path === "report.html") reportBody = content;
        return { content: "ok" };
      },
    },
  ];
  const agent = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          prompts.push(content);
          const round = prompts.length;
          if (round === 2) {
            await input.tools.find((t) => t.name === "register_evidence")?.execute(
              { path: "scratch/check.txt", sourceRefs: ["ev-01"], label: "diff check" },
              new AbortController().signal,
            );
            await input.tools.find((t) => t.name === "render_artifact")?.execute(
              { sourceRef: "ev-01" },
              new AbortController().signal,
            );
            return "investigated";
          }
          if (round === 3) {
            await input.tools.find((t) => t.name === "write")?.execute({
              path: "report.html",
              content: [
                "<html><body>",
                '<section data-host-zone="metrics">host-metrics</section>',
                '<section data-agent-zone="comparison">',
                '<p>Decisive difference with <a data-evidence-ref="ev-02">check</a>.</p>',
                '<img data-media-ref="media-01" alt="preview">',
                "</section>",
                '<section data-agent-zone="details"><p>methods</p></section>',
                "</body></html>",
              ].join(""),
            }, new AbortController().signal);
            return "composed";
          }
          if (content.includes("preview_report")) {
            const first = await input.tools.find((t) => t.name === "preview_report")?.execute({}, new AbortController().signal);
            assert.match(first?.content ?? "", /digest-v1/);
            // Edit after preview — must re-check.
            await input.tools.find((t) => t.name === "write")?.execute({
              path: "report.html",
              content: reportBody.replace("Decisive difference", "Updated decisive difference"),
            }, new AbortController().signal);
            previewDigest = "digest-v2";
            const second = await input.tools.find((t) => t.name === "preview_report")?.execute({}, new AbortController().signal);
            assert.match(second?.content ?? "", /digest-v2/);
            return JSON.stringify({
              status: "completed",
              headline: "Updated decisive difference.",
              evidenceRefs: ["ev-02"],
            });
          }
          return "working";
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare({
    ...context(),
    shortEvidenceRefs: ["ev-01"],
  }, tools, undefined, undefined, {
    getEvidenceCatalog: () => ({
      links: catalog.shortEvidenceRefs.map((shortRef) => ({
        side: "candidate" as const,
        inspectPath: "candidate/a",
        shortRef,
      })),
      media: [],
    }),
  });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.deepEqual(result.value.evidenceRefs, ["ev-02"]);
    assert.equal(result.value.headline, "Updated decisive difference.");
  }
  assert.deepEqual(toolCalls.filter((name) => name === "register_evidence"), ["register_evidence"]);
  assert.deepEqual(toolCalls.filter((name) => name === "render_artifact"), ["render_artifact"]);
  assert.equal(previewCalls, 2);
  assert.match(reportBody, /data-agent-zone="comparison"/);
  assert.match(reportBody, /Updated decisive difference/);
  assert.match(reportBody, /data-evidence-ref="ev-02"/);
  assert.match(prompts[1] ?? "", /Investigate the questions/);
  assert.match(prompts[2] ?? "", /data-agent-zone="comparison"/);
  assert.match(prompts[3] ?? "", /preview_report/);
});

test("B7 review: text-only session records limitation and omits visual claims", async () => {
  let previewResult = "";
  const agent = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          if (!content.includes("status")) return "working";
          const preview = await input.tools.find((t) => t.name === "preview_report")?.execute({}, new AbortController().signal);
          previewResult = preview?.content ?? "";
          return JSON.stringify({
            status: "insufficient_evidence",
            headline: "Cannot visually verify; mechanical preview only.",
            evidenceRefs: ["ev-01"],
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare({ ...context(), shortEvidenceRefs: ["ev-01"] }, [
    {
      name: "preview_report",
      description: "preview",
      parameters: Type.Object({}),
      execute: async () => ({
        content: JSON.stringify({
          status: "ok",
          imageInspection: "unavailable",
          reason: "text-only session",
          hostMetricsVisible: true,
        }),
      }),
    },
    {
      name: "read",
      description: "read",
      parameters: Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
      execute: async () => ({ content: "<html><body><section data-agent-zone=\"comparison\"><p>table only</p></section></body></html>" }),
    },
  ]);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.value.status, "insufficient_evidence");
    assert.doesNotMatch(result.value.headline ?? "", /data-claim="visual"/);
  }
  assert.match(previewResult, /text-only session/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /Do not claim visual inspection/);
  assert.match(COMPARISON_SYSTEM_PROMPT, /do not make visual-quality claims/);
});

test("B7 review: tool failure surfaces a concrete limitation without inventing observation", async () => {
  const prompts: string[] = [];
  const agent = new ComparisonAgent({
    host: new AgentHost({
      createSession: (input) => ({
        append: async ({ content }) => {
          prompts.push(content);
          if (!content.includes("status")) return "working";
          const preview = await input.tools.find((t) => t.name === "preview_report")?.execute({}, new AbortController().signal);
          assert.match(preview?.content ?? "", /capability_unavailable/);
          return JSON.stringify({
            status: "insufficient_evidence",
            headline: "Preview unavailable: no browser.",
            evidenceRefs: [],
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const result = await agent.compare(context(), [
    {
      name: "preview_report",
      description: "preview",
      parameters: Type.Object({}),
      execute: async () => ({
        content: JSON.stringify({ status: "capability_unavailable", reason: "no browser" }),
      }),
    },
    {
      name: "read",
      description: "read",
      parameters: Type.Object({ path: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
      execute: async () => ({ content: "<html></html>" }),
    },
  ]);
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.value.status, "insufficient_evidence");
    assert.match(result.value.headline ?? "", /no browser/i);
  }
  assert.match(COMPARISON_TURN_PROMPTS.review, /record the specific\s+review limitation/);
});

test("Host-zone repair prompt names comparison and details agent zones", () => {
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-agent-zone="comparison"/);
  assert.match(COMPARISON_TURN_PROMPTS.compose, /data-agent-zone="details"/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /pair-pages/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.compose, /visual-evidence/);
  assert.doesNotMatch(COMPARISON_TURN_PROMPTS.review, /reopen report\.html and review/);
  assert.match(COMPARISON_TURN_PROMPTS.review, /preview_report/);
});
