import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import {
  recoveryObservationTools,
  recoveryTools,
  resolvedRecoveryFacts,
  verifyRecoveryEvidence,
} from "../src/infrastructure/recovery-tools.js";
import { sha256 } from "../src/core/identity.js";
import { replayControlledRecoveryDelta, replayControlledRecoveryDeltaBytes } from "../src/infrastructure/recovery-write-journal.js";
import type { RecoveryControlledWrite, TaskCase } from "../src/core/schema.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-tools-"));
  await writeFile(join(root, "input.txt"), "original\r\n");
  return root;
}

function tool(root: string, name: string, maxToolCalls = 64, options = {}) {
  const toolOptions = name === "staging_shell" ? { allowShell: true, ...options } : options;
  const found = recoveryTools(root, maxToolCalls, toolOptions).find(
    (item) => item.name === name,
  );
  assert.ok(found, `missing ${name}`);
  return found;
}

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}


test("general staging shell is absent unless the Host explicitly enables it", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  assert.equal(recoveryTools(root).some((item) => item.name === "staging_shell"), false);
  assert.equal(recoveryTools(root, 64, { allowShell: true }).some((item) => item.name === "staging_shell"), true);
});

test("structured recovery tools reject traversal, absolute paths, backslashes and symlink targets", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const read = tool(root, "read_file");
  for (const path of [
    "../x",
    resolve(root, "input.txt"),
    "dir\\x",
    "./input.txt",
  ]) {
    await assert.rejects(read.execute({ path }, new AbortController().signal));
  }
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
  const shell = tool(root, "staging_shell");
  await assert.rejects(
    shell.execute({ command: "type .env" }, new AbortController().signal),
    /credential_read_denied/i,
  );
});

test("Recovery model cannot read credential-class files", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await writeFile(join(root, ".env"), "TOKEN=do-not-read");
  const read = tool(root, "read_file");
  await assert.rejects(read.execute({ path: ".env" }, new AbortController().signal), /credential_read_denied/i);
});

test("direct Recovery writes journal schema-validated pre/post hashes", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const entries: unknown[] = [];
  const write = tool(root, "write_file", 64, {
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
      tool: "write_file",
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
      tool: "write_file",
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

test("direct Recovery delete journals the removed file without inventing a post-state", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const entries: unknown[] = [];
  const remove = tool(root, "delete_file", 64, {
    onControlledWrite: async (entry: unknown) => entries.push(entry),
  });
  await remove.execute({ path: "input.txt" }, new AbortController().signal);
  await assert.rejects(readFile(join(root, "input.txt")));
  assert.deepEqual(entries, [
    {
      schemaVersion: 1,
      tool: "delete_file",
      phase: "before",
      path: "input.txt",
      before: { kind: "file", size: Buffer.byteLength("original\r\n"), contentHash: sha256("original\r\n") },
    },
    {
      schemaVersion: 1,
      tool: "delete_file",
      phase: "after",
      path: "input.txt",
      before: { kind: "file", size: Buffer.byteLength("original\r\n"), contentHash: sha256("original\r\n") },
    },
  ]);
});

test("write_recovery_manifest rejects malformed and unsafe manifest paths", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const manifest = tool(root, "write_recovery_manifest");
  const signal = new AbortController().signal;
  await assert.rejects(
    manifest.execute({ actions: "not-an-array", unresolved: [] }, signal),
    /recovery_manifest_invalid/i,
  );
  await assert.rejects(
    manifest.execute(
      {
        actions: [
          {
            operation: "restore",
            path: "../outside.txt",
            evidenceRefs: ["event:history-1"],
          },
        ],
        unresolved: [],
      },
      signal,
    ),
    /staging-relative/i,
  );
  await assert.rejects(
    manifest.execute(
      {
        actions: [
          {
            operation: "restore",
            path: ".git/index",
            evidenceRefs: ["event:history-1"],
          },
        ],
        unresolved: [],
      },
      signal,
    ),
    /staging-relative/i,
  );
  await manifest.execute(
    {
      actions: [
        {
          operation: "restore",
          path: "input.txt",
          evidenceRefs: ["event:history-1"],
        },
      ],
      unresolved: [],
    },
    signal,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "recovery-manifest.json"), "utf8")),
    {
      actions: [
        {
          operation: "restore",
          path: "input.txt",
          evidenceRefs: ["event:history-1"],
        },
      ],
      unresolved: [],
    },
  );
  const write = tool(root, "write_file");
  await assert.rejects(
    write.execute({ path: "recovery-manifest.json", content: "{}" }, signal),
    /recovery_sink_reserved/i,
  );
  await assert.rejects(
    write.execute({ path: "recovery.md", content: "# bypass" }, signal),
    /recovery_sink_reserved/i,
  );
});

