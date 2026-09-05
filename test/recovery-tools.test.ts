import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { ProcessSpawner } from "../src/infrastructure/process-runner.js";
import {
  recoveryObservationTools,
  recoveryTools,
  resolvedRecoveryFacts,
  verifyRecoveryEvidence,
} from "../src/infrastructure/recovery-tools.js";
import { sha256 } from "../src/core/identity.js";
import { replayControlledRecoveryDeltaBytes } from "../src/infrastructure/recovery-write-journal.js";
import type { TaskCase } from "../src/core/schema.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-tools-"));
  await writeFile(join(root, "input.txt"), "original\r\n");
  return root;
}

function tool(root: string, name: string, options = {}) {
  const toolOptions = name === "shell_exec" ? { allowShell: true, ...options } : options;
  const found = recoveryTools(root, toolOptions).find(
    (item) => item.name === name,
  );
  assert.ok(found, `missing ${name}`);
  return found;
}

function nodeCommand(script: string): string {
  const executable = process.execPath.replaceAll("'", "''");
  return `& '${executable}' -e ${JSON.stringify(script)}`;
}

function capturingSpawner(capture: {
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): ProcessSpawner {
  return (command: string, args: readonly string[], options: SpawnOptions) => {
    capture.command = command;
    capture.args = args;
    if (options.env) capture.env = options.env;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => child.emit("close", 0));
    return child as unknown as ChildProcess;
  };
}


test("shell_exec is always registered on the Recovery workspace surface", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  assert.equal(recoveryTools(root).some((item) => item.name === "shell_exec"), true);
  assert.deepEqual(
    recoveryTools(root).map((item) => item.name).sort(),
    ["edit", "find", "grep", "ls", "read", "shell_exec", "write"],
  );
});

test("workspace read returns native image blocks only when binary access is authorized", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-image-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  await writeFile(join(root, "result.png"), bytes);
  const denied = tool(root, "read", { allowBinary: false });
  await assert.rejects(denied.execute({ path: "result.png", format: "image", mimeType: "image/png" }, new AbortController().signal), /binary_read_denied/);
  const result = await tool(root, "read", { allowBinary: true }).execute(
    { path: "result.png", format: "image", mimeType: "image/png" },
    new AbortController().signal,
  );
  assert.deepEqual(result.contentBlocks, [
    { type: "text", text: "Image result.png." },
    { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
  ]);
});

test("structured recovery tools reject traversal, absolute paths, backslashes and symlink targets", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const read = tool(root, "read");
  for (const path of [
    "../x",
    resolve(root, "input.txt"),
    "dir\\x",
  ]) {
    await assert.rejects(read.execute({ path }, new AbortController().signal));
  }
  const dotted = await read.execute({ path: "./input.txt" }, new AbortController().signal);
  assert.match(dotted.content, /original/);
  try {
    await symlink(join(root, "input.txt"), join(root, "link.txt"));
  } catch {
    t.skip("symlink creation unavailable");
    return;
  }
  await assert.rejects(
    read.execute({ path: "link.txt" }, new AbortController().signal),
    /symbolic/i,
  );
  await writeFile(join(root, ".env"), "TOKEN=do-not-read");
  await assert.rejects(
    read.execute({ path: ".env" }, new AbortController().signal),
    /credential_read_denied/i,
  );
  const shell = tool(root, "shell_exec");
  await assert.rejects(
    shell.execute({ command: "type .env" }, new AbortController().signal),
    /credential_read_denied/i,
  );
});

test("Recovery model cannot read credential-class files", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(root, ".env"), "TOKEN=do-not-read");
  const read = tool(root, "read");
  await assert.rejects(read.execute({ path: ".env" }, new AbortController().signal), /credential_read_denied/i);
});

