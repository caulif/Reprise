import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonAgentPort } from "../src/agents/comparison-agent.js";
import { ControllerAgent, type ControllerPort } from "../src/agents/controller-agent.js";
import { controllerReadEvidenceOnRequest, reconstructControllerRequest } from "../src/application/controller-request.js";
import { preflightCodexExperiment } from "../src/application/experiment-preflight.js";
import { recoverCodexExperiment } from "../src/application/recovery/recover.js";
import { startCodexExperiment } from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/agent/host.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import type { ResolvedRuntime, TargetEventSink, TargetRunner } from "../src/core/runtime.js";
import { sha256 } from "../src/core/identity.js";
import { now, VerifiedRuntime, input, terminationOf, sendingController, patientPolicy, readJson } from "./codex-experiment-support.js";

test("trusted checkpoints restore deterministically without invoking the Recovery model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-checkpoint-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "before");
  await writeFile(join(base.sourceRoot, "delete-me.txt"), "before-delete");
  const provider = new LocalWorkspaceProvider(join(root, "provider"));
  const checkpoint = await provider.captureRecoveryCheckpoint({
    caseId: base.caseId,
    sourceRoot: base.sourceRoot,
  });
  await writeFile(join(base.sourceRoot, "README.md"), "after");
  await rm(join(base.sourceRoot, "delete-me.txt"));
  await writeFile(join(base.sourceRoot, "new.txt"), "interrupted-work");
  let modelCalled = false;
  const events: { type: string; payload: unknown }[] = [];
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "checkpoint-direct-restore",
    runId: "checkpoint-direct-restore-run",
    sourceRoot: base.sourceRoot,
    checkpointRoot: checkpoint.root,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => {
        modelCalled = true;
        throw new Error(
          "trusted checkpoint recovery must not invoke the model",
        );
      },
    },
    now,
    environmentProvider: provider,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(modelCalled, false);
  assert.equal(attempt.recovery.status, "completed");
  assert.equal(
    attempt.recovery.status === "completed" &&
      attempt.recovery.sessionId.startsWith("host-checkpoint-"),
    true,
  );
  assert.equal(attempt.baseline.match, "recovered");
  assert.equal(
    await readFile(join(attempt.staging!.root, "README.md"), "utf8"),
    "before",
  );
  assert.equal(
    await readFile(join(attempt.staging!.root, "delete-me.txt"), "utf8"),
    "before-delete",
  );
  await assert.rejects(readFile(join(attempt.staging!.root, "new.txt")));
  assert.equal(
    await readFile(join(base.sourceRoot, "README.md"), "utf8"),
    "after",
  );
  assert.equal(
    events.some((event) => event.type === "recovery.checkpoint_restored"),
    true,
  );
  const event = events.find(
    (item) => item.type === "recovery.checkpoint_restored",
  );
  assert.deepEqual(event?.payload, {
    checkpointId: checkpoint.checkpointId,
    checkpointDigest: checkpoint.fingerprint.digest,
    changedPathCount: 3,
  });
  const evaluation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-evaluation"),
      "utf8",
    ),
  ) as {
    rows: { modelCalls: number; verification: string; durationMs: number }[];
  };
  assert.deepEqual(evaluation.rows, [
    {
      schemaVersion: 1,
      caseId: base.caseId,
      layer: "interrupted_checkpoint",
      stagingSucceeded: true,
      forensicsStarted: true,
      forensicsCompleted: false,
      candidateCreated: false,
      verification: "verified",
      recoveredPaths: ["README.md", "delete-me.txt", "new.txt"],
      checkpointPaths: ["README.md", "delete-me.txt"],
      modelCalls: 0,
      durationMs: evaluation.rows[0]!.durationMs,
    },
  ]);
  await provider.discardRecovery(attempt.staging!);
});