test("staging_shell runs arbitrary staging commands with a clean temporary environment", async (t) => {
  const root = await workspace();
  const homeRoot = join(root, "harness-home");
  const previousApiKey = process.env.REPRISE_TEST_API_KEY;
  process.env.REPRISE_TEST_API_KEY = "do-not-leak";
  t.after(async () => {
    if (previousApiKey === undefined) delete process.env.REPRISE_TEST_API_KEY;
    else process.env.REPRISE_TEST_API_KEY = previousApiKey;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  const shell = tool(root, "staging_shell", 64, { homeRoot });
  await shell.execute(
    { command: "echo from-shell> shell-output.txt" },
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
      command: `${nodeCommand("undefined")} "Authorization: Bearer ultra-secret-token"`,
    },
    new AbortController().signal,
  );
  const redactedDetails = redacted.details as { command: string };
  assert.match(redactedDetails.command, /Authorization: \[REDACTED\]/i);
  assert.doesNotMatch(redactedDetails.command, /ultra-secret-token/);

  const pipeline = await shell.execute(
    { command: "echo alpha | findstr alpha > pipe-output.txt" },
    new AbortController().signal,
  );
  assert.equal((pipeline.details as { exitCode: number }).exitCode, 0);
  assert.equal((await readFile(join(root, "pipe-output.txt"), "utf8")).trim(), "alpha");
  const nonzero = await shell.execute(
    { command: "exit /b 7" },
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

test("staging_shell times out individual commands and marks truncated output", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );

  const timedShell = tool(root, "staging_shell", 64, { shellTimeoutMs: 100 });
  await assert.rejects(
    timedShell.execute(
      { command: nodeCommand("setTimeout(() => undefined, 2000)") },
      new AbortController().signal,
    ),
    /timed out/i,
  );

  const shell = tool(root, "staging_shell");
  const output = await shell.execute(
    { command: nodeCommand("process.stdout.write('x'.repeat(300000))") },
    new AbortController().signal,
  );
  const details = output.details as { stdoutBytes: number; truncated: boolean };
  assert.equal(details.stdoutBytes, 262_144);
  assert.equal(details.truncated, true);
});

test("recovery tools reject identical calls that add no information", async () => {
  const root = await workspace();
  try {
    const list = tool(root, "list_dir");
    await list.execute({}, new AbortController().signal);
    await assert.rejects(
      list.execute({}, new AbortController().signal),
      /no_information_gain/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("recovery tool budget rejects the 65th call", async () => {
  const root = await workspace();
  try {
    const list = tool(root, "list_dir");
    for (let index = 0; index < 64; index += 1) {
      await list.execute({ path: `missing-${index}` }, new AbortController().signal);
    }
    await assert.rejects(
      list.execute({ path: "missing-64" }, new AbortController().signal),
      /budget/i,
    );
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
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

test("high-level observation tools return only bounded Host-owned clues", async () => {
  const taskCase = recoveryTaskCase([
    { command: "npm test", output: "updated src/recovery.ts" },
  ]);
  const tools = recoveryObservationTools(taskCase);
  const footprint = tools.find((item) => item.name === "derive_task_footprint");
  const search = tools.find(
    (item) => item.name === "search_recovery_artifacts",
  );
  assert.ok(footprint);
  assert.ok(search);
  const derived = JSON.parse(
    (await footprint.execute({}, new AbortController().signal)).content,
  ) as {
    ref: string;
    paths: string[];
    commands: string[];
  }[];
  assert.ok(derived.some((entry) => entry.paths.includes("src/recovery.ts")));
  assert.ok(derived.some((entry) => entry.commands.includes("npm test")));
  const found = JSON.parse(
    (await search.execute({ query: "recovery" }, new AbortController().signal))
      .content,
  ) as {
    ref: string;
    source: string;
    index: number;
    contentHash: string;
  }[];
  assert.ok(found.length > 0);
  assert.ok(
    found.every((entry) =>
      /^event:(transcript|history)-\d+-[a-f0-9]{16}$/.test(entry.ref),
    ),
  );
  assert.ok(found.every((entry) => /^[a-f0-9]{64}$/.test(entry.contentHash)));
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
  const list = tool(root, "list_dir", 64, {
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
  const read = tool(root, "read_file", 64, {
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

test("workspace and Git inspection stay bounded and never read Git object bodies", async (t) => {
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
  const inspectWorkspace = tool(root, "inspect_workspace");
  const inspected = await inspectWorkspace.execute(
    { depth: 0 },
    new AbortController().signal,
  );
  assert.match(inspected.content, /input\.txt/);
  assert.match(inspected.content, /directory nested/);
  assert.doesNotMatch(inspected.content, /child\.txt/);
  const inspectGit = tool(root, "inspect_git_history");
  const history = await inspectGit.execute(
    { depth: 1, includeReflog: true },
    new AbortController().signal,
  );
  assert.match(history.content, /second commit/);
  assert.doesNotMatch(history.content, /object-body-must-not-appear/);
});

test("submit_recovery_plan requires the structured schema and propagates Host validation", async (t) => {
  const root = await workspace();
  t.after(() =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
  const received: unknown[] = [];
  const submit = tool(root, "submit_recovery_plan", 64, {
    onPlan: async (plan: unknown) => {
      const value = plan as {
        factsUsed: string[];
        candidates: { operations: { path: string }[] }[];
      };
      if (value.factsUsed.includes("fact:unknown"))
        throw new Error("recovery_plan_unknown_fact");
      if (
        value.candidates.some((candidate) =>
          candidate.operations.some((operation) =>
            operation.path.startsWith(".git/"),
          ),
        )
      )
        throw new Error("recovery_plan_unsafe_path");
      received.push(plan);
    },
  });
  const plan = {
    planId: "plan-1",
    factsUsed: ["fact:workspace-current"],
    hypotheses: [
      {
        hypothesisId: "current-workspace",
        rationale: "inspect",
        paths: ["input.txt"],
        supportingFactRefs: ["fact:workspace-current"],
        counterFactRefs: [],
        expectedChecks: ["read file"],
        confidence: "low",
      },
    ],
    candidates: [
      {
        hypothesisId: "current-workspace",
        operations: [
          {
            operation: "modify",
            path: "input.txt",
            rationale: "candidate check",
          },
        ],
      },
    ],
    verificationPlan: ["read file"],
  };
  await submit.execute(plan, new AbortController().signal);
  assert.equal(received.length, 1);
  await assert.rejects(
    submit.execute(
      { ...plan, factsUsed: ["fact:unknown"] },
      new AbortController().signal,
    ),
    /unknown_fact/,
  );
  await assert.rejects(
    submit.execute(
      {
        ...plan,
        candidates: [
          {
            hypothesisId: "current-workspace",
            operations: [
              {
                operation: "modify",
                path: ".git/config",
                rationale: "invalid",
              },
            ],
          },
        ],
      },
      new AbortController().signal,
    ),
    /unsafe_path/,
  );
});

test("direct Recovery binary writes preserve bytes and journal only hashes", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const entries: unknown[] = [];
  const bytes = Buffer.from([0, 255, 16, 128, 1]);
  const write = tool(root, "write_binary_file", 64, {
    onControlledWrite: async (entry: unknown) => entries.push(entry),
  });
  await write.execute({ path: "output.bin", base64: bytes.toString("base64") }, new AbortController().signal);
  assert.deepEqual(await readFile(join(root, "output.bin")), bytes);
  assert.deepEqual(entries, [
    { schemaVersion: 1, tool: "write_binary_file", phase: "before", path: "output.bin" },
    {
      schemaVersion: 1,
      tool: "write_binary_file",
      phase: "after",
      path: "output.bin",
      after: { kind: "file", size: bytes.byteLength, contentHash: sha256(bytes) },
    },
  ]);
  await assert.rejects(
    write.execute({ path: "invalid.bin", base64: "AA==\n" }, new AbortController().signal),
    /canonical/i,
  );
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

test("direct Recovery rename preserves the paired file delta and rejects overwrite", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const entries: unknown[] = [];
  const move = tool(root, "rename_file", 64, {
    onControlledWrite: async (entry: unknown) => entries.push(entry),
  });
  await move.execute({ from: "input.txt", to: "nested/renamed.txt" }, new AbortController().signal);
  await assert.rejects(readFile(join(root, "input.txt")));
  assert.equal(await readFile(join(root, "nested", "renamed.txt"), "utf8"), "original\r\n");
  const file = { kind: "file", size: Buffer.byteLength("original\r\n"), contentHash: sha256("original\r\n") };
  assert.deepEqual(entries, [
    { schemaVersion: 1, tool: "rename_file", phase: "before", path: "nested/renamed.txt", sourcePath: "input.txt", before: file },
    { schemaVersion: 1, tool: "rename_file", phase: "after", path: "nested/renamed.txt", sourcePath: "input.txt", before: file, after: file },
  ]);
  await writeFile(join(root, "existing.txt"), "target");
  await assert.rejects(
    move.execute({ from: "nested/renamed.txt", to: "existing.txt" }, new AbortController().signal),
    /must not already exist/i,
  );
  await assert.rejects(
    move.execute({ from: "nested/renamed.txt", to: "nested/renamed.txt" }, new AbortController().signal),
    /different paths/i,
  );
  const replayed = replayControlledRecoveryDelta(entries as RecoveryControlledWrite[]);
  assert.equal(replayed.get("input.txt"), undefined);
  assert.deepEqual(replayed.get("nested/renamed.txt"), file);
});


test("staging_shell reports a missing Windows executable without leaking command details", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows executable matrix case");
    return;
  }
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const shell = tool(root, "staging_shell", 64, { shellExecutable: join(root, "missing-pwsh.exe") });
  await assert.rejects(
    shell.execute({ command: "echo should-not-run" }, new AbortController().signal),
    /spawn error/i,
  );
});
