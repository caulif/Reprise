import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TaskCaseSchema } from "../../src/core/schema.js";
import { sha256, writeImmutable } from "../../src/core/identity.js";
import {
  codexProductPack,
  freezeCodexFixture,
  importCodexFixture,
  normalizeCodexRuntimeEvent,
} from "../../src/products/packs/codex/pack.js";
import { CodexProductRuntime, clearCodexCatalogCache, defaultCodexSandbox, discoverCodexExecutable } from "../../src/products/packs/codex/runtime.js";
import { CodexAppServerClient, codexSettlementStatus } from "../../src/products/packs/codex/runner.js";
import { redactDiagnostic, summarizeDiagnostic } from "../../src/infrastructure/process/stdio.js";
import {
  CodexTextCaller,
  EXPERIMENT_APPLICATION_EFFORT,
  EXPERIMENT_APPLICATION_MODEL,
} from "../../src/products/packs/codex/text-caller.js";
import {
  assertCodexSmokeAcceptanceRecord,
  checkCodexSmokeGate,
  CodexSmokeAcceptanceRecordSchema,
} from "../../src/products/packs/codex/smoke-gate.js";
import { productPacks } from "../../src/products/index.js";
import { fixturePath, FAKE_APP_SERVER, fakeCodexRunner, timeoutAfter } from "../codex-pack-support.js";
import { candidateLaunchFor } from "../../src/application/recovery/launch-context.js";