test("preflight is read-only and successful comparison writes a persisted narrative plus Host evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-experiment-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const runtime = new VerifiedRuntime();
  const experiment = input(root, runtime);
  const preflight = await preflightCodexExperiment(experiment);
  assert.equal(preflight.sourceBaseline, "available");
  assert.equal(runtime.created, 0);
  const result = await startCodexExperiment({
    ...experiment,
    experimentId: "experiment-2",
    runId: "run-2",
  }).result;
  assert.equal(runtime.created, 1);
  assert.match(
    await readFile(join(result.experimentRoot, "report.html"), "utf8"),
    /Evidence-based narrative/,
  );
  const report = await readFile(result.reportPath, "utf8");
  assert.match(report, /<style>/);
  assert.match(report, /<svg>/);
  assert.match(report, /<script>/);
  assert.match(report, /Evidence-based narrative/);
  assert.ok(
    result.record.artifactRefs.some(
      (ref) => ref.artifactId === "candidate-workspace-scope.json",
    ),
  );
  assert.ok(
    result.record.artifactRefs.some(
      (ref) => ref.artifactId === "host-trace.json",
    ),
  );
  const persistedExperiment = await readJson(
    join(result.experimentRoot, "experiment.json"),
  );
  assert.equal(
    persistedExperiment.spec?.controller?.requestedModel,
    "test-model",
  );
  assert.equal(
    persistedExperiment.spec?.comparison?.requestedModel,
    "test-model",
  );
  const manifest = await readJson(
    join(result.experimentRoot, "runs", "run-2", "manifest.json"),
  );
  assert.equal(manifest.controller?.requestedModel, "test-model");
  assert.equal(manifest.comparison?.requestedModel, "test-model");
  const store = await ExperimentStore.open(
    result.experimentRoot,
    "experiment-2",
  );
  try {
    const runEvents = store.events("run-2");
    assert.ok(
      runEvents.some((event) => event.type === "recovery.checkpoint_captured"),
    );
    assert.match(
      JSON.stringify(store.replay("run-2").finishedPayload),
      /"state":"finished"/,
    );
    const started = runEvents.find((event) => event.type === "comparison.started");
    const attemptId = (started?.payload as { attemptId?: string } | undefined)?.attemptId;
    assert.ok(attemptId);
    const attemptRoot = join(result.experimentRoot, "comparison-attempts", attemptId);
    assert.match(await readFile(join(attemptRoot, "work", "comparison-plan.md"), "utf8"), /Compare the delivered files/);
    assert.match(await readFile(join(attemptRoot, "briefing", "candidate", "process-index.tsv"), "utf8"), /runtime\.turn_settled/);
    const requested = runEvents.find((event) => event.type === "comparison.requested");
    const requestId = (requested?.payload as { artifactId?: string } | undefined)?.artifactId;
    assert.ok(requestId);
    const requestInput = JSON.parse(Buffer.from(await store.readArtifact({ artifactId: requestId, experimentId: "experiment-2", runId: "run-2" })).toString("utf8")) as { promptContent?: string; ownedEvidenceRefs?: unknown };
    assert.equal(requestInput.ownedEvidenceRefs, undefined);
    assert.equal(runEvents.some((event) => event.type === "comparison.plan_requested"), false);
    assert.equal(runEvents.some((event) => event.type === "comparison.report_requested"), false);
    assert.equal(runEvents.some((event) => event.type === "comparison.plan_completed"), false);
    const links = JSON.parse(await readFile(join(attemptRoot, "briefing", "facts", "comparison-links.json"), "utf8")) as Array<{ side: string; reportHref?: string }>;
    assert.ok(links.some((link) => link.side === "baseline"));
    assert.ok(links.some((link) => link.side === "candidate"));
    for (const link of links) {
      if (link.reportHref) await stat(join(result.experimentRoot, ...link.reportHref.split("/")));
    }
  } finally {
    await store.close();
  }
});

