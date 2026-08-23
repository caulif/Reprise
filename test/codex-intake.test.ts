import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { CodexIntakeTui } from "../src/tui/intake-app.js";
import {
  defaultHarnessModelConfig,
  saveHarnessModelConfig,
} from "../src/infrastructure/harness-model-config.js";
import { projectTimelineEvent } from "../src/tui/timeline.js";


test("intake discovers only the selected registered product and keeps product caches isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-product-intake-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const summary = (productId: string, id: string) => ({ productId, sessionId: id, sourcePath: join(root, id), startedAt: "2026-08-11T00:00:00.000Z", cwd: "C:/same", summary: id, signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 } });
  const pack = (productId: string, displayName: string, sessions: readonly ReturnType<typeof summary>[]) => ({
    manifest: { productId, displayName, packVersion: "test", schemaVersion: 1 },
    checkAuth: async () => ({ configured: false }),
    sessions: { defaultRoot: root, discover: async () => { calls.push(productId); return { items: sessions, scanned: sessions.length, skipped: 0, diagnostics: [] }; }, inspect: async () => { throw new Error("unused"); }, import: async () => { throw new Error("unused"); } },
  }) as unknown as import("../src/products/contract.js").ProductPack;
  let document: Component | undefined;
  const tui = { addChild(component: Component) { document = component; }, addInputListener() { return () => {}; }, start() {}, stop() {}, requestRender() {}, renderNow() {} } as unknown as TUI;
  const app = new CodexIntakeTui({ dataDir: join(root, "data"), tui, packs: [pack("codex", "Codex", [summary("codex", "codex-1")]), pack("claude-code", "Claude Code", [summary("claude-code", "claude-1")])], privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  await app.start();
  await app.loadSessions();
  assert.deepEqual(calls, []);
  assert.match(document?.render(120).join("\n") ?? "", /Codex[\s\S]*Claude Code/);
  app.selected = 1;
  app.openIntakeSelection();
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ["claude-code"]);
  assert.equal(app.visibleSessions()[0]?.productId, "claude-code");
  assert.equal(app.groupedProjects()[0]?.sessions[0]?.productId, "claude-code");
  app.backToProjects();
  app.selected = 0;
  app.openIntakeSelection();
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["claude-code", "codex"]);
  app.backToProjects();
  app.openIntakeSelection();
  assert.deepEqual(calls, ["claude-code", "codex"]);
});

test("Codex intake TUI uses an ASCII narrow-terminal fallback and states the minimum width", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-narrow-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  const narrow = document?.render(60).join("\n") ?? "";
  assert.match(narrow, /Continue|Browse|\/ command/);
  assert.doesNotMatch(narrow, /[┌┐└┘│─❯●✓…]/);
  assert.match(narrow, /Continue|Browse|Last task/);
  assert.match(narrow.replace(/\u001b\[[0-9;]*m/g, ''), /^Reprise v0\.1\.0/m);
  assert.doesNotMatch(narrow.split("\n")[0] ?? "", /No configured model|gpt-/);
  assert.match(
    narrow.split("\n")[1] ?? "",
    /No configured model|API not configured/,
  );
  assert.match(
    document?.render(31).join("\n") ?? "",
    /Resize to at least 32 columns/,
  );
  app.handleInput("?");
  assert.match(document?.render(60).join("\n") ?? "", /Keys/);
});

test("Codex intake TUI uses framed panels at normal terminal widths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-wide-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  const wide = document?.render(120).join("\n") ?? "";
  assert.match(wide, /Continue|Browse|\/ command/);
  assert.match(wide, /\/config|\/intake|\/run/);
});

test("Codex intake TUI presents session discovery errors instead of rejecting in the background", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-sessions-error-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions-file");
  await writeFile(sessionsRoot, "not a directory");
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /ENOTDIR/.test(rendered));
  assert.match(rendered, /ENOTDIR/);
});

