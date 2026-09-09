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
import { IntakeTui } from "../src/tui/intake-app.js";
import {
  defaultHarnessModelConfig,
  saveHarnessModelConfig,
} from "../src/infrastructure/harness-model-config.js";
import { projectTimelineEvent } from "../src/tui/timeline.js";

import { enterIntake, enterCommand, waitFor, advanceCandidatePicker, fixtureCatalog } from "./codex-intake-support.js";

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
  const app = new IntakeTui({
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
  const app = new IntakeTui({
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
  enterCommand(app, "/run");
  assert.match(rendered, /Unknown command: \/run/);
  app.handleInput("?");
  assert.match(rendered, /Commands: \/intake, \/history, \/config, \/lang, \/help/);
  app.handleInput("\x1b");
  assert.doesNotMatch(rendered, /This page \(home\)/);
  assert.match(rendered, /Unknown command: \/run/);
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
  const app = new IntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot: join(root, "sessions"),
    tui,
    piModels,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });

  await app.start();
  assert.match(rendered, /Continue|Browse|\/ command/);
  assert.doesNotMatch(rendered, /Configuration file:|\.reprise\/harness-model\.json/);
  enterCommand(app, "/config");
  await waitFor(() => /Internal Agent model/.test(rendered));
  assert.match(rendered, /openai-compatible/);
  app.handleInput("\u001b[A");
  app.handleInput("\u001b[A");
  app.handleInput("\u001b[A");
  app.handleInput("\r");
  assert.match(rendered, /provider-a/);
  app.handleInput("\x13");
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
  await waitFor(() => /Internal Agent model/.test(rendered));
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
    ...fixtureCatalog,
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
      accept: async () => ({ match: "recovered", warnings: [] }),
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
      input.onEvent({
        schemaVersion: 1,
        sequence: 6,
        eventId: "event-6",
        occurredAt: "2026-08-11T00:10:02.000Z",
        type: "runtime.public_activity",
        payload: {
          schemaVersion: 1,
          sourceEventId: "event-5",
          sourceEventType: "codex.item_completed",
          activity: { kind: "message", text: fullPublicResponse },
        },
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
  const app = new IntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    autoCompare: true,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
    queueTimelineRender: (callback) => { timelineRenderCallbacks.push(callback); },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /Make a focused change\./.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Session start:/.test(rendered));
  app.handleInput("\r");
  await advanceCandidatePicker(app, () => rendered);
  assert.doesNotMatch(rendered, /Current state|Recovery \(uses model\)|Restore the task start/);
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace|To Codex/.test(rendered));
  await waitFor(() => sourceRoot === "C:/not-automatic");
  emitEvent?.({ schemaVersion: 1, sequence: 6, eventId: 'shared-delivery', occurredAt: '2026-08-11T00:10:03.000Z', type: 'runtime.delivery_observed', payload: { status: 'accepted' }, checksum: 'd'.repeat(64) });
  assert.equal(app.runPhase, 'candidate_generating');
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
  assert.match(rendered, /Fix the failing test/);
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
      type: "runtime.public_activity",
      payload: {
        schemaVersion: 1,
        sourceEventId: "event-5",
        sourceEventType: "codex.item_completed",
        activity: { kind: "message", text: fullPublicResponse },
      },
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
        task: { status: 'apparently_completed' },
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
  app.handleInput('\x1b');
  assert.equal(app.page, 'home');
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
    ...fixtureCatalog,
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
      accept: async () => ({ match: "recovered", warnings: [] }),
    }),
    start: async () => ({
      cancel: async () => {},
      result: Promise.resolve({
        reportPath: join(root, "data", "experiments", "fixture", "report.html"),
        record: {
          attempt: { runId: "run-1" },
          outcome: {
            task: { status: 'apparently_completed' },
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
  const app = new IntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    autoCompare: true,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });

  await app.start();
  await enterIntake(app);
  await waitFor(() => /Restore the task start/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Session start:/.test(rendered));
  app.handleInput("\r");
  await advanceCandidatePicker(app, () => rendered);
  assert.equal(recoveryCalls, 1);
  assert.doesNotMatch(rendered, /Current state|Recovery \(uses model\)|Recovery preview is ready/);
  app.handleInput("\r");
  await waitFor(() => /Preparing replay|Copy isolated workspace|Experiment finished/.test(rendered));
  assert.equal(discarded, 0);
});