test("Codex Recovery Playbook has stable provenance and is included in build output", async () => {
  const playbook = codexProductPack.recoveryPlaybook();
  assert.equal(playbook.version, "codex-recovery/v1");
  assert.equal(playbook.sha256, sha256(playbook.text));
  assert.match(playbook.text, /Codex/i);
  const builtPlaybook = await readFile(
    new URL("../../src/products/packs/codex/recovery/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.equal(builtPlaybook, playbook.text);
});

test("Codex defaults to the locally configured Terra candidate", () => {
  assert.deepEqual(codexProductPack.defaultCandidate(), {
    candidateId: "codex-terra-high",
    productId: "codex",
    requestedModel: "gpt-5.6-terra",
  });
});

test("Codex fixture import freezes one complete session without exposing raw private fields", async () => {
  const imported = await importCodexFixture(fixturePath);
  assert.equal(imported.taskCase.initialInput.id, "message-1");
  assert.equal(imported.taskCase.transcript.length, 2);
  assert.equal(
    imported.taskCase.baseline.finalMessage,
    "Implemented the importer.",
  );
  assert.equal(
    imported.taskCase.baseline.artifactRefs[0]?.caseId,
    imported.taskCase.caseId,
  );
  assert.equal(Value.Check(TaskCaseSchema, imported.taskCase), true);
  assert.doesNotMatch(JSON.stringify(imported.taskCase), /privateDebug/);
  assert.equal(imported.rawSession.events.at(-1)?.type, "internal_debug");
});

test("Codex freeze creates immutable case facts, raw session, and hashed baseline artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-case-"));
  try {
    const frozen = await freezeCodexFixture(fixturePath, root);
    await stat(join(root, frozen.taskCase.caseId, "case.complete"));
    const caseJson = await readFile(
      join(root, frozen.taskCase.caseId, "case.json"),
      "utf8",
    );
    const raw = await readFile(
      join(root, frozen.taskCase.caseId, "raw", "session.json"),
      "utf8",
    );
    const artifact = await readFile(
      join(root, frozen.taskCase.caseId, "baseline-artifacts", "screenshot-1"),
      "utf8",
    );
    assert.match(caseJson, /message-1/);
    assert.match(raw, /privateDebug/);
    assert.equal(artifact, "png-fixture");
    await assert.rejects(
      freezeCodexFixture(fixturePath, root),
      /already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex fixture freeze cleans failed staging writes and can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-case-retry-"));
  let writes = 0;
  try {
    const fixture = await importCodexFixture(fixturePath);
    const write = async (
      target: string,
      value: string | Uint8Array,
    ): Promise<void> => {
      writes += 1;
      assert.ok(target.includes(`.${fixture.taskCase.caseId}.staging-`));
      if (writes === 1) {
        await writeFile(target, value);
        throw new Error("simulated fixture write failure");
      }
      await writeImmutable(target, value);
    };

    await assert.rejects(
      freezeCodexFixture(fixturePath, root, "2026-08-13T00:00:00.000Z", write),
      /simulated fixture write failure/,
    );
    assert.deepEqual(await readdir(root), []);

    const frozen = await freezeCodexFixture(
      fixturePath,
      root,
      "2026-08-13T00:00:00.000Z",
      write,
    );
    assert.equal(writes, 5);
    assert.equal(frozen.taskCase.caseId, fixture.taskCase.caseId);
    await stat(join(root, frozen.taskCase.caseId, "case.complete"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex runtime normalization records only observed model facts and leaves absent data unknown", () => {
  assert.deepEqual(
    normalizeCodexRuntimeEvent({
      type: "model.resolved",
      data: { provider: "openai", model: "gpt-5.6-codex" },
    }),
    {
      type: "runtime.model_resolved",
      provider: "openai",
      model: "gpt-5.6-codex",
    },
  );
  assert.deepEqual(
    normalizeCodexRuntimeEvent({
      type: "turn.completed",
      data: { turnId: "turn-1" },
    }),
    {
      type: "runtime.turn_settled",
      turnId: "turn-1",
    },
  );
  assert.deepEqual(
    normalizeCodexRuntimeEvent({ type: "model.resolved", data: {} }),
    {
      type: "runtime.model_resolved",
      provider: "unknown",
      model: "unknown",
    },
  );
});

test("Codex and Claude Code Product Packs are statically registered", () => {
  assert.equal(productPacks.length, 2);
  assert.equal(productPacks[0], codexProductPack);
  assert.equal(codexProductPack.runtime.id, "codex");
  assert.deepEqual(codexProductPack.manifest.sessionSchemaVersions, [
    "reprise.codex.fixture/v1",
  ]);
});

test("Codex runtime discovery is local-only and resolves model facts as unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-runtime-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex.CMD");
  await writeFile(executable, "fixture executable");

  assert.equal(
    await discoverCodexExecutable({
      env: { PATH: root },
      platform: "win32",
      pathExt: ".CMD",
    }),
    executable,
  );
  const runtime = new CodexProductRuntime({
    executable,
    platform: "win32",
    version: "0.147.0",
  });
  assert.deepEqual(await runtime.inspectAvailable(), [
    { productId: "codex", executable, version: "0.147.0" },
  ]);
  const resolved = await runtime.resolve({
    productId: "codex",
    requestedModel: "gpt-test",
  });
  assert.equal(resolved.resolvedModel, "unknown");
  const environment = { environmentId: "env-1", runId: "run-1", root };
  const runner = await runtime.createRunner(
    resolved,
    environment,
    { append: async () => undefined },
    candidateLaunchFor(resolved, environment),
  );
  assert.equal(runner.capabilities().nativeAdmission, true);
  assert.equal(runner.capabilities().nativeTurnSettlement, true);
});

test("Codex model catalog cache is isolated by CODEX_HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-catalog-cache-"));
  const script = join(root, "catalog-app-server.mjs");
  const count = join(root, "calls.log");
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs';
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'model/list') {
      appendFileSync(${JSON.stringify(count)}, (process.env.CODEX_HOME ?? '') + '\\n');
      send({ id: message.id, result: { data: [{ id: process.env.CODEX_HOME, model: process.env.CODEX_HOME, supportedReasoningEfforts: [] }] } });
    }
  }
});
`,
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  clearCodexCatalogCache();
  const first = new CodexProductRuntime({
    executable: process.execPath,
    args: [script],
    env: { CODEX_HOME: "home-a" },
  });
  const second = new CodexProductRuntime({
    executable: process.execPath,
    args: [script],
    env: { CODEX_HOME: "home-a" },
  });
  const third = new CodexProductRuntime({
    executable: process.execPath,
    args: [script],
    env: { CODEX_HOME: "home-b" },
  });
  assert.equal((await first.listModels())[0]?.model, "home-a");
  assert.equal((await second.listModels())[0]?.model, "home-a");
  assert.equal((await third.listModels())[0]?.model, "home-b");
  assert.equal((await readFile(count, "utf8")).trim().split(/\r?\n/).length, 2);
});

test("Codex app-server client starts through a Windows .cmd shim", async (t) => {
  if (process.platform !== "win32") return;
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-cmd-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const script = join(root, "catalog-app-server.mjs");
  const shim = join(root, "codex.cmd");
  await writeFile(
    script,
    `
