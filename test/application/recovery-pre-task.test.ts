import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RecoveryAgentPort } from "../../src/agents/recovery-agent.js";
import { recoverExperiment } from "../../src/application/recovery/recover.js";
import {
  evaluateRecoveryPreTaskConditions,
} from "../../src/environment/recovery-pre-task.js";
import type { TaskCase } from "../../src/core/schema.js";
import { now, VerifiedRuntime, input } from "../codex-experiment-support.js";

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}

async function commitTree(root: string, message: string, body: string): Promise<string> {
  await writeFile(join(root, "README.md"), body);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", message]);
  return (await git(root, ["rev-parse", "HEAD"])).trim();
}

function taskCase(overrides: Partial<TaskCase> & { historicalEvents?: TaskCase["historicalEvents"]; taskContext?: TaskCase["taskContext"] }): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "pre-task-case",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message", role: "user", text: "task" },
    transcript: [{ id: "message", role: "user", text: "task" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: now, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
    ...overrides,
  };
}

test("ready is refused when HEAD already equals the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-head-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  const taskCommit = await commitTree(root, "task", "done\n");
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase({
    historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
  }));
  assert.equal(check.readyAllowed, false);
  assert.equal(check.head, taskCommit);
  assert.equal(check.taskCommit, taskCommit);
  assert.equal(check.preTaskCommit, preTask);
  assert.match(check.reasons.join(" "), /historical task commit/);
});

test("ready is allowed when HEAD is the parent of the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-parent-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  const taskCommit = await commitTree(root, "task", "done\n");
  await git(root, ["checkout", "--force", preTask]);
  const check = await evaluateRecoveryPreTaskConditions(root, taskCase({
    historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
    taskContext: { historicalCommit: preTask },
  }));
  assert.equal(check.readyAllowed, true);
  assert.equal(check.head, preTask);
});

test("post-task dirty files block ready except required dependency trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-dirty-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  const preTask = await commitTree(root, "before", "start\n");
  await writeFile(join(root, "notes.md"), "later notes\n");
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const dirty = await evaluateRecoveryPreTaskConditions(root, taskCase({
    taskContext: { historicalCommit: preTask },
    historicalEvents: [{ timestamp: "2020-01-01T00:00:00.000Z" }],
  }));
  assert.equal(dirty.readyAllowed, false);
  assert.ok(dirty.dirtyPaths.includes("notes.md"));
  assert.equal(dirty.dirtyPaths.some((path) => path.startsWith("node_modules/")), false);
  await rm(join(root, "notes.md"));
  const clean = await evaluateRecoveryPreTaskConditions(root, taskCase({
    taskContext: { historicalCommit: preTask },
    historicalEvents: [{ timestamp: "2020-01-01T00:00:00.000Z" }],
  }));
  assert.equal(clean.readyAllowed, true);
});

test("Recovery does not accept ready when staging HEAD is the historical task commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-pre-task-recover-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await git(source, ["init"]);
  await commitTree(source, "before", "start\n");
  const taskCommit = await commitTree(source, "task", "done\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nReady without resetting HEAD.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-pre-task",
        value: {
          status: "ready",
          summary: "The work copy is ready for the original task.",
          reportPath: "recovery.md",
          unresolved: [],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-pre-task-head",
    runId: "recovery-pre-task-head-run",
    sourceRoot: source,
    taskCase: {
      ...base.taskCase,
      historicalEvents: [{ timestamp: "2026-09-16T00:00:00.000Z", commit: taskCommit }],
    },
    recovery,
    maxModelAttempts: 1,
    now,
  });
  assert.equal(attempt.acceptedAutomatically, undefined);
  assert.equal(typeof attempt.accept, "undefined");
  assert.notEqual(attempt.baseline.recovery?.status, "ready");
  assert.equal(attempt.baseline.readiness.runnable, "blocked");
  assert.match(attempt.baseline.warnings.join("\n"), /historical task commit/);
});

test("pre-task git probes do not pass caret peel to git.cmd", async () => {
  const source = await readFile(join(process.cwd(), "src/environment/recovery-pre-task.ts"), "utf8");
  assert.doesNotMatch(source, /\^\{commit\}/);
  assert.doesNotMatch(source, /taskCommit\}\^/);
  assert.match(source, /cat-file", "-t"/);
  assert.match(source, /~1/);
});
