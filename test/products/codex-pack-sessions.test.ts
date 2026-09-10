import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { TaskCaseSchema } from "../../src/core/schema.js";
import { resolvedRecoveryFacts } from "../../src/infrastructure/recovery-tools.js";
import {
  discoverCodexSessions,
  freezeCodexSession,
  inspectCodexSession,
} from "../../src/products/packs/codex/sessions.js";
import { gitHead } from "../codex-pack-support.js";

const execFileAsync = promisify(execFile);
test("Codex session discovery keeps an unreadable oversized summary without dropping the valid rollout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-rollout-oversized-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  const valid = join(sessions, "rollout-valid.jsonl");
  await writeFile(
    valid,
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "valid-session" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Small valid task." },
      }),
    ].join("\n") + "\n",
  );
  const oversized = join(sessions, "rollout-oversized.jsonl");
  await writeFile(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));

  const discovered = await discoverCodexSessions(sessions);
  assert.equal(discovered.some((session) => session.sessionId === "valid-session"), true);
  assert.equal(discovered.filter((session) => session.sessionId === "valid-session").length, 1);
  const oversizedSession = discovered.find((session) => session.sourcePath.includes("oversized"));
  assert.ok(oversizedSession);
  assert.equal(oversizedSession.recoveryReadiness, "pending");
  assert.notEqual(oversizedSession.availability, "unreadable");
  const inspected = await inspectCodexSession(valid);
  assert.equal(inspected.sessionId, "valid-session");
});


test("Codex catalog and rollout sources merge only on an exact session id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-merge-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  await mkdir(sessions);
  await writeFile(join(sessions, "rollout-path-mismatch.jsonl"), [
    JSON.stringify({ timestamp: "2026-08-11T00:00:00.000Z", type: "session_meta", payload: { id: "rollout-id", cwd: "C:\\other" } }),
    JSON.stringify({ timestamp: "2026-08-11T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Rollout task." } }),
  ].join("\n") + "\n");
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, title TEXT, cwd TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run("catalog-id", "rollout-path-mismatch.jsonl", "Indexed task", "C:\\demo");
  db.close();
  const discovered = await discoverCodexSessions(sessions);
  assert.deepEqual(new Set(discovered.map((session) => session.sessionId)), new Set(["catalog-id", "rollout-id"]));
  assert.equal(discovered.find((session) => session.sessionId === "catalog-id")?.sourceKind, "catalog-only");
  assert.equal(discovered.find((session) => session.sessionId === "rollout-id")?.sourceKind, "rollout-only");
});

test("Codex freeze accepts a selected user task input and rejects other transcript entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-selected-input-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "rollout-selected-input.jsonl");
  await writeFile(
    source,
    [
      JSON.stringify({
        timestamp: "2026-08-11T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "selected-input" },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "First task." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:02.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "First response." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Second task." },
      }),
      JSON.stringify({
        timestamp: "2026-08-11T00:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete" },
      }),
    ].join("\n") + "\n",
  );
  const request = {
    sourcePath: source,
    casesRoot: join(root, "cases"),
    now: "2026-08-11T00:01:00.000Z",
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
  };

  const frozen = await freezeCodexSession({
    ...request,
    initialMessageId: "message-3",
  });
  assert.deepEqual(frozen.taskCase.initialInput, {
    id: "message-3",
    role: "user",
    text: "Second task.",
  });
  await assert.rejects(
    freezeCodexSession({
      ...request,
      casesRoot: join(root, "invalid-user"),
      initialMessageId: "message-2",
    }),
    /not a user message/,
  );
  await assert.rejects(
    freezeCodexSession({
      ...request,
      casesRoot: join(root, "invalid-id"),
      initialMessageId: "missing",
    }),
    /not a user message/,
  );
});