let buffer = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else send({ id: message.id, result: {} });
  }
});
`,
  );
  await writeFile(
    shim,
    `@ECHO off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || "${process.execPath}" "${script}" %*\r\n`,
  );
  const client = new CodexAppServerClient({ executable: shim, cwd: root });
  await client.start();
  await client.close();
});

test("Windows Codex sandbox defaults to full access because workspace-write cannot apply deny-read ACLs", () => {
  assert.equal(defaultCodexSandbox("win32"), "danger-full-access");
  assert.equal(defaultCodexSandbox("linux"), "workspace-write");
  assert.equal(defaultCodexSandbox("darwin"), "workspace-write");
});

test("Codex app-server settlement statuses preserve native terminal semantics", () => {
  assert.equal(codexSettlementStatus("completed"), "completed");
  assert.equal(codexSettlementStatus("failed"), "failed");
  assert.equal(codexSettlementStatus("interrupted"), "aborted");
  assert.equal(codexSettlementStatus("waiting_input"), "waiting_input");
  assert.equal(codexSettlementStatus("waitingInput"), "waiting_input");
  assert.equal(codexSettlementStatus("inProgress"), undefined);
});

test("server requests with string ids are rejected and exposed with one codex event prefix", async (t) => {
  const { runner, events } = await fakeCodexRunner(t, "server_request");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  assert.ok(events.includes("runtime.runtime_failed"));
  assert.equal(
    events.some((type) => type.startsWith("codex.codex.")),
    false,
  );
});

test("Codex runner sends the resolved model to thread and turn requests", async (t) => {
  const { runner, records } = await fakeCodexRunner(t, "model_routing", {
    requestedModel: "model-alias",
    resolvedModel: "canonical-model",
  });
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  const threadStarted = records.find((item) => item.type === "runtime.session_started");
  const turnAdmitted = records.find((item) => item.type === "runtime.delivery_observed");
  assert.equal((threadStarted?.payload as { model?: string }).model, "canonical-model");
  assert.equal((turnAdmitted?.payload as { model?: string }).model, "canonical-model");
});

test("server request rejection response preserves the string JSON-RPC id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-rpc-string-id-"));
  const script = join(root, "fake-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const observed: string[] = [];
  const rejectedIds: unknown[] = [];
  let observeRejection: (() => void) | undefined;
  const rejectionObserved = new Promise<void>((resolve) => {
    observeRejection = resolve;
  });
  const client = new CodexAppServerClient({
    executable: process.execPath,
    args: [script, "server_request"],
    cwd: root,
    onNotification: async (method, params) => {
      observed.push(method);
      if (method === "server/rejection_observed") {
        rejectedIds.push((params as { id?: unknown }).id);
        observeRejection?.();
      }
    },
  });
  try {
    await client.start();
    await timeoutAfter(
      rejectionObserved,
      1_000,
      "server request rejection was not observed",
    );
    assert.ok(observed.includes("server/rejection_observed"));
    assert.deepEqual(rejectedIds, ["approval-1"]);
  } finally {
    await client.close();
  }
});

test("an unexpectedly exited Codex process fails waitForTurn and records one process_exited event", async (t) => {
  const { runner, events } = await fakeCodexRunner(t, "exit");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  await assert.rejects(runner.waitForTurn(), /Codex app-server exited/);
  assert.equal(await runner.inspect(), "stopped");
  assert.equal(
    events.filter((type) => type === "runtime.runtime_failed").length,
    1,
  );
});

test("a Codex turn that waits for input settles natively through the app-server protocol", async (t) => {
  const { runner, events } = await fakeCodexRunner(t, "waiting_input");
  const receipt = await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  assert.equal(receipt.delivery, "accepted");
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, "waiting_input");
  assert.equal(settlement.confidence, "native");
  assert.ok(events.includes("runtime.session_started"));
  assert.ok(events.includes("runtime.delivery_observed"));
});

test("an unrecognized turn status fails the waiter instead of waiting out the turn budget", async (t) => {
  const { runner, events } = await fakeCodexRunner(t, "somethingNew");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  await assert.rejects(
    runner.waitForTurn(),
    /unrecognized turn settlement \(somethingNew\)/,
  );
  assert.ok(events.includes("runtime.runtime_failed"));
});

test("a failed Codex turn with HTTP 503 is an upstream settlement, not a protocol hang", async (t) => {
  const { runner, events, records } = await fakeCodexRunner(t, "failed_503");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  const settlement = await timeoutAfter(runner.waitForTurn(), 2_000, "503 settlement hung");
  assert.equal(settlement.status, "failed");
  assert.equal(settlement.failure?.kind, "upstream");
  assert.equal(settlement.failure?.retryable, true);
  assert.equal(settlement.failure?.reconnectCount, 5);
  const serialized = JSON.stringify(settlement);
  assert.doesNotMatch(serialized, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(serialized, /api_key=abcdefgh/);
  assert.doesNotMatch(serialized, /https:\/\/api\.example\.com/);
  assert.match(settlement.failure?.summary ?? "", /503/);
  assert.equal(events.filter((type) => type === "runtime.runtime_failed").length, 5);
  for (const record of records.filter((item) => item.type === "runtime.runtime_failed")) {
    assert.doesNotMatch(JSON.stringify(record.payload), /abcdefghijklmnopqrstuvwxyz/);
    assert.doesNotMatch(JSON.stringify(record.payload), /https:\/\/api\.example\.com/);
  }
});

test("a failed Codex turn without an error payload stays an unknown failure", async (t) => {
  const { runner } = await fakeCodexRunner(t, "failed");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  const settlement = await runner.waitForTurn();
  assert.equal(settlement.status, "failed");
  assert.equal(settlement.failure?.kind, "unknown");
  assert.equal(settlement.failure?.retryable, false);
});

test("an exited Codex process wakes waitForTurn immediately", async (t) => {
  const { runner } = await fakeCodexRunner(t, "exit");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  await timeoutAfter(
    assert.rejects(runner.waitForTurn(), /Codex app-server exited/),
    2_000,
    "process exit did not wake the waiter",
  );
});

test("cancelWait releases an abandoned turn wait so a late settlement cannot leak into the next turn", async (t) => {
  const { runner } = await fakeCodexRunner(t, "never");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  const abandoned = runner.waitForTurn();
  runner.cancelWait?.("Harness stopped waiting for this turn.");
  await assert.rejects(abandoned, /Harness stopped waiting/);
});

test("CodexTargetRunner records an interrupt failure when close succeeds", async (t) => {
  const { runner, events } = await fakeCodexRunner(t, "interrupt_failed");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  await runner.stop("shutdown");
  assert.equal(await runner.inspect(), "stopped");
  assert.equal(events.includes("runtime.session_stopped"), true);
  assert.equal(events.includes("runtime.runtime_failed"), true);
});

test("CodexTargetRunner reports a close failure after an interrupt failure", async (t) => {
  const { runner } = await fakeCodexRunner(t, "interrupt_failed");
  await runner.start(
    { id: "message-1", text: "Make the change." },
    { runId: "run-1", turnIndex: 0, clientMessageId: "initial-run-1" },
  );
  const originalClose: (this: CodexAppServerClient) => Promise<void> =
    Reflect.get(CodexAppServerClient.prototype, "close");
  const close = mock.method(
    CodexAppServerClient.prototype,
    "close",
    async function (this: CodexAppServerClient) {
      await Reflect.apply(originalClose, this, []);
      throw new Error("close failed");
    },
  );
  try {
    await assert.rejects(runner.stop("shutdown"), /close failed/);
    assert.equal(await runner.inspect(), "stopped");
  } finally {
    close.mock.restore();
  }
});

test("text caller keeps the turn failure when client close fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-text-caller-cleanup-"));
  const script = join(root, "failing-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const originalClose: (this: CodexAppServerClient) => Promise<void> =
    Reflect.get(CodexAppServerClient.prototype, "close");
  const close = mock.method(
    CodexAppServerClient.prototype,
    "close",
    async function (this: CodexAppServerClient) {
      await Reflect.apply(originalClose, this, []);
      throw new Error("close failed");
    },
  );
  try {
    const caller = new CodexTextCaller({
      options: { executable: process.execPath, args: [script, "failed"] },
      turnTimeoutMs: 5_000,
    });
    const session = caller.createSession({
      sessionId: "session-1",
      systemPrompt: "Compare the runs.",
      tools: [],
    });
    await assert.rejects(
      session.append({ content: "{}", signal: new AbortController().signal }),
      /classified upstream error|ended as failed/,
    );
  } finally {
    close.mock.restore();
  }
});

test("text caller exposes a close failure when the turn itself succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-text-caller-cleanup-"));
  const script = join(root, "successful-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const originalClose: (this: CodexAppServerClient) => Promise<void> =
    Reflect.get(CodexAppServerClient.prototype, "close");
  const close = mock.method(
    CodexAppServerClient.prototype,
    "close",
    async function (this: CodexAppServerClient) {
      await Reflect.apply(originalClose, this, []);
      throw new Error("close failed");
    },
  );
  try {
    const caller = new CodexTextCaller({
      options: { executable: process.execPath, args: [script, "completed"] },
      turnTimeoutMs: 5_000,
    });
    const session = caller.createSession({
      sessionId: "session-1",
      systemPrompt: "Compare the runs.",
      tools: [],
    });
    await assert.rejects(
      session.append({ content: "{}", signal: new AbortController().signal }),
      /close failed/,
    );
  } finally {
    close.mock.restore();
  }
});

test("a text turn that never completes fails on its own deadline instead of hanging", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-text-caller-"));
  const script = join(root, "silent-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caller = new CodexTextCaller({
    options: { executable: process.execPath, args: [script, "never"] },
    turnTimeoutMs: 150,
  });
  const session = caller.createSession({
    sessionId: "session-1",
    systemPrompt: "Compare the runs.",
    tools: [],
  });
  await assert.rejects(
    session.append({ content: "{}", signal: new AbortController().signal }),
    /did not complete within 150ms/,
  );
});

test("a failed text turn is reported as a failure rather than an empty answer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-text-caller-"));
  const script = join(root, "failing-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caller = new CodexTextCaller({
    options: { executable: process.execPath, args: [script, "failed"] },
    turnTimeoutMs: 5_000,
  });
  const session = caller.createSession({
    sessionId: "session-1",
    systemPrompt: "Compare the runs.",
    tools: [],
  });
  await assert.rejects(
    session.append({ content: "{}", signal: new AbortController().signal }),
    /classified upstream error|ended as failed/,
  );
});

test("a text turn that fails during thread/start still removes its temp directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-text-caller-start-fail-"));
  const script = join(root, "failing-app-server.mjs");
  await writeFile(script, FAKE_APP_SERVER);
  t.after(async () => rm(root, { recursive: true, force: true }));
  const before = new Set(await readdir(tmpdir()));
  const caller = new CodexTextCaller({
    options: { executable: process.execPath, args: [script, "thread_start_fail"] },
    turnTimeoutMs: 5_000,
  });
  const session = caller.createSession({
    sessionId: "session-1",
    systemPrompt: "Compare the runs.",
    tools: [],
  });
  await assert.rejects(
    session.append({ content: "{}", signal: new AbortController().signal }),
    /cannot start thread|thread\/start/,
  );
  const leftover = (await readdir(tmpdir())).filter((name) => name.startsWith("reprise-experiment-application-") && !before.has(name));
  assert.deepEqual(leftover, []);
});

test("target stderr is redacted before it reaches the run journal", () => {
  const openai = ["sk-", "abcdefghijklmnopqrstuvwx"].join("");
  const bearer = ["Authorization: Bearer ", "abcdefghijklmnopqrstuvwxyz"].join("");
  assert.equal(
    redactDiagnostic(`failed with ${openai}`),
    "failed with [REDACTED]",
  );
  assert.equal(
    redactDiagnostic(bearer),
    "Authorization: [REDACTED]",
  );
  assert.equal(redactDiagnostic("api_key=abcdefgh12345678"), "[REDACTED]");
  assert.equal(
    redactDiagnostic("ENOENT: no such file or directory"),
    "ENOENT: no such file or directory",
  );
});

test("settlement summaries strip credentials and full upstream URLs", () => {
  const openai = ["sk-", "abcdefghijklmnopqrstuvwx"].join("");
  const summary = summarizeDiagnostic(
    `HTTP 503 at https://api.example.com/v1/responses?api_key=${openai} Authorization: Bearer abcdefghijklmnopqrstuvwxyz`,
  );
  assert.doesNotMatch(summary, /api\.example\.com/);
  assert.doesNotMatch(summary, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(summary, /abcdefghijklmnopqrstuvwx/);
  assert.match(summary, /\[endpoint\]/);
});