test("Codex intake TUI only reads before explicit freeze and leaves no ambiguous case", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-intake-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  const source = join(sessionsRoot, "rollout-session-1.jsonl");
  const raw =
    [
      {
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1", cwd: "C:/source", cli_version: "0.1.0" },
      },
      {
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-test" },
      },
      {
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Fix the bug." },
      },
      {
        timestamp: "2026-08-11T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Fixed it." },
      },
      {
        timestamp: "2026-08-11T00:00:04.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Verify the regression." },
      },
      {
        timestamp: "2026-08-11T00:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  await writeFile(source, raw);
  const oversized = join(sessionsRoot, "rollout-oversized.jsonl");
  await writeFile(oversized, Buffer.alloc(64 * 1024 * 1024 + 1));

  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });

  await app.start();
  assert.match(rendered, /Continue|Browse|\/ command/);
  assert.match(rendered, /\/intake|i\s+Import a Codex session/);
  await enterIntake(app);
  await waitFor(() => /Fix the bug\./.test(rendered));
  assert.equal(await readFile(source, "utf8"), raw);

  app.handleInput("\r");
  await waitFor(() => /is current/.test(rendered));
  assert.match(rendered, /is current/);
  assert.doesNotMatch(rendered, /Review the session details|Choose task start|Session start:/);
  assert.equal(await readFile(source, "utf8"), raw);
  const caseId = (await readdir(join(root, "data", "cases")))[0];
  assert.ok(caseId);
  assert.match(
    await readFile(
      join(root, "data", "cases", caseId, "case.complete"),
      "utf8",
    ),
    /^$/,
  );
  const frozen = JSON.parse(
    await readFile(join(root, "data", "cases", caseId, "case.json"), "utf8"),
  ) as { initialInput: { text: string } };
  assert.equal(frozen.initialInput.text, "Fix the bug.");
  assert.equal(await readFile(source, "utf8"), raw);
});

async function enterIntake(app: CodexIntakeTui): Promise<void> {
  enterCommand(app, "/intake");
  app.handleInput("\r");
  await waitFor(() => app.intakeLevel === "projects" || app.productDiscovery.get("codex")?.status === "error");
  if (app.intakeLevel === "projects") app.handleInput("\r");
}
function enterCommand(app: CodexIntakeTui, command: string): void {
  app.handleInput(command);
  app.handleInput("\r");
}

async function waitFor(condition: () => boolean): Promise<void> {
  // The full gate runs test files concurrently; allow a busy Windows worker to render before declaring a UI failure.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TUI did not render its expected state.");
}

test("command overlay filters with one SelectList instance until it is dismissed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-command-overlay-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let shown = 0;
  let hidden = 0;
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      document?.render(120);
    },
    renderNow() {
      document?.render(120);
    },
    showOverlay() {
      shown += 1;
      return {
        hide() {
          hidden += 1;
        },
        setHidden() {},
        isHidden() {
          return false;
        },
        focus() {},
        unfocus() {},
        isFocused() {
          return false;
        },
      };
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  app.handleInput("/");
  app.handleInput("c");
  app.handleInput("\b");
  assert.equal(shown, 1);
  assert.equal(hidden, 0);
  app.handleInput("\x1b");
  assert.equal(hidden, 1);
});

test("Codex intake TUI keeps non-command input local and makes help and unknown commands recoverable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-input-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  app.handleInput("explain this task");
  app.handleInput("\r");
  assert.match(rendered, /benchmark workbench/i);
  assert.doesNotMatch(rendered, /explain this task/);
  assert.deepEqual(await readdir(root), []);

  enterCommand(app, "/unknown");
  assert.match(rendered, /Unknown command: \/unknown/);
  enterCommand(app, "/find");
  assert.match(rendered, /Find is available during a replay/);
  app.handleInput("?");
  assert.match(rendered, /Commands: \/config, \/intake, \/run, \/history/);
  app.handleInput("\x1b");
  assert.doesNotMatch(rendered, /This page \(home\)/);
  assert.match(rendered, /Find is available during a replay/);
});