test("records the latest cumulative Codex token count", async (t) => {
  class TokenRuntime extends VerifiedRuntime {
    override async createRunner(
      runtime: ResolvedRuntime,
      environment: { environmentId: string; runId: string; root: string },
      sink: TargetEventSink,
    ): Promise<TargetRunner> {
      await sink.append({
        type: "codex.token_count",
        occurredAt: now,
        payload: { info: { total_token_usage: { total_tokens: 128 } } },
      });
      await sink.append({
        type: "codex.token_count",
        occurredAt: now,
        payload: { info: { total_token_usage: { total_tokens: 256 } } },
      });
      return super.createRunner(runtime, environment, sink);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-tokens-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  const result = await startCodexExperiment(input(root, new TokenRuntime()))
    .result;
  assert.equal(result.facts?.tokenCount, 256);
});

test("a cancelled Controller decision terminates the run as cancelled, not as a Harness stall", async (t) => {
  const cancelling: ControllerPort = {
    decide: async () => ({
      status: "cancelled",
      sessionId: "controller-1",
      factRef: "run:run-1:cancelled",
    }),
  };
  const termination = await terminationOf(t, { controller: cancelling });
  assert.equal(termination.kind, "cancelled");
  assert.equal(termination.code, "cancelled.user");
});

test("a failed Controller decision terminates the run as a Controller failure", async (t) => {
  const failing: ControllerPort = {
    decide: async () => ({
      status: "failed",
      sessionId: "controller-1",
      failure: {
        code: "invalid_output",
        message: "Controller produced no usable decision.",
        attempts: 1,
      },
    }),
  };
  const termination = await terminationOf(t, { controller: failing });
  assert.equal(termination.kind, "failed");
  assert.equal(termination.code, "failed.controller");
});

test("the Harness stops the run when the wall-clock budget is spent", async (t) => {
  const termination = await terminationOf(t, {
    controller: sendingController(5),
    policy: { ...patientPolicy, wallClockMs: 1 },
  });
  assert.equal(termination.kind, "limit_reached");
  assert.equal(termination.code, "limit.wall_clock");
});

test("the Harness stops the run when the Controller call budget is spent", async (t) => {
  const termination = await terminationOf(t, {
    controller: sendingController(),
    policy: patientPolicy,
    agentConfig: {
      providerId: "test",
      requestedModel: "test-model",
      budget: { callTimeoutMs: 1_000, maxStructuredRepairAttempts: 0, maxCalls: 2 },
    },
  });
  assert.equal(termination.kind, "limit_reached");
  assert.equal(termination.code, "limit.controller_calls");
});

test("the Controller may repeat a message when the candidate needs another turn", async (t) => {
  let calls = 0;
  const repeatTwice: ControllerPort = {
    decide: async () => {
      calls += 1;
      return calls < 3
        ? { status: "completed", sessionId: "repeat-controller", value: { type: "send", message: "Please continue checking the artifact.", intent: "verify" } }
        : { status: "completed", sessionId: "repeat-controller", value: { type: "done", reason: "satisfied" } };
    },
  };
  const termination = await terminationOf(t, {
    controller: repeatTwice,
    policy: { ...patientPolicy, maxConsecutiveNoProgress: 1 },
  });
  assert.equal(termination.kind, "completed");
  assert.equal(termination.code, "completed.controller_satisfied");
});

test("the Controller sees settled turns accumulate across decisions", async (t) => {
  const summaries: string[] = [];
  let calls = 0;
  const observing: ControllerPort = {
    decide: async (request) => {
      summaries.push(request.trajectory.summary);
      calls += 1;
      return calls < 3
        ? {
            status: "completed",
            sessionId: "controller-1",
            value: {
              type: "send",
              message: `Continue with step ${calls}.`,
              intent: "continue",
            },
          }
        : {
            status: "completed",
            sessionId: "controller-1",
            value: { type: "done", reason: "satisfied" },
          };
    },
  };
  const termination = await terminationOf(t, {
    controller: observing,
    policy: patientPolicy,
  });
  assert.equal(termination.kind, "completed");
  // The observation is folded incrementally, so a stale cursor would freeze this count at one.
  assert.deepEqual(
    summaries.map((summary) => /Settled turns: (\d+)/.exec(summary)?.[1]),
    ["0", "1", "2"],
  );
});

test("a scripted Controller run persists controller.requested and reconstructs it from the store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-requested-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession: (session) => {
        let calls = 0;
        return {
          append: async () => {
            calls += 1;
            if (calls === 1) {
              return "Working understanding of the historical user demand.";
            }
            if (calls === 2) {
              const tool = session.tools.find((entry) => entry.name === "read");
              assert.ok(tool);
              assert.equal(session.tools.some((entry) => entry.name === "read_observation"), false);
              await tool.execute({ path: "INDEX.md" }, new AbortController().signal);
              return JSON.stringify({
                type: "send",
                message: "Make the focused change in this directory.",
                intent: "continue",
              });
            }
            await session.tools.find((entry) => entry.name === 'shell_exec')!.execute({ command: process.platform === 'win32' ? 'Get-Content -LiteralPath README.md' : 'cat README.md' }, new AbortController().signal);
            const tool = session.tools.find((entry) => entry.name === "read")!;
            await tool.execute({ path: "run/turns/0001/visible.txt" }, new AbortController().signal);
            return JSON.stringify({ type: "done", reason: "satisfied" });
          },
          cancel() {},
        };
      },
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });
  const result = await startCodexExperiment({
    ...input(root, new VerifiedRuntime()),
    controller,
    policy: patientPolicy,
  }).result;
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    const events = store.events("run-1");
    assert.equal(result.record.outcome.termination.kind, "completed");
    assert.equal(events.filter((event) => event.type === "input.submitted").length, 1);
    const readEvent = events.find((event) => event.type === "controller.observation_read" && (event.payload as { source: string }).source === 'workspace_read');
    assert.equal((readEvent?.payload as { requestId?: string })?.requestId, "controller-request-run-1-2");
    const readPayload = readEvent?.payload as { evidenceRefs: string[] };
    assert.equal(readPayload.evidenceRefs.length, 1);
    const savedRead = await store.readArtifact({ artifactId: readPayload.evidenceRefs[0]!.slice('artifact:'.length), experimentId: 'experiment-1', runId: 'run-1' });
    const readContent = JSON.parse(savedRead.toString()) as { path: string; content: string; offset: number };
    assert.equal(readContent.path, 'run/turns/0001/visible.txt');
    assert.equal(readContent.offset, 0);
    assert.match(readContent.content, /Focused change completed/);
    const corrected = reconstructControllerRequest(events, 'controller-request-run-1-2');
    assert.doesNotMatch(String(corrected.snapshot.promptContent), /Host completion feedback/);
    const shellEvent = events.find((event) => event.type === 'controller.observation_read' && (event.payload as { source: string }).source === 'workspace_shell');
    assert.ok(shellEvent);
    assert.equal(controllerReadEvidenceOnRequest([shellEvent], 'run-1', 'controller-request-run-1-2'), false);
    const shellPayload = shellEvent.payload as { evidenceRefs: string[]; requestId: string };
    assert.equal(shellPayload.requestId, 'controller-request-run-1-2');
    const shellArtifact = JSON.parse((await store.readArtifact({ artifactId: shellPayload.evidenceRefs[0]!.slice('artifact:'.length), experimentId: 'experiment-1', runId: 'run-1' })).toString()) as { content: string; exitCode: number; cwd: string };
    assert.match(shellArtifact.content, /# source/);
    assert.equal(shellArtifact.exitCode, 0);
    assert.equal(shellArtifact.cwd, '.');
    const decision = events.find((event) => event.type === "controller.decision");
    const submitted = events.find((event) => event.type === "input.submitted");
    assert.ok(decision && submitted);
    assert.equal(decision.sequence < submitted.sequence, true);
    const requested = events.find((event) => event.type === "controller.requested");
    assert.ok(requested?.operationId);
    assert.equal((requested.payload as { snapshot?: { promptDigest?: string } }).snapshot?.promptDigest?.length, 64);
    assert.equal(events.some((event) => event.type === "controller.observation_read"), true);
    assert.ok(events.some((event) => event.type === "agent.tool_called"));
    assert.ok(events.some((event) => event.type === "agent.tool_completed"));
    const comparisonRequested = events.find((event) => event.type === "comparison.requested");
    assert.ok(comparisonRequested);
    const comparisonPayload = comparisonRequested.payload as { artifactId: string; inputDigest: string; runId: string };
    const briefing = await store.readArtifact({
      artifactId: comparisonPayload.artifactId,
      experimentId: "experiment-1",
      runId: comparisonPayload.runId,
    });
    assert.equal(sha256(briefing), comparisonPayload.inputDigest);
    const rebuilt = reconstructControllerRequest(events, requested.operationId);
    assert.equal(rebuilt.requestId, requested.operationId);
    assert.equal(rebuilt.runId, "run-1");
    const snapshot = rebuilt.snapshot as { promptContent?: string; briefingRoot?: string; promptDigest?: string };
    assert.match(snapshot.promptContent ?? "", /INDEX\.md/);
    assert.ok(snapshot.briefingRoot);
    assert.equal(snapshot.promptDigest?.length, 64);
    assert.equal(sha256(JSON.stringify((requested.payload as { snapshot: unknown }).snapshot)), rebuilt.inputDigest);
  } finally {
    await store.close();
  }
});

