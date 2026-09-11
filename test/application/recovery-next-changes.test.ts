import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RecoveryAgentPort } from "../../src/agents/recovery-agent.js";
import { recoverExperiment } from "../../src/application/recovery/recover.js";
import { LocalWorkspaceProvider } from "../../src/environment/local-workspace-provider.js";
import { copyTree } from "../../src/environment/local-workspace-fs.js";
import { SNAPSHOT_LIMITS } from "../../src/environment/snapshots.js";
import { now, VerifiedRuntime, input } from "../codex-experiment-support.js";

const exec = promisify(execFile);
const TOOLS = ["edit", "find", "grep", "ls", "read", "shell_exec", "write"] as const;

function readyRecovery(sessionId: string): RecoveryAgentPort {
  return {
    recover: async (_context, tools) => {
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...TOOLS]);
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nReady.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId,
        value: {
          status: "ready",
          summary: "Workspace is ready for the original task.",
          reportPath: "recovery.md",
          unresolved: [],
        },
      };
    },
  };
}

test("G1-style over-budget source still starts Recovery and can seal a sparse copy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-g1-fixture-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source");
  await mkdir(join(source, "apps", "desktop", "src"), { recursive: true });
  await mkdir(join(source, "node_modules", "leftpad"), { recursive: true });
  await mkdir(join(source, "dist"), { recursive: true });
  await writeFile(join(source, "apps", "desktop", "src", "ui.ts"), "export const page = 1;\n");
  await writeFile(join(source, "apps", "desktop", "src", "ui.ts.bak"), "export const page = 0;\n");
  await writeFile(join(source, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
  await writeFile(join(source, "dist", "bundle.js"), "built\n");
  await writeFile(join(source, "package.json"), '{"name":"desktop"}\n');
  await writeFile(join(source, "NEW-SLIDE.pptx"), "successor\n");
  const provider = new LocalWorkspaceProvider(join(root, "env"), copyTree, {
    files: 3,
    totalBytes: SNAPSHOT_LIMITS.totalBytes,
    fileBytes: SNAPSHOT_LIMITS.fileBytes,
  });
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (context, tools) => {
      assert.equal(context.staging.seed, "sparse");
      const signal = new AbortController().signal;
      const read = tools.find((tool) => tool.name === "read");
      const write = tools.find((tool) => tool.name === "write");
      assert.ok(read && write);
      const ui = await read.execute({ path: "source/apps/desktop/src/ui.ts.bak" }, signal);
      await write.execute({ path: "workspace/apps/desktop/src/ui.ts", content: ui.content }, signal);
      await write.execute({ path: "workspace/package.json", content: '{"name":"desktop"}\n' }, signal);
      await write.execute({ path: "recovery.md", content: "# Recovery\n\nRestored the pre-task UI file.\n" }, signal);
      return {
        status: "completed",
        sessionId: "g1-sparse",
        value: {
          status: "ready",
          summary: "Restored the pre-task UI file without node_modules.",
          reportPath: "recovery.md",
          unresolved: ["node_modules can be rebuilt"],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: "g1-desktop-ui",
    experimentId: "g1-desktop-ui",
    runId: "g1-desktop-ui-run",
    sourceRoot: source,
    taskCase: { ...base.taskCase, caseId: "g1-desktop-ui" },
    recovery,
    now,
    environmentProvider: provider,
  });
  assert.equal(attempt.baseline.match, "recovered");
  assert.equal(attempt.baseline.recovery?.summary, "Restored the pre-task UI file without node_modules.");
  assert.equal(await readFile(join(attempt.baseline.root ?? "", "apps", "desktop", "src", "ui.ts"), "utf8"), "export const page = 0;\n");
  await assert.rejects(stat(join(attempt.baseline.root ?? "", "node_modules")));
  await assert.rejects(stat(join(attempt.baseline.root ?? "", "dist")));
  await assert.rejects(stat(join(attempt.baseline.root ?? "", "NEW-SLIDE.pptx")));
});

test("G1-style missing critical input returns blocked without rewriting summary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-g1-blocked-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "README.md"), "no task file\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nBlocked.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "g1-blocked",
        value: {
          status: "blocked",
          summary: "The original spreadsheet is missing from source.",
          reportPath: "recovery.md",
          unresolved: ["apps/desktop/src/ui.ts is missing"],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "g1-blocked",
    runId: "g1-blocked-run",
    sourceRoot: source,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "blocked");
  assert.equal(attempt.baseline.recovery?.summary, "The original spreadsheet is missing from source.");
  assert.equal(attempt.baseline.match, "observational");
  assert.equal(attempt.accept === undefined, true);
});

