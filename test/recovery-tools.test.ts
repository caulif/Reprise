import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  recoveryTools,
  resolvedRecoveryFacts,
  verifyRecoveryEvidence,
} from "../src/infrastructure/recovery-tools.js";
import { sha256 } from "../src/core/identity.js";
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

function tool(root: string, name: string, maxToolCalls = 64, options = {}) {
  const found = recoveryTools(root, maxToolCalls, options).find(
    (item) => item.name === name,
  );
  assert.ok(found, `missing ${name}`);
  return found;
}

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e "${script}"`;
}

test("structured recovery tools reject traversal, absolute paths, backslashes and symlink targets", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
});

test("staging_shell runs arbitrary staging commands with a clean temporary environment", async (t) => {
  const root = await workspace();
  const homeRoot = join(root, "harness-home");
  const previousApiKey = process.env.REPRISE_TEST_API_KEY;
  process.env.REPRISE_TEST_API_KEY = "do-not-leak";
  t.after(async () => {
    if (previousApiKey === undefined) delete process.env.REPRISE_TEST_API_KEY;
    else process.env.REPRISE_TEST_API_KEY = previousApiKey;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const shell = tool(root, "staging_shell", 64, { homeRoot });
  await shell.execute(
    { command: "echo from-shell> shell-output.txt" },
    new AbortController().signal,
  );
  assert.equal(
    await readFile(join(root, "shell-output.txt"), "utf8"),
    "from-shell\r\n",
  );

  const environment = await shell.execute(
    {
      command: nodeCommand(
        "process.stdout.write(`${process.env.HOME}|${process.env.REPRISE_TEST_API_KEY ?? 'missing'}`)",
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

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

test("recovery tool budget rejects the 65th call", async () => {
  const root = await workspace();
  try {
    const list = tool(root, "list_dir");
    for (let index = 0; index < 64; index += 1) {
      await list.execute({}, new AbortController().signal);
    }
    await assert.rejects(
      list.execute({}, new AbortController().signal),
      /budget/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("resolved Recovery facts admit only mechanically valid preimages and verified Git evidence", async (t) => {
  const root = await workspace();
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