test("Codex intake TUI opens Home without configuration and only enters config on an explicit command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-setup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const piModels = {
    getProviders: () => [{ id: "provider-a", name: "Provider A" }],
    getModels: () => [{ id: "model-a", name: "Model A", input: ["text"] }],
    getModel: () => ({ id: "model-a", name: "Model A", input: ["text"] }),
    getAuth: async () => ({ auth: {}, source: "fixture Pi" }),
    completeSimple: async () => ({
      stopReason: "stop",
      content: [{ type: "text", text: "OK" }],
    }),
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });

  await app.start();
  assert.match(rendered, /Continue|Browse|\/ command/);
  assert.doesNotMatch(rendered, /Harness connection/);
  enterCommand(app, "/config");
  await waitFor(() => /Harness connection/.test(rendered));
  assert.match(rendered, /provider-a/);
  app.handleInput("s");
  await waitFor(() => /Configuration saved locally/.test(rendered));
  assert.deepEqual(
    await readFile(join(root, "data", "harness-model.json"), "utf8").then(
      JSON.parse,
    ),
    {
      schemaVersion: 2,
      provider: { kind: "pi-catalog", id: "provider-a" },
      modelId: "model-a",
      effort: "medium",
    },
  );
  assert.match(rendered, /Continue|Browse|\/ command/);
  enterCommand(app, "/config");
  await waitFor(() => /Harness connection/.test(rendered));
  assert.doesNotMatch(rendered, /Unsaved draft/);
  assert.match(rendered, /Saved locally/);
});