test("Codex app-server requests time out and close an unresponsive process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-app-server-timeout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "unresponsive-app-server.mjs");
  await writeFile(
    fixture,
    "process.stdin.resume(); process.on('SIGTERM', () => process.exit(0));",
  );
  const client = new CodexAppServerClient({
    executable: process.execPath,
    args: [fixture],
    cwd: root,
    requestTimeoutMs: 25,
  });
  await assert.rejects(client.start(), /initialize timed out/);
  await client.close();
});

test("Experiment Application defaults to the authorized Terra medium model and rejects unsupported Host tools", async () => {
  assert.equal(EXPERIMENT_APPLICATION_MODEL, "gpt-5.6-terra");
  assert.equal(EXPERIMENT_APPLICATION_EFFORT, "medium");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    new CodexTextCaller()
      .createSession({
        sessionId: "session-1",
        systemPrompt: "Return JSON.",
        tools: [],
      })
      .append({ content: "{}", signal: controller.signal }),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    },
  );
  assert.throws(
    () =>
      new CodexTextCaller().createSession({
        sessionId: "session-1",
        systemPrompt: "Return JSON.",
        tools: [
          {
            name: "read_observation",
            description: "",
            parameters: Type.Object({}),
            execute: async () => ({ content: "", details: {} }),
          },
        ],
      }),
    /cannot expose Host tools/,
  );
});

