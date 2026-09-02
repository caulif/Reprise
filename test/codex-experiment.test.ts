import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComparisonAgentPort } from "../src/agents/comparison-agent.js";
import { ControllerAgent, type ControllerPort } from "../src/agents/controller-agent.js";
import { reconstructControllerRequest } from "../src/application/controller-request.js";
import { preflightCodexExperiment, recoverCodexExperiment, startCodexExperiment } from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/pi-agent-host.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import type { ResolvedRuntime, TargetEventSink, TargetRunner } from "../src/core/runtime.js";
import { sha256 } from "../src/core/identity.js";
import { now, VerifiedRuntime, input, terminationOf, repeatingSend, sendingController, patientPolicy, readJson } from "./codex-experiment-support.js";

test("trusted checkpoints restore deterministically without invoking the Recovery model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-checkpoint-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
    assert.ok(
      store
        .events("run-2")
        .some((event) => event.type === "recovery.checkpoint_captured"),
    );
    assert.match(
      JSON.stringify(store.replay("run-2").finishedPayload),
      /"state":"finished"/,
    );
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
    policy: { ...patientPolicy, maxModelCalls: 2 },
  });
  assert.equal(termination.kind, "limit_reached");
  assert.equal(termination.code, "limit.controller_calls");
});

test("the Harness stops the run when the Controller repeats itself without progress", async (t) => {
  const termination = await terminationOf(t, {
    controller: repeatingSend,
    policy: { ...patientPolicy, maxConsecutiveNoProgress: 1 },
  });
  assert.equal(termination.kind, "stalled");
  assert.equal(termination.code, "stalled.no_progress");
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
              const tool = session.tools.find((entry) => entry.name === "read_observation");
              assert.ok(tool);
              await tool.execute({ source: "run_events", start: 0, maxItems: 8 }, new AbortController().signal);
              return JSON.stringify({
                type: "send",
                message: "Make the focused change in this directory.",
                intent: "continue",
              });
            }
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
    const requested = events.find((event) => event.type === "controller.requested");
    assert.ok(requested?.operationId);
    assert.ok(events.some((event) => event.type === "controller.observation_read"));
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
    const catalog = rebuilt.snapshot.evidenceCatalog as readonly { ref: string; source: string }[];
    assert.ok(catalog.some((entry) => entry.source === "tool"));
    assert.equal(sha256(JSON.stringify((requested.payload as { snapshot: unknown }).snapshot)), rebuilt.inputDigest);
  } finally {
    await store.close();
  }
});

test("cancelling an in-flight Controller request discards a late send before CandidateRun records it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-cancel-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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

test("an unchanged source fingerprint still starts after preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-stable-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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
  t.after(async () => rm(root, { recursive: true, force: true }));
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

test("comparison does not start unless compare is set", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-skip-compare-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