test("Codex intake TUI prefills the historical source, shows current-state limits, live facts, and report summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-workflow-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  await writeFile(
    join(sessionsRoot, "rollout-session-2.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-2", cwd: "C:/not-automatic" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Make a focused change." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "Done." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  let document: Component | undefined;
  let rendered = "";
  let stops = 0;
  let requestedRenders = 0;
  const timelineRenderCallbacks: (() => void)[] = [];
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {
      stops += 1;
    },
    requestRender() {
      requestedRenders += 1;
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  let cancellations = 0;
  let releaseStart: (() => void) | undefined;
  let resolveResult: ((value: unknown) => void) | undefined;
  let sourceRoot = "";
  let allowModelText: boolean | undefined;
  let emitEvent: ((event: unknown) => void) | undefined;
  const fullPublicResponse = `${Array.from({ length: 200 }, (_, index) => `public response line ${index + 1}`).join("\n")}\nPUBLIC_DETAIL_END`;
  const workflow = {
    candidate: {
      candidateId: "codex-luna-high",
      productId: "codex",
      requestedModel: "gpt-5.6-luna",
    },
    preflight: async () => ({
      sourceBaseline: "available",
      resolved: {
        productId: "codex",
        executable: "fixture",
        requestedModel: "gpt-5.6-luna",
        resolvedModel: "gpt-5.6-luna",
      },
      limitations: ["fingerprint differs"],
    }),
    recover: async () => ({
      baseline: { match: "recovered", warnings: [] },
      provider: { discardRecovery: async () => {} },
    }),
    start: async (input: {
      sourceRoot: string;
      onEvent: (event: unknown) => void;
      taskCase?: { privacy?: { allowModelText?: boolean } };
    }) => {
      sourceRoot = input.sourceRoot;
      allowModelText = input.taskCase?.privacy?.allowModelText;
      emitEvent = input.onEvent;
      input.onEvent({
        schemaVersion: 1,
        sequence: 1,
        eventId: "event-1",
        occurredAt: "2026-08-11T00:10:00.000Z",
        type: "run.state_changed",
        payload: { to: "launching" },
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 2,
        eventId: "event-2",
        occurredAt: "2026-08-11T00:10:00.000Z",
        type: "input.submitted",
        payload: { turnIndex: 0, text: "Fix the failing test." },
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 3,
        eventId: "event-3",
        occurredAt: "2026-08-11T00:10:00.500Z",
        type: "codex.turn_started",
        payload: {},
        checksum: "a".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 4,
        eventId: "event-4",
        occurredAt: "2026-08-11T00:10:01.000Z",
        type: "controller.decision",
        payload: {
          status: "completed",
          sessionId: "controller-1",
          value: {
            type: "send",
            rationale: "One check remains.",
            message: "Run the focused test.",
          },
        },
        checksum: "b".repeat(64),
      });
      input.onEvent({
        schemaVersion: 1,
        sequence: 5,
        eventId: "event-5",
        occurredAt: "2026-08-11T00:10:02.000Z",
        type: "codex.item_completed",
        payload: { item: { type: "agentMessage", text: fullPublicResponse } },
        checksum: "c".repeat(64),
      });
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return {
        cancel: async () => {
          cancellations += 1;
        },
        result: new Promise((resolve) => {
          resolveResult = resolve;
        }),
      };
    },
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
    queueTimelineRender: (callback) => { timelineRenderCallbacks.push(callback); },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /Make a focused change\./.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Start isolated Codex Candidate|Environment.*prepared/.test(rendered));
  assert.doesNotMatch(rendered, /Current state|Recovery \(uses model\)|Restore the task start/);
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace|To Codex/.test(rendered));
  await waitFor(() => sourceRoot === "C:/not-automatic");
  app.handleInput("\u0003");
  assert.equal(stops, 0);
  assert.equal(cancellations, 0);
  assert.match(rendered, /Press Ctrl\+C again to force exit/);
  releaseStart?.();
  await waitFor(() => cancellations === 1);
  assert.match(rendered, /Cancellation requested/);
  assert.equal(sourceRoot, "C:/not-automatic");
  assert.equal(allowModelText, false);
  assert.doesNotMatch(rendered, /State: created → launching/);
  assert.match(rendered, /Prompt|To Codex|public response line 1/);
  assert.match(rendered, /public response line 1/);
  assert.equal(timelineRenderCallbacks.length, 1);
  timelineRenderCallbacks.shift()?.();
  requestedRenders = 0;
  for (let sequence = 6; sequence <= 8; sequence += 1) {
    emitEvent?.({
      schemaVersion: 1,
      sequence,
      eventId: `event-${sequence}`,
      occurredAt: "2026-08-11T00:10:03.000Z",
      type: "run.state_changed",
      payload: { to: "waiting" },
      checksum: "d".repeat(64),
    });
  }
  assert.equal(timelineRenderCallbacks.length, 1);
  timelineRenderCallbacks.shift()?.();
  assert.equal(requestedRenders, 1);
  app.handleInput("/");
  for (const ch of "public response") app.handleInput(ch);
  assert.match(rendered, /Find:/);
  assert.match(rendered, /public response line 1/);
  assert.doesNotMatch(rendered, /Fix the failing test/);
  app.handleInput("\x1b");
  assert.match(rendered, /Fix the failing test|Prompt|To Codex/);
  assert.match(rendered, /public response line 1/);
  assert.doesNotMatch(rendered, /Find:/);
  app.handleInput("f");
  assert.match(rendered, /To Codex|Codex screen|to Codex/);
  assert.doesNotMatch(rendered, /State: created → launching/);
  assert.match(rendered, /public response line 1|Visible response/);
  assert.match(
    projectTimelineEvent({
      schemaVersion: 1,
      sequence: 5,
      eventId: "event-5",
      occurredAt: "2026-08-11T00:10:02.000Z",
      type: "codex.item_completed",
      payload: { item: { type: "agentMessage", text: fullPublicResponse } },
      checksum: "c".repeat(64),
    })[0]?.original ?? "",
    /PUBLIC_DETAIL_END/,
  );
  app.handleInput("pageUp");
  app.handleInput("l");
  assert.match(rendered, /Following latest/);
  // Test seam intentionally supplies a partial result; the TUI must not assume optional display data exists.
  resolveResult?.({
    reportPath: join(root, "data", "experiments", "fixture", "report.html"),
    record: {
      attempt: { runId: "run-1" },
      outcome: {
        termination: {
          kind: "completed",
          code: "completed.controller_satisfied",
        },
        cleanup: { status: "complete" },
      },
    },
    decision: { value: { type: "done" }, usedFallback: false },
    comparison: { result: { usedFallback: false } },
    recovery: {
      value: { status: "ready_for_provider_validation" },
      usedFallback: false,
    },
  });
  await waitFor(() => /Experiment finished/.test(rendered));
  assert.match(rendered, /report\.html/);
  app.handleInput("\u0003");
  assert.equal(stops, 1);
});