test("done/satisfied is accepted without a Host ledger or unread-file guard", async (t) => {
  for (const reason of ['satisfied', 'blocked', 'no_further_value', 'requires_real_user_decision'] as const) {
    await t.test(reason, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'reprise-done-without-ledger-'));
      t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      await mkdir(join(root, 'source'));
      await writeFile(join(root, 'source', 'README.md'), '# source\n');
      let calls = 0;
      const controller = new ControllerAgent({
        host: new PiAgentHost({ createSession: () => ({
          append: async () => {
            calls += 1;
            if (calls === 1) return 'Working understanding of the historical user demand.';
            if (calls === 2) return JSON.stringify({ type: 'send', message: 'Make the change.', intent: 'continue' });
            return JSON.stringify({ type: 'done', reason });
          },
          cancel() {},
        }) }),
        timeoutMs: 5_000,
        maxRepairAttempts: 0,
      });
      const result = await startCodexExperiment({ ...input(root, new VerifiedRuntime()), controller, policy: patientPolicy }).result;
      const store = await ExperimentStore.open(result.experimentRoot, 'experiment-1');
      try {
        const events = store.events('run-1');
        assert.equal(events.filter((event) => event.type === 'input.submitted').length, 1);
        assert.equal(events.filter((event) => event.type === 'controller.done_rejected').length, 0);
        assert.equal(events.filter((event) => event.type === 'controller.understanding').length, 0);
        assert.equal(calls, 3);
        assert.equal(result.record.outcome.cleanup.status, 'complete');
        if (reason === 'satisfied') {
          assert.equal(result.record.outcome.termination.kind, 'completed');
          assert.equal(result.record.outcome.task.status, 'apparently_completed');
        } else {
          assert.equal(result.record.outcome.task.status, 'incomplete');
        }
      } finally {
        await store.close();
      }
    });
  }
});