test("direct Recovery writes journal schema-validated pre/post hashes", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const entries: unknown[] = [];
  const write = tool(root, "write", {
    onControlledWrite: async (entry: unknown) => {
      entries.push(entry);
    },
  });
  await write.execute(
    { path: "input.txt", content: "recovered\n" },
    new AbortController().signal,
  );
  assert.deepEqual(entries, [
    {
      schemaVersion: 1,
      tool: "write",
      phase: "before",
      path: "input.txt",
      before: {
        kind: "file",
        size: Buffer.byteLength("original\r\n"),
        contentHash: sha256("original\r\n"),
      },
    },
    {
      schemaVersion: 1,
      tool: "write",
      phase: "after",
      path: "input.txt",
      before: {
        kind: "file",
        size: Buffer.byteLength("original\r\n"),
        contentHash: sha256("original\r\n"),
      },
      after: {
        kind: "file",
        size: Buffer.byteLength("recovered\n"),
        contentHash: sha256("recovered\n"),
      },
    },
  ]);
});

test("shell_exec deletes are unobserved by the controlled-write journal", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const entries: unknown[] = [];
  const shell = tool(root, "shell_exec", {
    onControlledWrite: async (entry: unknown) => entries.push(entry),
  });
  await shell.execute({ command: "Remove-Item -LiteralPath input.txt" }, new AbortController().signal);
  await assert.rejects(readFile(join(root, "input.txt")));
  assert.deepEqual(entries, []);
});

test("write allows recovery.md and rejects the Host-owned manifest name", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const write = tool(root, "write");
  const signal = new AbortController().signal;
  await write.execute({ path: "recovery.md", content: "# Recovery\n" }, signal);
  assert.match(await readFile(join(root, "recovery.md"), "utf8"), /# Recovery/);
  await assert.rejects(
    write.execute({ path: "recovery-manifest.json", content: "{}" }, signal),
    /recovery_sink_reserved/i,
  );
});