test("model transport failure keeps the workspace; workspace damage resets from turn 1", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-retry-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "keep.txt"), "keep\n");
  let calls = 0;
  let released = 0;
  const retries: string[] = [];
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "failed",
          sessionId: "retry-1",
          failure: { code: "agent_failure", kind: "transient_network", message: "upstream blip", attempts: 1 },
        };
      }
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "marker.txt", content: "kept-across-transport-retry" },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nReady after transport retry.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "retry-2",
        value: {
          status: "ready",
          summary: "Ready after a transport retry.",
          reportPath: "recovery.md",
          unresolved: [],
        },
      };
    },
    releasePreparation: () => {
      released += 1;
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "retry-transport",
    runId: "retry-transport-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => {
      if (event.type === "recovery.model_retry") retries.push(String((event.payload as { previousFailure?: unknown }).previousFailure));
    },
  });
  assert.equal(calls, 2);
  assert.equal(released, 1);
  assert.equal(retries.includes("workspace_damaged"), false);
  assert.equal(await readFile(join(attempt.baseline.root ?? "", "marker.txt"), "utf8"), "kept-across-transport-retry");
  assert.equal(attempt.baseline.match, "recovered");
});

test("workspace damage discards staging and restarts Recovery from turn 1", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-damage-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "keep.txt"), "keep\n");
  let calls = 0;
  let released = 0;
  const retries: string[] = [];
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      calls += 1;
      if (calls === 1) {
        return {
          status: "failed",
          sessionId: "damage-1",
          failure: { code: "agent_failure", kind: "tool", message: "staging workspace is missing", attempts: 1 },
        };
      }
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nReady after workspace reset.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "damage-2",
        value: {
          status: "ready",
          summary: "Ready after the workspace was reset.",
          reportPath: "recovery.md",
          unresolved: [],
        },
      };
    },
    releasePreparation: () => {
      released += 1;
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "retry-damage",
    runId: "retry-damage-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => {
      if (event.type === "recovery.model_retry") {
        retries.push(String((event.payload as { previousFailure?: unknown }).previousFailure));
      }
    },
  });
  assert.equal(calls, 2);
  assert.equal(released, 2);
  assert.equal(retries.includes("workspace_damaged"), true);
  assert.equal(attempt.baseline.match, "recovered");
});

test("current result indistinguishable from the start returns blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-indistinguishable-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "report.md"), "# finished answer\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nCannot tell start from result.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "indistinguishable",
        value: {
          status: "blocked",
          summary: "Current files already contain the task result and cannot be cleared.",
          reportPath: "recovery.md",
          unresolved: ["report.md may already be the finished answer"],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "indistinguishable",
    runId: "indistinguishable-run",
    sourceRoot: source,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "blocked");
  assert.equal(attempt.baseline.recovery?.summary, "Current files already contain the task result and cannot be cleared.");
  assert.equal(attempt.accept === undefined, true);
});

test("external non-core difference can stay ready", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-external-gap-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "brief.md"), "write a memo\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "brief.md", content: "write a memo\n" },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nRemote cache differs; task can start.\n" },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "external-gap",
        value: {
          status: "ready",
          summary: "Remote cache differs but the original task can start.",
          reportPath: "recovery.md",
          unresolved: ["npm cache on another machine is unobserved"],
        },
      };
    },
  };
  const attempt = await recoverExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "external-gap",
    runId: "external-gap-run",
    sourceRoot: source,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "ready");
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.recovery?.summary, "Remote cache differs but the original task can start.");
});

test("Git and non-Git sources share the same Recovery tools and envelope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-git-iso-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (const kind of ["git", "office"] as const) {
    const source = join(root, `${kind}-source`);
    await mkdir(source, { recursive: true });
    await writeFile(join(source, kind === "git" ? "main.ts" : "notes.xlsx"), "task\n");
    if (kind === "git") {
      await exec("git", ["init"], { cwd: source, windowsHide: true });
    }
    const base = input(join(root, kind), new VerifiedRuntime());
    const attempt = await recoverExperiment({
      dataDir: base.dataDir,
      caseId: `${kind}-case`,
      experimentId: `${kind}-exp`,
      runId: `${kind}-run`,
      sourceRoot: source,
      taskCase: { ...base.taskCase, caseId: `${kind}-case` },
      recovery: readyRecovery(`${kind}-session`),
      now,
    });
    assert.equal(attempt.baseline.recovery?.status, "ready");
    assert.equal(attempt.recovery.status, "completed");
    if (attempt.recovery.status === "completed") assert.equal(attempt.recovery.value.status, "ready");
  }
});
