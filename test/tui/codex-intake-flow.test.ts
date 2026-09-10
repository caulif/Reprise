import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { IntakeTui } from "../../src/tui/intake-app.js";
import {
  defaultHarnessModelConfig,
  saveHarnessModelConfig,
} from "../../src/infrastructure/harness-model-config.js";

import { enterIntake, enterCommand, waitFor, advanceCandidatePicker, fixtureCatalog } from "../codex-intake-support.js";

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
    ...fixtureCatalog,
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
      experimentId: "cancel-fixture",
      experimentRoot: "unused",
      baseline: { match: "recovered", warnings: [] },
      recovery: { status: "completed", sessionId: "s", value: { status: "ready", reportPath: "recovery.md", unresolved: [] } },
      accept: async () => ({ match: "recovered", warnings: [] }),
    }),
    acceptRecovery: async () => ({ match: "recovered", warnings: [] }),
    discardRecovery: async () => {},
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
  await waitFor(() => /Cancel this run/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Session start:/.test(rendered));
  app.handleInput("\r");
  await advanceCandidatePicker(app, () => rendered);
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
      limitations: [],
    }),
    recover: async () => ({
      experimentId: "cancel-fixture",
      experimentRoot: "unused",
      baseline: { match: "recovered", warnings: [] },
      recovery: { status: "completed", sessionId: "s", value: { status: "ready", reportPath: "recovery.md", unresolved: [] } },
      accept: async () => ({ match: "recovered", warnings: [] }),
    }),
    acceptRecovery: async () => ({ match: "recovered", warnings: [] }),
    discardRecovery: async () => {},
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
      };
    },
  } as never;
  const app = new IntakeTui({
    dataDir: join(root, "data"),
    sessionsRoot,
    tui,
    workflow,
    autoCompare: true,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    now: () => "2026-08-11T00:10:00.000Z",
  });
  await app.start();
  await enterIntake(app);
  await waitFor(() => /Patch the missing path/.test(rendered));
  app.handleInput("\r");
  await waitFor(() => /Session start:/.test(rendered));
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
  await advanceCandidatePicker(app, () => rendered);
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
  await writeFile(join(casesRoot, "case.complete"), "");
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
        task: { status: 'apparently_completed', evidenceRefs: [] },
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
  const app = new IntakeTui({
    dataDir,
    sessionsRoot: join(root, "sessions"),
    tui,
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  });
  await app.start();
  enterCommand(app, "/history");
  await waitFor(() => /Recent experiments/.test(rendered));
  assert.match(rendered, /exp-history/);
  app.handleInput('\x1b');
  assert.equal(app.page, 'home');
  enterCommand(app, '/history');
  await waitFor(() => app.page === 'history');
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
  const app = new IntakeTui({
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
  await waitFor(() => /Internal Agent model/.test(rendered));
  app.handleInput("\u001b[A");
  app.handleInput("\u001b[A");
  app.handleInput("\r");
  replaceField("private-gateway");
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("https://api.example.test/v1");
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("model-private");
  app.handleInput("\u001b[B");
  app.handleInput("\u001b[B");
  app.handleInput("\u001b[B");
  app.handleInput("\u001b[B");
  app.handleInput("\r");
  replaceField("env:REPRISE_PRIVATE_KEY");
  app.handleInput("\x13");
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
    api: "openai-completions",
    reasoning: false,
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
  const app = new IntakeTui({
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
  const app = new IntakeTui({
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
  assert.doesNotMatch(rendered, /Internal Agent model|Language/);
});