test("Codex intake TUI automatically prepares every session with Recovery before the single run confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-recovery-retry-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  await writeFile(
    join(sessionsRoot, "rollout-session-recovery.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-recovery", cwd: "C:/recovery-source" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Restore the task start." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  let recoveryCalls = 0;
  let discarded = 0;
  const provider = {
    discardRecovery: async () => {
      discarded += 1;
    },
  };
  const workflow = {
    candidate: {
      candidateId: "recovery-fixture",
      productId: "codex",
      requestedModel: "fixture",
    },
    preflight: async () => ({
      sourceBaseline: "available",
      resolved: {
        productId: "codex",
        executable: "fixture",
        requestedModel: "fixture",
        resolvedModel: "fixture",
      },
      limitations: [],
      comparisonClass: "observational",
      contamination: {
        timeline: {
          sessionEndedAt: "2026-08-11T00:00:02.000Z",
          sourceLastModifiedAt: "2026-08-11T00:10:00.000Z",
        },
      },
    }),
    recover: async () => ({
      baseline: { match: "recovered", warnings: [] },
      staging: { recoveryId: `recovery-${++recoveryCalls}` },
      provider,
    }),
    start: async () => ({
      cancel: async () => {},
      result: Promise.resolve({
        reportPath: join(root, "data", "experiments", "fixture", "report.html"),
        record: {
          attempt: { runId: "run-1" },
          outcome: {
            termination: {
              kind: "completed",
              code: "completed.controller_satisfied",
            },
            cleanup: { status: "complete" },
          },
        },
        decision: { value: { type: "done" }, usedFallback: false },
        comparison: { result: { usedFallback: false } },
      }),
    }),
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /Restore the task start/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Start isolated Codex Candidate|Environment.*prepared/.test(rendered));
  assert.equal(recoveryCalls, 1);
  assert.doesNotMatch(rendered, /Current state|Recovery \(uses model\)|Recovery preview is ready/);
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace|Experiment finished/.test(rendered));
  assert.equal(discarded, 0);
});

test("Codex intake TUI force-closes on a second Ctrl+C during cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-force-close-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  await writeFile(
    join(sessionsRoot, "rollout-session-cancel.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-cancel", cwd: "C:/source" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Cancel this run." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  let document: Component | undefined;
  let rendered = "";
  let stops = 0;
  let cancelCalls = 0;
  let releaseStart: (() => void) | undefined;
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {
      stops += 1;
    },
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const workflow = {
    candidate: {
      candidateId: "cancel-fixture",
      productId: "codex",
      requestedModel: "fixture",
    },
    preflight: async () => ({
      sourceBaseline: "available",
      resolved: {
        productId: "codex",
        executable: "fixture",
        requestedModel: "fixture",
        resolvedModel: "fixture",
      },
      limitations: [],
    }),
    recover: async () => ({
      baseline: { match: "recovered", warnings: [] },
      provider: { discardRecovery: async () => {} },
    }),
    start: async () => {
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return {
        cancel: async () => {
          cancelCalls += 1;
        },
        result: new Promise(() => {}),
      };
    },
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /Cancel this run/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Start isolated Codex Candidate|Environment.*prepared/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace/.test(rendered));
  app.handleInput("\u0003");
  releaseStart?.();
  await waitFor(() => cancelCalls === 1);
  assert.match(rendered, /Press Ctrl\+C again to force exit/);
  app.handleInput("\u0003");
  assert.equal(stops, 1);
});

test("Codex intake TUI asks for a source path only when historical cwd is missing, then starts on Enter", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-source-missing-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await saveHarnessModelConfig(join(root, "data"), defaultHarnessModelConfig());
  await writeFile(
    join(sessionsRoot, "rollout-session-nocwd.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-nocwd" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Patch the missing path." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  let sourceRoot = "";
  let releaseStart: (() => void) | undefined;
  const workflow = {
    candidate: {
      candidateId: "codex-luna-high",
      productId: "codex",
      requestedModel: "gpt-5.6-luna",
    },
    preflight: async () => ({
      sourceBaseline: "available",
      resolved: {
        productId: "codex",
        executable: "fixture",
        requestedModel: "gpt-5.6-luna",
        resolvedModel: "gpt-5.6-luna",
      },
      limitations: [],
    }),
    recover: async () => ({
      baseline: { match: "recovered", warnings: [] },
      provider: { discardRecovery: async () => {} },
    }),
    start: async (input: {
      sourceRoot: string;
      onEvent: (event: unknown) => void;
    }) => {
      sourceRoot = input.sourceRoot;
      await new Promise<void>((resolve) => {
        releaseStart = resolve;
      });
      return {
        cancel: async () => {},
        result: Promise.resolve({
          reportPath: join(
            root,
            "data",
            "experiments",
            "fixture",
            "report.html",
          ),
          record: {
            attempt: { runId: "run-1" },
            outcome: {
              termination: {
                kind: "completed",
                code: "completed.controller_satisfied",
              },
              cleanup: { status: "complete" },
            },
          },
          decision: { value: { type: "done" }, usedFallback: false },
          comparison: { result: { usedFallback: false } },
        }),
      };
    },
  } as never;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });
  await app.start();
  await enterIntake(app);
  await waitFor(() => /Patch the missing path/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Source root|Historical cwd is missing/.test(rendered));
  assert.match(rendered, /Source root/);
  assert.match(rendered, /Historical cwd is missing/);
  app.handleInput("b");
  assert.match(rendered, /│ b▌/);
  assert.doesNotMatch(rendered, /Welcome \/ Recent runs/);
  app.handleInput("\x1b[D");
  app.handleInput("a");
  assert.match(rendered, /│ a▌b/);
  app.handleInput("\x1b[F");
  app.handleInput("\b");
  app.handleInput("\b");
  app.handleInput("C:\\explicit-source");
  app.handleInput("\r");
  await waitFor(() => /Start isolated Codex Candidate|Environment.*prepared/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace|To Codex/.test(rendered));
  releaseStart?.();
  await waitFor(() => sourceRoot === "C:\\explicit-source");
  assert.equal(sourceRoot, "C:\\explicit-source");
});