test("cancelling an in-flight Controller request discards a late send before CandidateRun records it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-cancel-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  let resolve!: (value: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((done) => {
    started = done;
  });
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession: () => ({
        append: async () => {
          started();
          return await new Promise<string>((done) => {
            resolve = done;
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 0,
    maxRepairAttempts: 0,
  });
  const handle = startCodexExperiment({
    ...input(root, new VerifiedRuntime()),
    controller,
    policy: patientPolicy,
  });
  await ready;
  await handle.cancel();
  resolve(JSON.stringify({ type: "send", message: "Late send must not reach Target.", intent: "continue" }));
  const result = await handle.result;
  assert.equal(result.record.outcome.termination.kind, "cancelled");
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    const events = store.events("run-1");
    assert.equal(
      events.filter((event) => event.type === "input.submitted").length,
      0,
    );
    const decision = events.find((event) => event.type === "controller.decision");
    assert.equal((decision?.payload as { status?: string } | undefined)?.status, "cancelled");
  } finally {
    await store.close();
  }
});

test("a completed comparison without report.html is recorded as an Agent failure, not a fallback narrative", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-experiment-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  const runtime = new VerifiedRuntime();
  const silent: ComparisonAgentPort = {
    compare: async () => ({
      status: "completed",
      sessionId: "comparison-1",
      value: {
        status: "completed",
        reportPath: "report.html",
        evidenceRefs: [],
      },
    }),
  };
  const result = await startCodexExperiment({
    ...input(root, runtime),
    comparison: silent,
  }).result;
  assert.equal(result.comparison.result.status, "failed");
  assert.match(
    await readFile(result.reportPath, "utf8"),
    /Comparison unavailable/,
  );
});

test("working notes written after a failed first pass stay in the same comparison attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), `reprise-plan-notes-`));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const comparison: ComparisonAgentPort = {
    compare: async (context, tools = []) => {
      assert.match(context.promptContent ?? "", /briefingRoot=/);
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "work/comparison-plan.md", content: "# Working notes\n" },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "report.html", content: `<!doctype html><p>single-session</p>` },
        new AbortController().signal,
      );
      return { status: "completed", sessionId: "comparison-notes", value: { status: "completed", reportPath: "report.html", evidenceRefs: [] } };
    },
  };
  const result = await startCodexExperiment({ ...input(root, new VerifiedRuntime()), comparison }).result;
  assert.equal(result.comparison.result.status, "completed");
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    const started = store.events("run-1").find((event) => event.type === "comparison.started");
    const attemptId = (started?.payload as { attemptId?: string })?.attemptId;
    assert.ok(attemptId);
    assert.equal(await readFile(join(result.experimentRoot, "comparison-attempts", attemptId, "work", "comparison-plan.md"), "utf8"), "# Working notes\n");
    assert.equal(store.events("run-1").some((event) => event.type === "comparison.plan_completed"), false);
  } finally {
    await store.close();
  }
});