test("Codex smoke gate reports missing external confirmations without starting a Runtime", () => {
  const blocked = checkCodexSmokeGate({
    taskCaseReady: true,
    isolatedWorkspace: true,
    noIrreversibleActions: true,
    accountConfirmed: false,
    networkConfirmed: false,
    costLimit: "",
    maxWallClockMs: 0,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.missing.length, 4);
  const ready = checkCodexSmokeGate({
    taskCaseReady: true,
    isolatedWorkspace: true,
    noIrreversibleActions: true,
    accountConfirmed: true,
    networkConfirmed: true,
    costLimit: "10 USD",
    maxWallClockMs: 30_000,
  });
  assert.deepEqual(ready, { allowed: true, missing: [] });
});

test("Codex smoke acceptance records are schema-checked and preserve blocked evidence", () => {
  const record = {
    schemaVersion: 1,
    status: "blocked",
    recordedAt: "2026-08-10T00:00:00.000Z",
    taskCaseId: "case-1",
    experimentId: "experiment-1",
    runId: "run-1",
    executable: "C:/tools/codex.cmd",
    requestedModel: "gpt-test",
    resolvedModel: "unknown",
    fidelity: "unknown",
    termination: "unknown",
    cleanup: "unknown",
    smokeSteps: {
      started: false,
      initialAdmission: false,
      firstTurnSettlement: false,
      followupSubmission: false,
      stopped: false,
    },
    humanJudgment: {
      rawEvidence: "",
      artifacts: "",
      traceAndReport: "",
      knownLimitations: "Protocol not verified.",
      conclusion: "blocked",
    },
    blockingEvidence: {
      stage: "start",
      diagnosticCode: "unsupported_runtime",
      observation: "Runner refused to start.",
      unexecutedExternalActions: "No network request was sent.",
    },
  } as const;
  assert.equal(Value.Check(CodexSmokeAcceptanceRecordSchema, record), true);
  assert.doesNotThrow(() => assertCodexSmokeAcceptanceRecord(record));
  assert.throws(
    () => assertCodexSmokeAcceptanceRecord({ ...record, runId: "../outside" }),
    /Invalid Codex smoke acceptance record/,
  );
});

test("Codex runtime discovery does not report missing executables", async () => {
  assert.equal(
    await discoverCodexExecutable({
      executable: join(tmpdir(), "does-not-exist", "codex.exe"),
      platform: "win32",
    }),
    undefined,
  );
  const runtime = new CodexProductRuntime({
    executable: join(tmpdir(), "does-not-exist", "codex.exe"),
    platform: "win32",
  });
  await assert.rejects(
    runtime.resolve({ productId: "codex", requestedModel: "gpt-test" }),
    /executable was not found/,
  );
});