test("Codex intake TUI browses validated local history and selects a TaskCase without reopening source sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-history-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const casesRoot = join(dataDir, "cases", "case-history");
  const experimentsRoot = join(dataDir, "experiments", "exp-history");
  await mkdir(casesRoot, { recursive: true });
  await mkdir(join(experimentsRoot, "runs", "run-history"), {
    recursive: true,
  });
  const taskCase = {
    schemaVersion: 1,
    caseId: "case-history",
    source: { productId: "codex", sessionId: "session-history" },
    initialInput: {
      id: "input-history",
      role: "user",
      text: "Inspect a focused regression.",
    },
    transcript: [
      {
        id: "input-history",
        role: "user",
        text: "Inspect a focused regression.",
      },
    ],
    historicalEvents: [],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: {
      packVersion: "1",
      importedAt: "2026-08-11T00:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  await writeFile(join(casesRoot, "case.json"), JSON.stringify(taskCase));
  await writeFile(
    join(experimentsRoot, "experiment.json"),
    JSON.stringify({
      spec: {
        experimentId: "exp-history",
        taskCaseId: "case-history",
        candidates: [
          {
            candidateId: "codex-history",
            productId: "codex",
            requestedModel: "gpt-history",
          },
        ],
        recovery: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        controller: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        comparison: {
          providerId: "provider",
          requestedModel: "model",
          budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 },
        },
        runPolicy: {
          wallClockMs: 1,
          maxTargetTurns: 1,
          maxModelCalls: 1,
          turnTimeoutMs: 1,
          maxConsecutiveNoProgress: 1,
        },
        outputRoot: experimentsRoot,
      },
      runIds: ["run-history"],
    }),
  );
  await writeFile(
    join(experimentsRoot, "runs", "run-history", "record.json"),
    JSON.stringify({
      schemaVersion: 1,
      attempt: {
        schemaVersion: 1,
        runId: "run-history",
        experimentId: "exp-history",
        caseId: "case-history",
        candidate: {
          candidateId: "codex-history",
          productId: "codex",
          requestedModel: "gpt-history",
        },
        policy: {
          wallClockMs: 1,
          maxTargetTurns: 1,
          maxModelCalls: 1,
          turnTimeoutMs: 1,
          maxConsecutiveNoProgress: 1,
        },
        createdAt: "2026-08-11T01:00:00.000Z",
      },
      manifest: {
        schemaVersion: 1,
        attempt: {
          schemaVersion: 1,
          runId: "run-history",
          experimentId: "exp-history",
          caseId: "case-history",
          candidate: {
            candidateId: "codex-history",
            productId: "codex",
            requestedModel: "gpt-history",
          },
          policy: {
            wallClockMs: 1,
            maxTargetTurns: 1,
            maxModelCalls: 1,
            turnTimeoutMs: 1,
            maxConsecutiveNoProgress: 1,
          },
          createdAt: "2026-08-11T01:00:00.000Z",
        },
        resolvedModel: { requested: "gpt-history", resolved: "gpt-history" },
        runtime: { productId: "codex", executable: "fixture" },
        environment: { environmentId: "env-history", workspacePath: "fixture" },
        recovery: {
          providerId: "provider",
          requestedModel: "model",
          configHash: "c".repeat(64),
          promptVersion: "v1",
          toolPolicy: "read",
          contextPolicy: "v1",
        },
        controller: {
          providerId: "provider",
          requestedModel: "model",
          configHash: "c".repeat(64),
          promptVersion: "v1",
          toolPolicy: "read",
          contextPolicy: "v1",
        },
        comparison: {
          providerId: "provider",
          requestedModel: "model",
          configHash: "c".repeat(64),
          promptVersion: "v1",
          toolPolicy: "read",
          contextPolicy: "v1",
        },
        startedAt: "2026-08-11T01:00:00.000Z",
      },
      outcome: {
        termination: {
          kind: "completed",
          code: "completed.controller_satisfied",
        },
        cleanup: { status: "complete" },
      },
      artifactRefs: [],
    }),
  );
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir,
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  enterCommand(app, "/history");
  await waitFor(() => /Recent experiments/.test(rendered));
  assert.match(rendered, /exp-history/);
  app.handleInput("\t");
  assert.match(rendered, /TaskCases/);
  app.handleInput("\r");
  assert.match(rendered, /TaskCase: case-history/);
  app.handleInput("\r");
  assert.match(rendered, /TaskCase case-history/);
});

