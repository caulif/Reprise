import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import { recoverCodexExperiment } from "../src/application/experiment.js";
import type { TaskCase } from "../src/core/schema.js";
import { now, VerifiedRuntime, input } from "./codex-experiment-support.js";

test("Recovery keeps the first valid partial when a later completed envelope fails probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-keep-probed-envelope-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const task = {
    ...base.taskCase,
    taskContext: { ...base.taskCase.taskContext, relevantPaths: ["README.md"] },
  } as TaskCase;
  const events: { type: string; payload: unknown }[] = [];
  let calls = 0;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      calls += 1;
      const evidenceRef = _context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      if (calls === 1) {
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "notes.txt", content: "recovered note\n" },
          new AbortController().signal,
        );
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "recovery.md", content: "# Recovery\n\nFirst envelope should stay." },
          new AbortController().signal,
        );
        return {
          status: "completed",
          sessionId: "recovery-keep-probed",
          value: {
            status: "partial",
            reportPath: "recovery.md",
            manifestPath: "recovery-manifest.json",
            unresolved: ["README.md is not reconstructed"],
            evidenceRefs: [evidenceRef],
          },
        };
      }
      return {
        status: "completed",
        sessionId: "recovery-keep-probed-later",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: [],
          evidenceRefs: ["event:not-owned-ref"],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-keep-probed",
    runId: "recovery-keep-probed-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(calls, 2);
  assert.equal(attempt.accept !== undefined, true);
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.root?.includes("baselines"), true);
  assert.equal(attempt.baseline.match, "recovered_partial");
  assert.equal(attempt.baseline.recovery?.status, "partial");
  assert.equal(
    events.some(
      (event) =>
        event.type === "recovery.warning" &&
        (event.payload as { keptCompletedEnvelope?: boolean }).keptCompletedEnvelope === true,
    ),
    true,
  );
});

test("Recovery still falls back when the only completed envelope fails probe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-only-invalid-envelope-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nInvalid only envelope." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-only-invalid",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: [],
          evidenceRefs: ["event:not-owned-ref"],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-only-invalid",
    runId: "recovery-only-invalid-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    now,
  });
  assert.equal(attempt.accept === undefined, true);
  assert.equal(attempt.acceptedAutomatically, undefined);
  assert.equal(attempt.baseline.match, "current_state_fallback");
});

test("Recovery still completes after more than sixteen destructive shell_exec calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-delete-uncapped-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  for (let index = 0; index < 17; index += 1) {
    await writeFile(join(base.sourceRoot, `scratch-${index}.txt`), "x\n");
  }
  const task = {
    ...base.taskCase,
    taskContext: { ...base.taskCase.taskContext, relevantPaths: ["README.md"] },
  } as TaskCase;
  let calls = 0;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      calls += 1;
      const evidenceRef = _context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      const remove = tools.find((tool) => tool.name === "shell_exec");
      const signal = new AbortController().signal;
      for (let index = 0; index < 17; index += 1) {
        await remove?.execute({ command: `Remove-Item -LiteralPath scratch-${index}.txt` }, signal);
      }
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nDeletes are not capped by a Host tool budget." },
        signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-delete-uncapped",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: ["README.md is not reconstructed"],
          evidenceRefs: [evidenceRef],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-delete-uncapped",
    runId: "recovery-delete-uncapped-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxModelAttempts: 3,
    now,
  });
  assert.ok(calls >= 1);
  assert.equal(attempt.accept !== undefined, true);
});


