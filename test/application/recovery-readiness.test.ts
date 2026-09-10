import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRecoveryReadiness, deriveRecoveryReadinessContext } from "../../src/application/recovery/readiness.js";
import type { TaskCase, RecoveryReadinessContext } from "../../src/core/schema.js";

test("Recovery readiness derives task paths and reports a missing path", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-"));
  await mkdir(join(root, "content"), { recursive: true });
  await writeFile(join(root, "content", "chapter.md"), "draft\n");
  const taskCase = {
    schemaVersion: 1, caseId: "case-1", source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "Continue content/chapter.md with npm test" },
    transcript: [], historicalEvents: [], baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] }, provenance: { packVersion: "1", importedAt: "2026-08-22T00:00:00.000Z", sourceHash: "a".repeat(64) },
    taskContext: { relevantPaths: ["content/chapter.md"] }, privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  };
  const context = deriveRecoveryReadinessContext(taskCase as TaskCase);
  assert.deepEqual(context.relevantPaths, ["content/chapter.md"]);
  assert.equal((await checkRecoveryReadiness(root, context)).status, "ready");
  const missing = await checkRecoveryReadiness(root, { ...context, relevantPaths: [...context.relevantPaths, "content/missing.md"] });
  assert.equal(missing.status, "not_ready");
  assert.deepEqual(missing.missingPaths, ["content/missing.md"]);
});

test("Recovery readiness blocks paths outside staging", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-"));
  const result = await checkRecoveryReadiness(root, {
    schemaVersion: 1, taskSummary: "task", observedWorkspaces: [], relevantPaths: ["../outside.txt"], priorCommands: [], availableChecks: ["inspect"],
  });
  assert.equal(result.status, "blocked");
});

test("Recovery readiness treats an empty path list as ready after Host accepted the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-no-path-"));
  const result = await checkRecoveryReadiness(root, {
    schemaVersion: 1,
    taskSummary: "Continue the historical task.",
    observedWorkspaces: [root],
    relevantPaths: [],
    priorCommands: [],
    availableChecks: ["inspect required paths and task inputs"],
  });
  assert.equal(result.status, "ready");
  assert.match(result.feedback, /No extra task paths/);
});


test("Recovery readiness derives safe historical touched paths", () => {
  const taskCase = {
    schemaVersion: 1,
    caseId: "case-touched-paths",
    evidenceLevel: "transcript",
    source: { productId: "codex", sessionId: "session-touched-paths" },
    initialInput: { id: "message-1", role: "user", text: "Continue the task." },
    transcript: [], historicalEvents: [],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: {
      historicalCwd: "C:\\workspace",
      historicalBehavior: { commands: [], touchedPaths: ["C:\\workspace\\README.md", "C:\\outside.txt", "src\\main.ts"] },
    },
    provenance: { packVersion: "1", importedAt: "2026-08-22T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  } as TaskCase;
  assert.deepEqual(deriveRecoveryReadinessContext(taskCase).relevantPaths, ["README.md", "src/main.ts"]);
});

test("Recovery readiness treats historical output paths as optional at the task start", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-outputs-"));
  const taskCase = {
    schemaVersion: 1,
    caseId: "case-output-task",
    evidenceLevel: "transcript",
    source: { productId: "claude-code", sessionId: "session-output-task" },
    initialInput: { id: "message-1", role: "user", text: "Download and organize the papers into a folder." },
    transcript: [], historicalEvents: [],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "claude-code", artifactRefs: [] },
    taskContext: {
      historicalCwd: root,
      historicalBehavior: { commands: [], touchedPaths: ["papers/result.md"] },
    },
    provenance: { packVersion: "1", importedAt: "2026-08-22T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  } as TaskCase;
  const context = deriveRecoveryReadinessContext(taskCase);
  assert.equal(context.pathSemantics, "task_outputs");
  const result = await checkRecoveryReadiness(root, context);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.missingPaths, []);
});

test("Recovery readiness still requires missing paths for input-oriented tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-inputs-"));
  const taskCase = {
    schemaVersion: 1,
    caseId: "case-input-task",
    evidenceLevel: "transcript",
    source: { productId: "codex", sessionId: "session-input-task" },
    initialInput: { id: "message-1", role: "user", text: "Continue editing the existing README.md." },
    transcript: [], historicalEvents: [],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: {
      historicalCwd: root,
      historicalBehavior: { commands: [], touchedPaths: ["README.md"] },
    },
    provenance: { packVersion: "1", importedAt: "2026-08-22T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  } as TaskCase;
  const context = deriveRecoveryReadinessContext(taskCase);
  assert.equal(context.pathSemantics, "required_inputs");
  const result = await checkRecoveryReadiness(root, context);
  assert.equal(result.status, "not_ready");
  assert.deepEqual(result.missingPaths, ["README.md"]);
});


test("Recovery readiness does not execute historical commands without explicit opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-command-disabled-"));
  await writeFile(join(root, "input.txt"), "input\n");
  const context = {
    schemaVersion: 1, taskSummary: "task", observedWorkspaces: [root], relevantPaths: ["input.txt"],
    priorCommands: ["node -e \"require('fs').writeFileSync('unexpected.txt','x')\""], availableChecks: ["replay"],
  };
  const result = await checkRecoveryReadiness(root, context as RecoveryReadinessContext);
  assert.equal(result.status, "ready");
  assert.equal(result.commandChecks[0]?.status, "not_run");
  assert.equal(await import("node:fs/promises").then(({ access }) => access(join(root, "unexpected.txt")).then(() => true, () => false)), false);
});

test("Recovery readiness runs only allowlisted commands in staging when opted in", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-readiness-command-enabled-"));
  await writeFile(join(root, "input.txt"), "input\n");
  const context = {
    schemaVersion: 1, taskSummary: "task", observedWorkspaces: [root], relevantPaths: ["input.txt"],
    priorCommands: ["node -p 1", "node -e \"process.exit(0)\""], availableChecks: ["replay"],
  };
  const result = await checkRecoveryReadiness(root, context as RecoveryReadinessContext, { executeCommands: true });
  assert.equal(result.status, "not_ready");
  assert.equal(result.commandChecks[0]?.status, "passed");
  assert.equal(result.commandChecks[1]?.status, "blocked");
});