test("Codex intake TUI saves an OpenAI-compatible draft without a secret or connection request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-custom-config-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  const replaceField = (value: string) => {
    app.handleInput("\u0015");
    app.handleInput(value);
    app.handleInput("\r");
  };
  await app.start();
  enterCommand(app, "/config");
  await waitFor(() => /Harness connection/.test(rendered));
  app.handleInput("\r"); // provider type: pi catalog -> OpenAI-compatible
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("private-gateway");
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("https://api.example.test/v1");
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("model-private");
  app.handleInput("\u001b[B"); // effort, deliberately retain default
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("env:REPRISE_PRIVATE_KEY");
  app.handleInput("s");
  await waitFor(() => /Configuration saved locally/.test(rendered));
  const saved = await readFile(
    join(root, "data", "harness-model.json"),
    "utf8",
  );
  assert.deepEqual(JSON.parse(saved), {
    schemaVersion: 2,
    provider: { kind: "openai-compatible", id: "private-gateway" },
    modelId: "model-private",
    effort: "medium",
    baseUrl: "https://api.example.test/v1",
    keyRef: "env:REPRISE_PRIVATE_KEY",
  });
  assert.doesNotMatch(saved, /actual-secret-value/);
  assert.doesNotMatch(rendered, /actual-secret-value/);
  assert.match(rendered, /REPRISE_PRIVATE_KEY is not set/);
});

test("intake search accepts a slash after search has started", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-search-slash-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    join(sessionsRoot, "rollout-session-search.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-search", cwd: "C:/source" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Search me." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  await enterIntake(app);
  await waitFor(() =>
    /Choose a historical session|Choose a project/.test(rendered),
  );
  app.handleInput("/");
  app.handleInput("/");
  app.handleInput("src");
  assert.match(rendered, /Search: \/src/);
});

test("TUI language defaults to English and /lang zh switches the cover without mixing copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-tui-lang-"));
  t.after(async () =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  );
  let document: Component | undefined;
  let rendered = "";
  const tui = {
    addChild(component: Component) {
      document = component;
    },
    addInputListener() {
      return () => {};
    },
    start() {},
    stop() {},
    requestRender() {
      rendered = document?.render(120).join("\n") ?? "";
    },
    renderNow() {
      rendered = document?.render(120).join("\n") ?? "";
    },
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  assert.match(rendered, /Continue/);
  assert.match(rendered, /Browse/);
  assert.doesNotMatch(rendered, /继续|浏览|当前任务/);
  enterCommand(app, "/lang zh");
  await waitFor(() => /继续/.test(rendered));
  assert.match(rendered, /继续/);
  assert.match(rendered, /浏览/);
  assert.match(rendered, /语言：中文/);
  assert.doesNotMatch(rendered, /Continue|Browse|Last task/);
  enterCommand(app, "/config");
  await waitFor(() => /语言/.test(rendered));
  assert.match(rendered, /语言/);
  assert.match(rendered, /中文/);
  assert.doesNotMatch(rendered, /Harness connection|Language/);
});