test("Codex rollout discovery and freeze are read-only, complete, redacted, and idempotent", async (t) => {
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    t.skip("git is unavailable on PATH");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "reprise-rollout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions", "2026", "08", "11");
  await mkdir(sessions, { recursive: true });
  const source = join(sessions, "rollout-2026-08-11T00-00-00-session-1.jsonl");
  const historicalCwd = join(root, "historical");
  await mkdir(historicalCwd);
  await execFileAsync("git", ["init", historicalCwd]);
  await execFileAsync("git", [
    "-C",
    historicalCwd,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFileAsync("git", [
    "-C",
    historicalCwd,
    "config",
    "user.name",
    "Reprise test",
  ]);
  await writeFile(join(historicalCwd, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["-C", historicalCwd, "add", "."]);
  await execFileAsync("git", ["-C", historicalCwd, "commit", "-m", "baseline"]);
  await writeFile(join(historicalCwd, "dirty.txt"), "current only\n");
  const historicalCommit = "a".repeat(40);
  const lines = [
    {
      timestamp: "2026-08-11T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-1",
        cwd: historicalCwd,
        cli_version: "0.1.0",
        git: { commit: historicalCommit },
      },
    },
    {
      timestamp: "2026-08-11T00:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6" },
    },
    {
      timestamp: "2026-08-11T00:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Fix the SERVICE_TOKEN leak." },
    },
    {
      timestamp: "2026-08-11T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: '{"command":"npm test"}',
      },
    },
    {
      timestamp: "2026-08-11T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "apply_patch",
        arguments:
          '{"patch":"*** Update File: src/example.ts\\n*** Add File: README.md"}',
      },
    },
    {
      timestamp: "2026-08-11T00:00:05.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Fixed and tested." },
    },
    {
      timestamp: "2026-08-11T00:00:06.000Z",
      type: "event_msg",
      payload: { type: "task_complete" },
    },
  ];
  await writeFile(
    source,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );

  const discovered = await discoverCodexSessions(join(root, "sessions"));
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0]?.signals.toolCalls, 2);
  assert.equal(
    (await inspectCodexSession(source)).finalMessage,
    "Fixed and tested.",
  );

  const cases = join(root, "cases");
  const frozen = await freezeCodexSession({
    sourcePath: source,
    casesRoot: cases,
    now: "2026-08-11T00:01:00.000Z",
    privacy: {
      allowModelText: false,
      allowBinary: false,
      redactions: ["SERVICE_TOKEN"],
    },
  });
  assert.equal(frozen.reused, false);
  assert.equal(Value.Check(TaskCaseSchema, frozen.taskCase), true);
  assert.doesNotMatch(JSON.stringify(frozen.taskCase), /SERVICE_TOKEN/);
  assert.doesNotMatch(
    await readFile(
      join(cases, frozen.taskCase.caseId, "raw", "session.jsonl"),
      "utf8",
    ),
    /SERVICE_TOKEN/,
  );
  const context = frozen.taskCase.taskContext as Record<string, unknown>;
  assert.equal(context.historicalCommit, historicalCommit);
  assert.deepEqual(context.historicalBehavior, {
    commands: ["npm test"],
    touchedPaths: ["README.md", "src/example.ts"],
  });
  assert.deepEqual(context.historicalEnvironment, {
    cwd: {
      status: "available",
      git: {
        isRepository: true,
        dirty: true,
        head: await gitHead(historicalCwd),
      },
    },
  });
  const recoveryFacts = await resolvedRecoveryFacts(historicalCwd, frozen.taskCase);
  assert.equal(recoveryFacts.catalog.length, frozen.taskCase.transcript.length + frozen.taskCase.historicalEvents.length);
  assert.ok(recoveryFacts.catalog.some((entry) => entry.source === "transcript"));
  assert.ok(recoveryFacts.catalog.some((entry) => entry.source === "historical_events"));
  assert.ok(recoveryFacts.evidenceRefs.some((ref) => ref.startsWith("event:transcript-")));
  assert.ok(recoveryFacts.evidenceRefs.some((ref) => ref.startsWith("event:history-")));
  assert.equal(
    (
      await freezeCodexSession({
        sourcePath: source,
        casesRoot: cases,
        now: "2026-08-11T00:01:00.000Z",
        privacy: {
          allowModelText: false,
          allowBinary: false,
          redactions: ["SERVICE_TOKEN"],
        },
      })
    ).reused,
    true,
  );

  const incomplete = join(sessions, "rollout-incomplete.jsonl");
  await writeFile(
    incomplete,
    lines
      .slice(0, -1)
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  await assert.rejects(
    freezeCodexSession({
      sourcePath: incomplete,
      casesRoot: cases,
      now: "2026-08-11T00:01:00.000Z",
      privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    }),
    /no completed turn/,
  );
});