test("shell_exec runs arbitrary staging commands with a clean temporary environment", async (t) => {
  const root = await workspace();
  const homeRoot = join(root, "harness-home");
  const harnessKeyName = ["REPRISE_TEST_", "API_KEY"].join("");
  const previousHarnessKey = process.env[harnessKeyName];
  process.env[harnessKeyName] = "do-not-leak";
  t.after(async () => {
    if (previousHarnessKey === undefined) delete process.env[harnessKeyName];
    else process.env[harnessKeyName] = previousHarnessKey;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  const shell = tool(root, "shell_exec", { homeRoot });
  await shell.execute(
    { command: "Set-Content -LiteralPath shell-output.txt -Value 'from-shell'" },
    new AbortController().signal,
  );
  assert.equal(
    (await readFile(join(root, "shell-output.txt"), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
    "from-shell\n",
  );

  const environment = await shell.execute(
    {
      command: nodeCommand(
        "process.stdout.write([process.env.HOME, process.env.REPRISE_TEST_API_KEY || 'missing'].join('|'))",
      ),
    },
    new AbortController().signal,
  );
  assert.match(
    environment.content,
    new RegExp(
      `^${homeRoot.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}\\|missing$`,
    ),
  );

  const redacted = await shell.execute(
    {
      command: `${nodeCommand("undefined")} ${JSON.stringify(`${["Authorization: Bea", "rer "].join("")}${["ultra-secret", "-token"].join("")}`)}`,
    },
    new AbortController().signal,
  );
  const redactedDetails = redacted.details as { command: string };
  assert.match(redactedDetails.command, /Authorization: \[REDACTED\]/i);
  assert.doesNotMatch(redactedDetails.command, /ultra-secret-token/);

  const pipeline = await shell.execute(
    { command: "Write-Output alpha | findstr.exe alpha | Set-Content -LiteralPath pipe-output.txt" },
    new AbortController().signal,
  );
  assert.equal((pipeline.details as { exitCode: number }).exitCode, 0);
  assert.equal((await readFile(join(root, "pipe-output.txt"), "utf8")).trim(), "alpha");
  const nonzero = await shell.execute(
    { command: "exit 7" },
    new AbortController().signal,
  );
  assert.equal((nonzero.details as { exitCode: number }).exitCode, 7);

  await shell.execute(
    { command: "git config --global user.name RepriseRecovery" },
    new AbortController().signal,
  );
  assert.match(
    await readFile(join(homeRoot, "gitconfig"), "utf8"),
    /RepriseRecovery/,
  );
});

test("shell_exec times out individual commands and marks truncated output", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );

  const timedShell = tool(root, "shell_exec", { shellTimeoutMs: 100 });
  await assert.rejects(
    timedShell.execute(
      { command: nodeCommand("setTimeout(() => undefined, 2000)") },
      new AbortController().signal,
    ),
    /timed out/i,
  );

  const shell = tool(root, "shell_exec");
  const output = await shell.execute(
    { command: nodeCommand("process.stdout.write('x'.repeat(300000))") },
    new AbortController().signal,
  );
  const details = output.details as { stdoutBytes: number; truncated: boolean };
  assert.equal(details.stdoutBytes, 262_144);
  assert.equal(details.truncated, true);
});

test("write still succeeds after 64 investigation calls", async () => {
  const root = await workspace();
  try {
    const tools = recoveryTools(root);
    const list = tools.find((item) => item.name === "ls");
    const report = tools.find((item) => item.name === "write");
    assert.ok(list && report);
    for (let index = 0; index < 64; index += 1) {
      await list.execute({ path: `missing-${index}` }, new AbortController().signal);
    }
    const written = await report.execute({ path: "recovery.md", content: "# Recovery\nKept the current tree.\n" }, new AbortController().signal);
    assert.match(written.content, /Wrote \d+ bytes/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("resolved Recovery facts admit only mechanically valid preimages and verified Git evidence", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["add", "input.txt"]);
  await git(root, ["commit", "-m", "original"]);
  const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const source = "before\n";
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId: "case-recovery-facts",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message-1", role: "user", text: "task" },
    transcript: [{ id: "message-1", role: "user", text: "task" }],
    historicalEvents: [
      { eventId: "event-1", path: "input.txt", source, sha256: sha256(source) },
      {
        eventId: "event-2",
        path: "../outside.txt",
        source,
        sha256: sha256(source),
      },
      { eventId: "event-3", path: "bad.txt", source, sha256: "a".repeat(64) },
    ],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: { historicalCommit: commit },
    provenance: {
      packVersion: "test",
      importedAt: "2026-08-14T00:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  const facts = await resolvedRecoveryFacts(root, taskCase);
  assert.deepEqual(facts.preimages, [
    { path: "input.txt", source, hash: sha256(source) },
  ]);
  assert.ok(facts.evidenceRefs.includes("artifact:historical-commit"));
  assert.ok(facts.evidenceRefs.includes("artifact:preimage-0"));
  await verifyRecoveryEvidence(
    root,
    ["artifact:historical-commit", "artifact:preimage-0"],
    facts.verifiedEvidence,
  );
  await assert.rejects(
    verifyRecoveryEvidence(root, ["artifact:unknown"], facts.verifiedEvidence),
    /not owned/i,
  );
});

test("recovery catalog assigns stable Host refs to transcript and id-less history observations", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const taskCase = recoveryTaskCase([{ kind: "tool", output: "observed" }]);
  const facts = await resolvedRecoveryFacts(root, taskCase);
  assert.equal(facts.catalog.length, 2);
  assert.match(facts.catalog[1]?.ref ?? "", /^event:history-0-[a-f0-9]{16}$/);
  assert.ok(facts.evidenceRefs.includes(facts.catalog[1]?.ref ?? ""));
  const observation = recoveryObservationTools(taskCase).find(
    (tool) => tool.name === "read_observation",
  );
  assert.ok(observation);
  const page = await observation.execute(
    { source: "historical_events" },
    new AbortController().signal,
  );
  const rows = JSON.parse(page.content) as {
    ref: string;
    observation: unknown;
  }[];
  assert.equal(rows[0]?.ref, facts.catalog[1]?.ref);
  assert.deepEqual(rows[0]?.observation, { kind: "tool", output: "observed" });
});

test("read_observation truncates oversized historical pages", async () => {
  const huge = { kind: "tool", output: "x".repeat(40_000) };
  const taskCase = recoveryTaskCase([huge, huge]);
  const observation = recoveryObservationTools(taskCase).find((item) => item.name === "read_observation");
  assert.ok(observation);
  const page = await observation.execute({ source: "historical_events", maxItems: 8 }, new AbortController().signal);
  const rows = JSON.parse(page.content) as unknown[];
  assert.equal(rows.length, 1);
  assert.equal(page.details && (page.details as { truncated?: boolean }).truncated, true);
  assert.equal((page.details as { nextCursor?: number }).nextCursor, 1);
});

test("Git facts preserve an unborn repository and distinguish a non-repository", async (t) => {
  const root = await workspace();
  const nonRepo = await workspace();
  t.after(async () => {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    await rm(nonRepo, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  await git(root, ["init"]);
  const unborn = await resolvedRecoveryFacts(root, recoveryTaskCase([]));
  assert.deepEqual(unborn.git, {
    isRepo: true,
    headState: "unborn",
    dirtyPaths: [],
    untrackedPaths: ["input.txt"],
    statusAvailable: true,
  });
  const plain = await resolvedRecoveryFacts(nonRepo, recoveryTaskCase([]));
  assert.deepEqual(plain.git, {
    isRepo: false,
    headState: "unborn",
    dirtyPaths: [],
    untrackedPaths: [],
    statusAvailable: false,
  });
  assert.deepEqual(plain.operations, [
    { operation: "evidence_catalog", availability: "available", attempts: 1 },
    {
      operation: "repository",
      availability: "unavailable",
      attempts: 1,
      reason: "nonzero_exit",
    },
    {
      operation: "head",
      availability: "unavailable",
      attempts: 1,
      reason: "not_repository",
    },
    {
      operation: "status",
      availability: "unavailable",
      attempts: 1,
      reason: "not_repository",
    },
  ]);
  assert.ok(
    unborn.operations.some(
      (operation) =>
        operation.operation === "head" && operation.reason === "unborn_head",
    ),
  );
  assert.ok(
    unborn.operations.some(
      (operation) =>
        operation.operation === "status" &&
        operation.availability === "available",
    ),
  );
});

test("Git facts ignore a parent repository when the source root is not itself a repo", async (t) => {
  const outer = await workspace();
  const inner = join(outer, "nested-source");
  t.after(() => rm(outer, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await git(outer, ["init"]);
  await mkdir(inner);
  await writeFile(join(inner, "notes.txt"), "task\n");
  const facts = await resolvedRecoveryFacts(inner, recoveryTaskCase([]));
  assert.equal(facts.git?.isRepo, false);
});

function recoveryTaskCase(
  historicalEvents: Record<string, unknown>[],
): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-catalog",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message-1", role: "user", text: "task" },
    transcript: [{ id: "message-1", role: "user", text: "task" }],
    historicalEvents,
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: {
      packVersion: "test",
      importedAt: "2026-08-14T00:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}

test("read_observation is the only frozen-history tool", async () => {
  const taskCase = recoveryTaskCase([
    { command: "npm test", output: "updated src/recovery.ts" },
  ]);
  const tools = recoveryObservationTools(taskCase);
  assert.deepEqual(tools.map((item) => item.name), ["read_observation"]);
  const page = JSON.parse(
    (await tools[0]?.execute({ source: "historical_events" }, new AbortController().signal))?.content ?? "[]",
  ) as { ref?: string }[];
  assert.ok(page.length > 0);
  assert.ok(page.every((entry) => typeof entry.ref === "string"));
});

test("frozen observation reads retry once and report an unavailable evidence source", async () => {
  const attempts: unknown[] = [];
  let reads = 0;
  const observation = recoveryObservationTools(recoveryTaskCase([]), {
    beforeRead: async () => {
      reads += 1;
      throw new Error("simulated frozen evidence read failure");
    },
    onOperation: async (operation) => {
      attempts.push(operation);
    },
  }).find((item) => item.name === "read_observation");
  assert.ok(observation);
  const result = await observation.execute(
    { source: "transcript" },
    new AbortController().signal,
  );
  assert.equal(reads, 2);
  assert.equal(result.content, "[]");
  assert.deepEqual(result.details, {
    operation: "read_observation",
    available: false,
    reason: "frozen_evidence_error",
    source: "transcript",
    start: 0,
  });
  assert.deepEqual(attempts, [
    {
      operation: "read_observation",
      availability: "unavailable",
      attempts: 2,
      reason: "frozen_evidence_error",
    },
  ]);
});

test("bounded workspace reads retry once and degrade with Host-owned diagnostics", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const operations: unknown[] = [];
  let directoryAttempts = 0;
  const list = tool(root, "ls", {
    filesystem: {
      readDirectory: async () => {
        directoryAttempts += 1;
        throw new Error("simulated directory I/O failure");
      },
    },
    onOperation: async (operation: unknown) => {
      operations.push(operation);
    },
  });
  const listed = await list.execute({}, new AbortController().signal);
  assert.equal(directoryAttempts, 2);
  assert.equal(listed.content, "[]");
  assert.deepEqual(listed.details, {
    path: ".",
    available: false,
    reason: "filesystem_error",
  });
  assert.deepEqual(operations, [
    {
      operation: "directory_list",
      availability: "unavailable",
      attempts: 2,
      reason: "filesystem_error",
    },
  ]);

  let fileAttempts = 0;
  const reads: unknown[] = [];
  const read = tool(root, "read", {
    filesystem: {
      readRegularFile: async () => {
        fileAttempts += 1;
        throw new Error("simulated file I/O failure");
      },
    },
    onOperation: async (operation: unknown) => {
      reads.push(operation);
    },
  });
  const result = await read.execute(
    { path: "input.txt" },
    new AbortController().signal,
  );
  assert.equal(fileAttempts, 2);
  assert.equal(result.content, "");
  assert.deepEqual(result.details, {
    path: "input.txt",
    offset: 0,
    available: false,
    reason: "filesystem_error",
  });
  assert.deepEqual(reads, [
    {
      operation: "file_read",
      availability: "unavailable",
      attempts: 2,
      reason: "filesystem_error",
    },
  ]);
});

test("workspace listing stays bounded and shell_exec git log omits blob bodies", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "child.txt"), "nested\n");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "reprise@example.test"]);
  await git(root, ["config", "user.name", "Reprise Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "record metadata only"]);
  await writeFile(join(root, "secret.txt"), "object-body-must-not-appear\n");
  await git(root, ["add", "secret.txt"]);
  await git(root, ["commit", "-m", "second commit"]);
  const listed = await tool(root, "ls").execute({ depth: 0 }, new AbortController().signal);
  assert.match(listed.content, /input\.txt/);
  assert.match(listed.content, /directory nested/);
  assert.doesNotMatch(listed.content, /child\.txt/);
  const history = await tool(root, "shell_exec").execute(
    { command: "git log -1 --format=%s" },
    new AbortController().signal,
  );
  assert.match(history.content, /second commit/);
  assert.doesNotMatch(history.content, /object-body-must-not-appear/);
});

test("retired Recovery tools are not registered", () => {
  const names = recoveryTools(".").map((item) => item.name);
  for (const name of ["submit_recovery_plan", "write_binary_file", "rename_file", "inspect_workspace"]) {
    assert.equal(names.includes(name), false);
  }
});

test("controlled Recovery delta replay requires and verifies immutable postimage bytes", async () => {
  const bytes = Buffer.from("restored binary\0bytes", "utf8");
  const entry = {
    schemaVersion: 1 as const,
    tool: "write_binary_file" as const,
    phase: "after" as const,
    path: "output.bin",
    after: {
      kind: "file" as const,
      size: bytes.byteLength,
      contentHash: sha256(bytes),
      artifactId: "recovery-blob-output",
    },
  };
  const before = {
    schemaVersion: 1 as const,
    tool: "write_binary_file" as const,
    phase: "before" as const,
    path: "output.bin",
  };
  const journal = [before, entry];
  const replayed = await replayControlledRecoveryDeltaBytes(
    journal,
    async (artifactId) => {
      assert.equal(artifactId, "recovery-blob-output");
      return bytes;
    },
  );
  assert.deepEqual(Buffer.from(replayed.get("output.bin")?.bytes ?? []), bytes);
  await assert.rejects(
    replayControlledRecoveryDeltaBytes(
      [before, { ...entry, after: (({ artifactId: _artifactId, ...after }) => after)(entry.after) }],
      async () => bytes,
    ),
    /immutable artifact/i,
  );
  await assert.rejects(
    replayControlledRecoveryDeltaBytes(journal, async () => Buffer.from("tampered")),
    /integrity/i,
  );
});

test("shell_exec reports a missing Windows executable without leaking command details", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows executable matrix case");
    return;
  }
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const shell = tool(root, "shell_exec", { shellExecutable: join(root, "missing-pwsh.exe") });
  await assert.rejects(
    shell.execute({ command: "echo should-not-run" }, new AbortController().signal),
    (error: unknown) =>
      error instanceof Error &&
      /ENOENT/.test(error.message) &&
      /未找到 PowerShell/.test(error.message) &&
      !/echo should-not-run/.test(error.message),
  );
});

test("shell_exec uses PATH pwsh, Bypass, UTF-8 prefix, and argv command on a short cwd", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows argv case");
    return;
  }
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const pwsh = join(root, "pwsh.exe");
  await writeFile(pwsh, "");
  const capture: { command?: string; args?: readonly string[]; env?: NodeJS.ProcessEnv } = {};
  const shell = tool(root, "shell_exec", {
    findExecutableOnPath: (name: string) => (name === "pwsh.exe" ? pwsh : undefined),
    spawnProcess: capturingSpawner(capture),
  });
  await shell.execute({ command: "Get-Location" }, new AbortController().signal);
  assert.equal(capture.command, pwsh);
  assert.deepEqual(capture.args?.slice(0, 5), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.match(String(capture.args?.at(-1)), /OutputEncoding/);
  assert.match(String(capture.args?.at(-1)), /Get-Location/);
  assert.equal(capture.env?.REPRISE_RECOVERY_COMMAND, undefined);
});

test("shell_exec reports a missing staging directory without MAX_PATH or executable wording", async () => {
  const missing = join(tmpdir(), `reprise-missing-cwd-${Date.now()}`);
  const shell = tool(missing, "shell_exec");
  await assert.rejects(
    shell.execute({ command: "Get-Location" }, new AbortController().signal),
    (error: unknown) =>
      error instanceof Error &&
      /Working directory does not exist/.test(error.message) &&
      !/MAX_PATH/.test(error.message) &&
      !/未找到 PowerShell/.test(error.message),
  );
});

test("shell_exec mutates staging when the workspace path exceeds Windows MAX_PATH", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows CreateProcess MAX_PATH case");
    return;
  }
  let root = await mkdtemp(join(tmpdir(), "reprise-maxpath-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  while (root.length < 270) {
    root = join(root, "seg01234567");
    await mkdir(root, { recursive: true });
  }
  await writeFile(join(root, "input.txt"), "original\r\n");
  const shell = tool(root, "shell_exec");
  const signal = new AbortController().signal;
  await shell.execute({ command: "'probe' | Set-Content -LiteralPath probe.txt" }, signal);
  assert.match(await readFile(join(root, "probe.txt"), "utf8"), /probe/);
  await shell.execute({ command: "Remove-Item -LiteralPath input.txt" }, signal);
  await assert.rejects(readFile(join(root, "input.txt")));
});

test("shell_exec long cwd keeps the command in IEX environment variables", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows CreateProcess MAX_PATH case");
    return;
  }
  let root = await mkdtemp(join(tmpdir(), "reprise-maxpath-iex-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  while (root.length < 270) {
    root = join(root, "seg01234567");
    await mkdir(root, { recursive: true });
  }
  const capture: { args?: readonly string[]; env?: NodeJS.ProcessEnv } = {};
  const shell = tool(root, "shell_exec", { spawnProcess: capturingSpawner(capture) });
  await shell.execute({ command: "Remove-Item -LiteralPath input.txt" }, new AbortController().signal);
  assert.match(String(capture.args?.at(-1)), /Invoke-Expression/);
  assert.match(String(capture.env?.REPRISE_RECOVERY_COMMAND), /OutputEncoding/);
  assert.match(String(capture.env?.REPRISE_RECOVERY_COMMAND), /Remove-Item/);
  assert.equal(capture.env?.REPRISE_RECOVERY_CWD, root);
});

test("ls treats omitted path, dot, and dot-slash as the staging root", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const listing = tool(root, "ls");
  const signal = new AbortController().signal;
  const omitted = JSON.parse((await listing.execute({}, signal)).content) as string[];
  const dot = JSON.parse((await listing.execute({ path: "." }, signal)).content) as string[];
  const slashDot = JSON.parse((await listing.execute({ path: "./" }, signal)).content) as string[];
  assert.deepEqual(dot, omitted);
  assert.deepEqual(slashDot, omitted);
  await assert.rejects(listing.execute({ path: ".." }, signal));
  await assert.rejects(listing.execute({ path: "C:/outside" }, signal));
});