test("a failed later comparison attempt does not overwrite the last successful report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-report-retry-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const experimentRoot = join(root, "data", "experiments", "experiment-1");
  await mkdir(experimentRoot, { recursive: true });
  const published = "<!doctype html><p>previous successful attempt</p>";
  await writeFile(join(experimentRoot, "report.html"), published);
  await writeFile(join(experimentRoot, "comparison.json"), JSON.stringify({ status: "completed", sessionId: "old", value: { status: "completed", reportPath: "report.html", evidenceRefs: [] } }));
  const failed: ComparisonAgentPort = {
    compare: async () => ({ status: "failed", sessionId: "comparison-failed", failure: { code: "agent_failure", message: "failed", attempts: 1 } }),
  };
  const result = await startCodexExperiment({ ...input(root, new VerifiedRuntime()), comparison: failed }).result;
  assert.equal(result.comparison.result.status, "failed");
  assert.equal(await readFile(join(experimentRoot, "report.html"), "utf8"), published);
  const latest = JSON.parse(await readFile(join(experimentRoot, "comparison.json"), "utf8")) as { status?: string; sessionId?: string };
  assert.equal(latest.status, "failed");
  assert.equal(latest.sessionId, "comparison-failed");
  assert.notEqual(result.reportPath, join(experimentRoot, "report.html"));
});

test("an unchanged source fingerprint still starts after preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-stable-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# original\n");
  const runtime = new VerifiedRuntime();
  const experiment = input(root, runtime);
  const preflight = await preflightCodexExperiment(experiment);
  assert.ok(preflight.sourceFingerprint);
  const result = await startCodexExperiment({
    ...experiment,
    expectedSourceFingerprint: preflight.sourceFingerprint,
  }).result;
  assert.equal(runtime.created, 1);
  assert.equal(result.record.outcome.termination.kind, "completed");
});

test("a changed source fingerprint blocks Candidate startup after preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-drift-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# original\n");
  const runtime = new VerifiedRuntime();
  const experiment = input(root, runtime);
  const preflight = await preflightCodexExperiment(experiment);
  await writeFile(join(root, "source", "README.md"), "# changed\n");
  await assert.rejects(
    startCodexExperiment({
      ...experiment,
      ...(preflight.sourceFingerprint
        ? { expectedSourceFingerprint: preflight.sourceFingerprint }
        : {}),
    }).result,
    /changed after preflight/,
  );
  assert.equal(runtime.created, 0);
});

test("the first Target message is the Controller opening send, not frozen initialInput", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-opening-send-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const historicalCwd = "C:\\yanjiusheng\\project";
  const frozen = `Edit ${historicalCwd}\\slides.html`;
  const opening = "Edit slides.html in the current directory.";
  let sawOpening = false;
  const controller: ControllerPort = {
    decide: async (ctx) => {
      if (ctx.phase === "opening") {
        sawOpening = Boolean(ctx.replay?.workspaceRoot && ctx.replay.historicalCwd === historicalCwd);
        return {
          status: "completed",
          sessionId: "controller-1",
          value: { type: "send", message: opening, intent: "continue" },
        };
      }
      return {
        status: "completed",
        sessionId: "controller-1",
        value: { type: "done", reason: "satisfied" },
      };
    },
  };
  const base = input(root, new VerifiedRuntime());
  const result = await startCodexExperiment({
    ...base,
    taskCase: {
      ...base.taskCase,
      initialInput: { ...base.taskCase.initialInput, text: frozen },
      transcript: [{ id: "message-1", role: "user", text: frozen }],
      taskContext: { ...base.taskCase.taskContext, historicalCwd },
    },
    controller,
    policy: patientPolicy,
  }).result;
  assert.equal(result.record.outcome.termination.kind, "completed");
  assert.equal(sawOpening, true);
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    const events = store.events("run-1");
    const startedAt = events.findIndex((event) => event.type === "controller.started");
    const submitted = events.filter((event) => event.type === "input.submitted");
    assert.equal(startedAt >= 0 && startedAt < events.findIndex((event) => event.type === "input.submitted"), true);
    assert.equal(submitted.length, 1);
    assert.equal((submitted[0]?.payload as { text?: string }).text, opening);
    assert.notEqual((submitted[0]?.payload as { text?: string }).text, frozen);
    const requested = events.find((event) => event.type === "controller.requested");
    assert.ok(requested?.operationId);
    const rebuilt = reconstructControllerRequest(events, requested.operationId);
    assert.equal((rebuilt.snapshot as { phase?: string }).phase, "opening");
  } finally {
    await store.close();
  }
});

