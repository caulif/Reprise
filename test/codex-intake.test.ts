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
import { enterIntake, waitFor } from "./codex-intake-support.js";

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
  await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));

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
  await waitFor(() => /Session start:/.test(rendered));
  assert.match(rendered, /Session start:/);
  assert.match(rendered, /Review session/);
  assert.equal(await readFile(source, "utf8"), raw);

  app.handleInput("\r");
  await waitFor(() => /is current/.test(rendered));
  assert.match(rendered, /is current/);
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