test("an opening done does not start the Target with frozen initialInput", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-opening-done-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const frozen = "Make the focused change.";
  const controller: ControllerPort = {
    decide: async () => ({
      status: "completed",
      sessionId: "controller-1",
      value: { type: "done", reason: "satisfied" },
    }),
  };
  const result = await startCodexExperiment({
    ...input(root, new VerifiedRuntime()),
    controller,
    policy: patientPolicy,
  }).result;
  assert.equal(result.record.outcome.termination.code, "failed.controller");
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    const events = store.events("run-1");
    assert.equal(events.filter((event) => event.type === "input.submitted").length, 0);
    assert.equal(
      events.some((event) => event.type === "input.submitted" && (event.payload as { text?: string }).text === frozen),
      false,
    );
  } finally {
    await store.close();
  }
});

test('opening failure and cancellation persist legal terminal records without candidate input', async (t) => {
  for (const status of ['failed', 'cancelled'] as const) {
    const root = await mkdtemp(join(tmpdir(), 'reprise-opening-failure-'));
    t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    await mkdir(join(root, 'source'));
    await writeFile(join(root, 'source', 'README.md'), '# source\n');
    const result = await startCodexExperiment({ ...input(root, new VerifiedRuntime()), policy: patientPolicy, controller: {
      decide: async () => status === 'failed'
        ? { status, sessionId: 'fixture', failure: { code: 'agent_failure', message: 'Upstream request failed', kind: 'transient_upstream', attempts: 3 } }
        : { status, sessionId: 'fixture' },
    } }).result;
    assert.equal(result.record.outcome.termination.kind, status);
    assert.equal(result.record.outcome.task.status, 'not_assessed');
    assert.equal(result.record.outcome.cleanup.status, 'complete');
    const persisted = JSON.parse(await readFile(join(result.experimentRoot, 'runs', 'run-1', 'record.json'), 'utf8')) as { outcome: unknown };
    assert.deepEqual(persisted.outcome, result.record.outcome);
    const store = await ExperimentStore.open(result.experimentRoot, 'experiment-1');
    try {
      assert.equal(store.events('run-1').filter((event) => event.type === 'input.submitted').length, 0);
      assert.equal(store.events('run-1').some((event) => event.type === 'controller.understanding'), false);
    } finally {
      await store.close();
    }
  }
});

test("deferred comparison runs from finished candidate facts without a live RecoveryAttempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-defer-compare-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const handle = startCodexExperiment({
    ...input(root, new VerifiedRuntime()),
    deferComparison: true,
  });
  const candidate = await handle.candidateFinished;
  assert.equal(candidate.comparison.result.status, "skipped");
  assert.equal(candidate.record.state, "finished");
  await handle.runComparison();
  const result = await handle.result;
  assert.equal(result.comparison.result.status, "completed");
  assert.match(await readFile(join(result.experimentRoot, "report.html"), "utf8"), /Evidence-based narrative/);
});

test("comparison does not start unless compare is set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-skip-compare-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  let compared = 0;
  const comparison: ComparisonAgentPort = {
    compare: async () => {
      compared += 1;
      return {
        status: "completed",
        sessionId: "comparison-1",
        value: { status: "completed", reportPath: "report.html", evidenceRefs: [] },
      };
    },
  };
  const result = await startCodexExperiment({
    ...input(root, new VerifiedRuntime()),
    comparison,
    compare: false,
  }).result;
  assert.equal(compared, 0);
  assert.equal(result.comparison.result.status, "skipped");
  const store = await ExperimentStore.open(result.experimentRoot, "experiment-1");
  try {
    assert.equal(store.events("run-1").some((event) => event.type === "comparison.started"), false);
  } finally {
    await store.close();
  }
});
