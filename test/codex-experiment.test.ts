import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComparisonAgentPort } from "../src/agents/comparison-agent.js";
import {
  RecoveryAgent,
  type RecoveryAgentPort,
} from "../src/agents/recovery-agent.js";
import {
  ControllerAgent,
  type ControllerPort,
} from "../src/agents/controller-agent.js";
import { reconstructControllerRequest } from "../src/application/controller-request.js";
import {
  preflightCodexExperiment,
  recoverCodexExperiment,
  startCodexExperiment,
  classifyRecoveryFailureStage,
} from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/pi-agent-host.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import type {
  ResolvedRuntime,
  RuntimePort,
  TargetEventSink,
  TargetRunner,
} from "../src/core/runtime.js";
import { isRecord } from "../src/core/json.js";
import { sha256 } from "../src/core/identity.js";
import type { TaskCase } from "../src/core/schema.js";
import { ScriptedRunner } from "./support/scripted-runtime.js";

const now = "2026-08-11T12:00:00.000Z";
class VerifiedRuntime implements RuntimePort {
  readonly id = "verified-test";
  created = 0;
  async inspectAvailable() {
    return [
      { productId: "codex", executable: "verified-test", version: "fixture" },
    ] as const;
  }
  async inspectAvailability() {
    return [
      {
        productId: "codex",
        executable: "verified-test",
        observedVersion: "fixture",
        status: "available" as const,
        observedAt: now,
      },
    ];
  }
  async resolve(request: {
    productId: string;
    requestedModel: string;
  }): Promise<ResolvedRuntime> {
    return {
      productId: request.productId,
      executable: "verified-test",
      version: "fixture",
      requestedModel: request.requestedModel,
      resolvedModel: request.requestedModel,
    };
  }
  async validateCandidate(request: {
    productId: string;
    requestedModel: string;
  }) {
    return this.resolve(request);
  }
  recoveryCapabilities() {
    return {
      sessionHistory: "available" as const,
      localArtifacts: true,
      workspaceHistory: false,
      externalSideEffects: "unobserved" as const,
    };
  }
  async createRunner(
    _runtime: ResolvedRuntime,
    _environment: { environmentId: string; runId: string; root: string },
    sink: TargetEventSink,
  ): Promise<TargetRunner> {
    this.created += 1;
    await sink.append({
      type: "codex.item_completed",
      occurredAt: now,
      payload: { item: { type: "commandExecution", command: "npm test" } },
    });
    await sink.append({
      type: "codex.item_completed",
      occurredAt: now,
      payload: {
        item: { type: "agentMessage", text: "Focused change completed." },
      },
    });
    return new ScriptedRunner(
      [{ delivery: "accepted", evidence: "native_admission" }],
      [
        {
          turnId: "turn-1",
          status: "waiting_input",
          confidence: "native",
          observedAt: now,
          rawRefs: [],
        },
      ],
    );
  }
}
const controller: ControllerPort = {
  decide: async () => ({
    status: "completed",
    sessionId: "controller-1",
    value: { type: "done", reason: "satisfied" },
  }),
};
const comparison: ComparisonAgentPort = {
  compare: async (_context, tools = []) => {
    const writer = tools.find(
      (tool) => tool.name === "write_comparison_report",
    );
    await writer?.execute(
      {
        html: '<!doctype html><style>body{color:rebeccapurple}</style><svg></svg><script>window.ready=true</script><p>Evidence-based narrative.</p><a href="./artifacts/recovery-md">recovery_report</a>',
      },
      new AbortController().signal,
    );
    return {
      status: "completed",
      sessionId: "comparison-1",
      value: {
        status: "completed",
        reportPath: "report.html",
        evidenceRefs: [],
      },
    };
  },
};
function taskCase(): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-experiment-1",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: {
      id: "message-1",
      role: "user",
      text: "Make the focused change.",
    },
    transcript: [
      { id: "message-1", role: "user", text: "Make the focused change." },
    ],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: {
      historicalBehavior: {
        commands: ["npm test"],
        touchedPaths: ["src/example.ts"],
      },
    },
    provenance: {
      packVersion: "test",
      importedAt: now,
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}
type PersistedModels = { requestedModel?: string };
type PersistedAgents = {
  controller?: PersistedModels;
  comparison?: PersistedModels;
};
async function readJson(
  path: string,
): Promise<PersistedAgents & { spec?: PersistedAgents }> {
  return JSON.parse(await readFile(path, "utf8")) as PersistedAgents & {
    spec?: PersistedAgents;
  };
}
function input(root: string, runtime: VerifiedRuntime) {
  const dataDir = join(root, "data");
  return {
    dataDir,
    caseId: "case-experiment-1",
    experimentId: "experiment-1",
    runId: "run-1",
    sourceRoot: join(root, "source"),
    taskCase: taskCase(),
    candidate: {
      candidateId: "candidate-1",
      productId: "codex",
      requestedModel: "test-model",
    },
    policy: {
      wallClockMs: 1_000,
      maxTargetTurns: 2,
      maxModelCalls: 2,
      turnTimeoutMs: 1_000,
      maxConsecutiveNoProgress: 1,
    },
    agentConfig: {
      providerId: "test",
      requestedModel: "test-model",
      budget: { callTimeoutMs: 1_000, maxStructuredRepairAttempts: 0 },
    },
    runtime,
    controller,
    comparison,
    now,
  };
}

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
    maxToolCalls: 64,
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

class MultiTurnRuntime implements RuntimePort {
  readonly id = "multi-turn-test";
  constructor(readonly turns: number) {}
  async inspectAvailable() {
    return [
      { productId: "codex", executable: "multi-turn-test", version: "fixture" },
    ] as const;
  }
  async inspectAvailability() {
    return [
      {
        productId: "codex",
        executable: "multi-turn-test",
        observedVersion: "fixture",
        status: "available" as const,
        observedAt: now,
      },
    ];
  }
  async resolve(request: {
    productId: string;
    requestedModel: string;
  }): Promise<ResolvedRuntime> {
    return {
      productId: request.productId,
      executable: "multi-turn-test",
      version: "fixture",
      requestedModel: request.requestedModel,
      resolvedModel: request.requestedModel,
    };
  }
  async validateCandidate(request: {
    productId: string;
    requestedModel: string;
  }) {
    return this.resolve(request);
  }
  recoveryCapabilities() {
    return {
      sessionHistory: "available" as const,
      localArtifacts: true,
      workspaceHistory: false,
      externalSideEffects: "unobserved" as const,
    };
  }
  async createRunner(): Promise<TargetRunner> {
    return new ScriptedRunner(
      Array.from({ length: this.turns }, () => ({
        delivery: "accepted" as const,
        evidence: "native_admission",
      })),
      Array.from({ length: this.turns }, (_, index) => ({
        turnId: `turn-${index + 1}`,
        status: "waiting_input" as const,
        confidence: "native" as const,
        observedAt: now,
        rawRefs: [],
      })),
    );
  }
}

async function terminationOf(
  t: { after(fn: () => Promise<unknown>): void },
  overrides: {
    controller: ControllerPort;
    policy?: Partial<TaskPolicy>;
    turns?: number;
  },
): Promise<{ kind: string; code: string }> {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-experiment-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const result = await startCodexExperiment({
    ...base,
    runtime: new MultiTurnRuntime(overrides.turns ?? 4),
    controller: overrides.controller,
    policy: { ...base.policy, ...overrides.policy },
  }).result;
  return result.record.outcome.termination;
}

type TaskPolicy = ReturnType<typeof input>["policy"];
const repeatingSend: ControllerPort = {
  decide: async () => ({
    status: "completed",
    sessionId: "controller-1",
    value: { type: "send", message: "Keep going.", intent: "continue" },
  }),
};
function sendingController(delayMs = 0): ControllerPort {
  let calls = 0;
  return {
    decide: async () => {
      calls += 1;
      if (delayMs)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
      return {
        status: "completed",
        sessionId: "controller-1",
        value: {
          type: "send",
          message: `Continue with step ${calls}.`,
          intent: "continue",
        },
      };
    },
  };
}
const patientPolicy = {
  maxTargetTurns: 8,
  maxModelCalls: 8,
  maxConsecutiveNoProgress: 8,
  wallClockMs: 60_000,
  turnTimeoutMs: 60_000,
};

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
    ["1", "2", "3"],
  );
});

test("a scripted Controller run persists controller.requested and reconstructs it from the store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-requested-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const controller = new ControllerAgent({
    host: new PiAgentHost({
      createSession: (session) => ({
        append: async () => {
          const tool = session.tools.find((entry) => entry.name === "read_observation");
          assert.ok(tool);
          await tool.execute({ source: "run_events", start: 0, maxItems: 8 }, new AbortController().signal);
          return JSON.stringify({ type: "done", reason: "satisfied" });
        },
        cancel() {},
      }),
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
      1,
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

test("Recovery preserves a known verifier rejection as provider validation", () => {
  assert.equal(
    classifyRecoveryFailureStage(
      "provider_validation_failed",
      new Error("known verifier rejection"),
      ["weak_or_incomplete_evidence"],
    ),
    "provider_validation_failed",
  );
  assert.equal(
    classifyRecoveryFailureStage(
      "provider_validation_failed",
      new Error("unknown provider failure"),
    ),
    "runner_crashed",
  );
  assert.equal(
    classifyRecoveryFailureStage(
      "provider_validation_failed",
      new Error("provider adapter rejected completed output"),
      undefined,
      true,
    ),
    "provider_validation_failed",
  );
});

test("Recovery records Provider validation failure separately from a completed Agent envelope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-failure-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async () => ({
      status: "completed",
      sessionId: "recovery-1",
      value: {
        status: "recovered",
        reportPath: "recovery.md",
        unresolved: [],
        evidenceRefs: ["event:missing"],
        manifestPath: "recovery-manifest.json",
      },
    }),
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-validation-failure",
    runId: "recovery-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "failed");
  const validation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "recovery-validation.json"),
      "utf8",
    ),
  ) as { status: string; message: string };
  assert.equal(validation.status, "failed");
  assert.equal(
    validation.message,
    "Provider validation rejected the recovery result.",
  );
});

class CleanupFailingRecoveryProvider extends LocalWorkspaceProvider {
  override async discardRecovery(): Promise<void> {
    throw new Error("cleanup fixture failure");
  }
}

test("Recovery rejects an unproven recovered no-op before Provider promotion", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-codex-recovery-runner-crash-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const evidenceRef = `event:transcript-0-${sha256(JSON.stringify(base.taskCase.transcript[0])).slice(0, 16)}`;
  const recovery: RecoveryAgentPort = {
    recover: async () => ({
      status: "completed",
      sessionId: "recovery-runner-crash",
      value: {
        status: "recovered",
        reportPath: "recovery.md",
        unresolved: [],
        evidenceRefs: [evidenceRef],
        manifestPath: "recovery-manifest.json",
      },
    }),
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-runner-crash",
    runId: "recovery-runner-crash",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    environmentProvider: new CleanupFailingRecoveryProvider(join(root, "provider")),
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.failureStage, "provider_validation_failed");
  const validation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "recovery-validation.json"),
      "utf8",
    ),
  ) as { message: string };
  assert.equal(validation.message, "Provider validation rejected the recovery result.");
});

test("Recovery classifies a structured model request failure separately from tool failure", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-codex-recovery-model-failure-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  let calls = 0;
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-model-failure",
    runId: "recovery-model-failure",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => {
        calls += 1;
        return {
          status: "failed",
          sessionId: "recovery-model-failure",
          failure: {
            code: "agent_failure",
            message: "model unavailable",
            attempts: 1,
          },
        };
      },
    },
    maxToolCalls: 64,
    now,
  });
  assert.equal(
    calls,
    2,
    "a transient model failure receives one bounded retry",
  );
  assert.equal(attempt.baseline.recovery?.failureStage, "agent_model_failed");
  assert.match(
    attempt.baseline.warnings.join("\n"),
    /persisted investigation and candidate diagnostics require review/,
  );
  const validation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "recovery-validation.json"),
      "utf8",
    ),
  ) as { message: string };
  assert.equal(validation.message, "Recovery model request failed.");
  const events = (
    await readFile(join(attempt.experimentRoot, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { type: string; payload: Record<string, unknown> },
    );
  assert.deepEqual(
    events
      .filter((event) => event.type === "recovery.model_retry")
      .map((event) => event.payload.attempt),
    [2],
  );
  assert.deepEqual(
    events.find((event) => event.type === "recovery.model_fallback")?.payload,
    {
      forensicsCompleted: true,
      hypothesisCount: 2,
      candidateCount: 1,
      modelAttempts: 2,
    },
  );
});

test("Recovery source tripwire falls back to current state and records a warning event", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-codex-recovery-tripwire-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async () => {
      await writeFile(join(base.sourceRoot, "README.md"), "# out-of-bounds\n");
      return {
        status: "completed",
        sessionId: "recovery-tripwire",
        value: {
          status: "insufficient_evidence",
          reportPath: "recovery.md",
          unresolved: ["No historical state."],
          evidenceRefs: [],
        },
      };
    },
  };

  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-tripwire",
    runId: "recovery-tripwire-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxToolCalls: 64,
    now,
  });

  assert.equal(attempt.baseline.recovery?.status, "failed");
  assert.match(attempt.baseline.warnings.join("\n"), /current source state/i);
  const events = (
    await readFile(join(attempt.experimentRoot, "events.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as { type: string; payload?: { fallback?: string } },
    );
  assert.deepEqual(
    events.find((event) => event.type === "recovery.warning")?.payload,
    {
      failureStage: "source_tripwire_failed",
      summary: "Recovery source tripwire detected a source change.",
      fallback: "current_state",
    },
  );
});

test("Recovery orchestration uses a scripted Agent to restore a historical Git baseline before Candidate startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-golden-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "README.md"), "# original\n");
  const git = promisify(execFile);
  const runGit = async (args: string[]) =>
    (await git("git", args, { cwd: source, windowsHide: true })).stdout.trim();
  await runGit(["init"]);
  await runGit(["config", "user.email", "test@example.invalid"]);
  await runGit(["config", "user.name", "Test"]);
  await runGit(["config", "core.autocrlf", "false"]);
  await runGit(["add", "README.md"]);
  await runGit(["commit", "-m", "task-start"]);
  const commit = await runGit(["rev-parse", "HEAD"]);
  await writeFile(join(source, "README.md"), "# completed\n");
  const base = input(root, new VerifiedRuntime());
  const task = { ...base.taskCase, taskContext: { historicalCommit: commit } };
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const writer = tools.find((tool) => tool.name === "write_file");
      const report = tools.find(
        (tool) => tool.name === "write_recovery_report",
      );
      const manifest = tools.find(
        (tool) => tool.name === "write_recovery_manifest",
      );
      assert.ok(writer);
      assert.ok(report);
      assert.ok(manifest);
      await writer.execute(
        { path: "README.md", content: "# original\n" },
        new AbortController().signal,
      );
      await report.execute(
        {
          content:
            "# Recovery\n\nRestored README.md from the verified task-start commit.",
        },
        new AbortController().signal,
      );
      await manifest.execute(
        {
          actions: [
            {
              operation: "restore",
              path: "README.md",
              beforeHash: sha256("# completed\n"),
              afterHash: sha256("# original\n"),
              evidenceRefs: ["artifact:historical-commit"],
            },
          ],
          unresolved: [],
        },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-golden",
        value: {
          status: "recovered",
          reportPath: "recovery.md",
          unresolved: [],
          evidenceRefs: ["artifact:historical-commit"],
          manifestPath: "recovery-manifest.json",
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-golden",
    runId: "recovery-golden-run",
    sourceRoot: source,
    taskCase: task,
    recovery,
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.match, "recovered");
  assert.match(
    await readFile(join(attempt.staging?.root ?? "", "README.md"), "utf8"),
    /^# original\r?\n$/,
  );
  assert.match(
    attempt.providerPreview?.reportText ?? "",
    /verified task-start commit/,
  );
  assert.equal(
    await readFile(join(source, "README.md"), "utf8"),
    "# completed\n",
  );
  const accepted = await attempt.accept?.();
  assert.equal(accepted?.match, "recovered");
  const result = await startCodexExperiment({
    ...base,
    experimentId: "recovery-golden",
    runId: "candidate-golden-run",
    sourceRoot: source,
    taskCase: task,
    environmentProvider: attempt.provider,
    preResolvedBaseline: accepted,
  }).result;
  assert.equal(result.record.outcome.termination.kind, "completed");
});

test("Recovery executes in a selected candidate and persists its reviewable metadata diff", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-codex-recovery-candidate-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "README.md"), "# completed\n");
  const git = promisify(execFile);
  const runGit = async (args: string[]) =>
    (await git("git", args, { cwd: source, windowsHide: true })).stdout.trim();
  await runGit(["init"]);
  await runGit(["config", "user.email", "test@example.invalid"]);
  await runGit(["config", "user.name", "Test"]);
  await runGit(["config", "core.autocrlf", "false"]);
  await runGit(["add", "README.md"]);
  await runGit(["commit", "-m", "recovery-fixture"]);
  const preimage = "# verified preimage\n";
  const base = input(root, new VerifiedRuntime());
  const task = {
    ...base.taskCase,
    historicalEvents: [
      {
        type: "patch",
        path: "README.md",
        preimage,
        sha256: sha256(preimage),
      },
    ],
  };
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const recovery: RecoveryAgentPort = {
    recover: async (context, tools) => {
      assert.ok(context.executionCandidate);
      assert.match(context.executionCandidate.candidateId, /^candidate-(preimage-reconstruction|patch-replay)$/);
      assert.match(context.executionCandidate.hypothesisId, /^(preimage-reconstruction|patch-replay)$/);
      assert.equal(context.runtimeCapabilities?.externalSideEffects, "unobserved");
       const writer = tools.find((tool) => tool.name === "write_file");
      const report = tools.find(
        (tool) => tool.name === "write_recovery_report",
      );
      const manifest = tools.find(
        (tool) => tool.name === "write_recovery_manifest",
      );
      assert.ok(writer);
      assert.ok(report);
      assert.ok(manifest);
      const submitPlan = tools.find(
        (tool) => tool.name === "submit_recovery_plan",
      );
      assert.ok(submitPlan);
      const factRef = "fact:preimages";
      assert.ok(factRef);
      await submitPlan.execute(
        {
          planId: "agent-revised-plan",
          factsUsed: [factRef],
          hypotheses: [
            {
              hypothesisId: "preimage-reconstruction",
              rationale: "Restore the selected candidate.",
              paths: ["README.md"],
              supportingFactRefs: [factRef],
              counterFactRefs: [],
              expectedChecks: ["read README"],
              confidence: "low",
            },
          ],
          candidates: [
            {
              hypothesisId: "preimage-reconstruction",
              operations: [
                {
                  operation: "restore",
                  path: "README.md",
                  rationale:
                    "Compare the candidate against the historical clue.",
                },
              ],
            },
          ],
          verificationPlan: ["read README"],
        },
        new AbortController().signal,
      );
      await writer.execute(
        { path: "README.md", content: "# recovered\n" },
        new AbortController().signal,
      );
      await report.execute(
        { content: "# Recovery\n\nCandidate restored README." },
        new AbortController().signal,
      );
      const evidenceRef = context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      await manifest.execute(
        {
          actions: [
            {
              operation: "restore",
              path: "README.md",
              beforeHash: sha256("# completed\n"),
              afterHash: sha256("# recovered\n"),
              evidenceRefs: [evidenceRef],
            },
          ],
          unresolved: [],
        },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-candidate",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          unresolved: ["Current task transcript does not prove the preimage."],
          evidenceRefs: [evidenceRef],
          manifestPath: "recovery-manifest.json",
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-candidate",
    runId: "recovery-candidate-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxToolCalls: 64,
    now,
    onEvent: (event) =>
      events.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      }),
  });
  assert.equal(
    await readFile(join(attempt.staging?.root ?? "", "README.md"), "utf8"),
    "# recovered\n",
  );
  assert.equal(
    await readFile(join(base.sourceRoot, "README.md"), "utf8"),
    "# completed\n",
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "recovery.candidate_created")
      .map((event) => event.payload.candidateId),
    ["candidate-preimage-reconstruction"],
  );
  assert.equal(
    events.find((event) => event.type === "recovery.candidate_selected")
      ?.payload.candidateId,
    "candidate-preimage-reconstruction",
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "recovery.controlled_write")
      .map((event) => [
        event.payload.tool,
        event.payload.phase,
        event.payload.path,
      ]),
    [
      ["write_file", "before", "README.md"],
      ["write_file", "after", "README.md"],
      ["write_recovery_report", "before", "recovery.md"],
      ["write_recovery_report", "after", "recovery.md"],
      ["write_recovery_manifest", "before", "recovery-manifest.json"],
      ["write_recovery_manifest", "after", "recovery-manifest.json"],
    ],
  );
  const controlledPostimages = events
    .filter((event) => event.type === "recovery.controlled_write")
    .map((event) => event.payload)
    .filter((entry) => entry.phase === "after");
  assert.equal(controlledPostimages.length, 3);
  assert.deepEqual(
    controlledPostimages.map((entry) => entry.origin),
    ["agent_direct_write", "agent_direct_write", "agent_direct_write"],
  );
  for (const entry of controlledPostimages) {
    const after = entry.after as {
      artifactId?: string;
      contentHash: string;
      size: number;
    };
    assert.match(after.artifactId ?? "", /^recovery-blob-[a-f0-9]{64}$/);
    const blob = await readFile(
      join(attempt.experimentRoot, "artifacts", after.artifactId as string),
    );
    assert.equal(blob.byteLength, after.size);
    assert.equal(sha256(blob), after.contentHash);
  }
  assert.deepEqual(
    events.find((event) => event.type === "recovery.plan_submitted")?.payload,
    {
      plan: {
        planId: "agent-revised-plan",
        factsUsed: ["fact:preimages"],
        hypotheses: [
          {
            hypothesisId: "preimage-reconstruction",
            rationale: "Restore the selected candidate.",
            paths: ["README.md"],
            supportingFactRefs: ["fact:preimages"],
            counterFactRefs: [],
            expectedChecks: ["read README"],
            confidence: "low",
          },
        ],
        candidates: [
          {
            hypothesisId: "preimage-reconstruction",
            operations: [
              {
                operation: "restore",
                path: "README.md",
                rationale: "Compare the candidate against the historical clue.",
              },
            ],
          },
        ],
        verificationPlan: ["read README"],
      },
    },
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "recovery.candidate_discarded")
      .map((event) => event.payload.candidateId),
    [],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "recovery.candidate_review_available")
      .map((event) => event.payload.candidateId),
    [],
  );
  assert.equal(attempt.candidateGraphArtifactId, "recovery-candidate-graph");
  const candidateGraph = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-candidate-graph"),
      "utf8",
    ),
  ) as { investigation: { candidates: { candidateId: string; status: string }[] } };
  assert.equal(candidateGraph.investigation.candidates.length, 1);
  assert.equal(
    events.find((event) => event.type === "recovery.candidate_selected")
      ?.payload.selection,
    "highest_evidence_first",
  );
  const finalized = events.find(
    (event) => event.type === "recovery.candidate_finalized",
  );
  assert.equal(finalized?.payload.status, "pending_user_review");
  assert.deepEqual(finalized?.payload.reasonCodes, [
    "weak_or_incomplete_evidence",
  ]);
  const artifactId = finalized?.payload.diffArtifactId;
  assert.equal(typeof artifactId, "string");
  const diff = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", artifactId as string),
      "utf8",
    ),
  ) as {
    factRefs: string[];
    beforeDigest: string;
    afterDigest: string;
    changedPaths: { path: string }[];
    taskPathOutcomes: { path: string; disposition: string; verification: string }[];
  };
  assert.ok(diff.beforeDigest);
  assert.ok(diff.afterDigest);
  assert.ok(diff.factRefs.every((ref) => ref.startsWith("fact:")));
  assert.ok(diff.changedPaths.some((entry) => entry.path === "README.md"));
  const lifecycle = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-attempts"), "utf8")) as { state: string; attempts: { phase: string; result: string }[] };
  assert.equal(lifecycle.state, "candidate_pending_review");
  assert.ok(lifecycle.attempts.some((item) => item.phase === "forensics" && item.result === "succeeded"));
  assert.equal(diff.taskPathOutcomes.length, 1);
  assert.deepEqual(
    diff.taskPathOutcomes[0] && {
      path: diff.taskPathOutcomes[0].path,
      disposition: diff.taskPathOutcomes[0].disposition,
      verification: diff.taskPathOutcomes[0].verification,
    },
    { path: "README.md", disposition: "modified", verification: "changed" },
  );
  const reviewArtifactId = finalized?.payload.reviewArtifactId;
  assert.equal(typeof reviewArtifactId, "string");
  assert.equal(finalized?.payload.recommendedAction, "review_candidate");
  const review = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", reviewArtifactId as string),
      "utf8",
    ),
  ) as {
    schemaVersion: number;
    candidateId: string;
    verifierStatus: string;
    evidenceStrength: string;
    recommendedAction: string;
  };
  assert.equal(review.schemaVersion, 1);
  assert.equal(review.candidateId, "candidate-preimage-reconstruction");
  assert.equal(review.verifierStatus, "pending_user_review");
  assert.equal(review.evidenceStrength, "mixed");
  assert.equal(review.recommendedAction, "review_candidate");
  await attempt.selectCandidate?.("candidate-preimage-reconstruction");
  assert.equal(
    events.find((event) => event.type === "recovery.candidate_selected_by_user")?.payload.requiresReexecution,
    false,
  );
  assert.equal(typeof attempt.recordReviewFeedback, "function");
  const feedbackArtifact = await attempt.recordReviewFeedback?.({ candidateId: "candidate-preimage-reconstruction", decision: "accept" });
  assert.match(feedbackArtifact ?? "", /^recovery-review-feedback-candidate-preimage-reconstruction-/);
  const feedbackEvent = events.find((event) => event.type === "recovery.review_feedback_recorded");
  assert.equal(typeof feedbackEvent?.payload.checkpointId, "string");
  assert.equal(typeof attempt.accept, "function");
  const accept = () => {
    if (!attempt.accept) throw new Error("Recovery attempt did not expose accept.");
    return attempt.accept();
  };
  const accepted = await accept();
  assert.equal(accepted.recovery?.status, "partial");
  assert.equal(await readFile(join(accepted.root ?? "", "README.md"), "utf8"), "# recovered\n");
  assert.equal(await readFile(join(base.sourceRoot, "README.md"), "utf8"), "# completed\n");
});

test("Recovery orchestration persists audit/report and accepted baseline can start Candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const writer = tools.find(
        (tool) => tool.name === "write_recovery_report",
      );
      await writer?.execute(
        { content: "# Recovery\n\nRestored from current evidence." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-1",
        value: {
          status: "insufficient_evidence",
          reportPath: "recovery.md",
          unresolved: ["No historical commit."],
          evidenceRefs: [],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-experiment",
    runId: "recovery-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.status, "insufficient_evidence");
  assert.ok(attempt.providerPreview);
  assert.equal(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-md"),
      "utf8",
    ).then((value) => value.includes("Recovery")),
    true,
  );
  const accepted = attempt.accept ? await attempt.accept() : attempt.baseline;
  const result = await startCodexExperiment({
    ...base,
    experimentId: "recovery-experiment",
    runId: "candidate-run",
    environmentProvider: attempt.provider,
    preResolvedBaseline: accepted,
  }).result;
  assert.equal(result.record.outcome.termination.kind, "completed");
  assert.match(
    await readFile(result.reportPath, "utf8"),
    /artifacts\/recovery-md.*recovery_report/,
  );
});

test("Recovery persists shell audit details alongside the report narrative for cross-checking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-audit-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const command = "echo recovery-audit-marker";
  const base = input(root, new VerifiedRuntime());
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession: (session) => ({
        append: async () => {
          const shell = session.tools.find(
            (tool) => tool.name === "staging_shell",
          );
          const report = session.tools.find(
            (tool) => tool.name === "write_recovery_report",
          );
          assert.ok(shell);
          assert.ok(report);
          await shell.execute({ command }, new AbortController().signal);
          await report.execute(
            {
              content:
                "# Recovery\n\nExecuted `echo recovery-audit-marker` while inspecting staging.",
            },
            new AbortController().signal,
          );
          return JSON.stringify({
            status: "insufficient_evidence",
            reportPath: "recovery.md",
            unresolved: ["No historical commit."],
            evidenceRefs: [],
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 5_000,
    maxRepairAttempts: 0,
  });

  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-audit-experiment",
    runId: "recovery-audit-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxToolCalls: 64,
    allowShell: true,
    now,
  });
  const store = await ExperimentStore.open(
    attempt.experimentRoot,
    "recovery-audit-experiment",
  );
  const shellCompleted = store
    .events("recovery-audit-run")
    .find(
      (event) =>
        event.type === "agent.tool_completed" &&
        isRecord(event.payload) &&
        event.payload.tool === "staging_shell",
    );
  const details = isRecord(shellCompleted?.payload)
    ? shellCompleted.payload.details
    : undefined;

  assert.equal(isRecord(details) ? details.command : undefined, command);
  assert.match(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-md"),
      "utf8",
    ),
    /recovery-audit-marker/,
  );
  await store.close();
});

test("Recovery investigates history-only inputs in maximum-effort-safe mode", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-history-capability-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  let called = false;
  const events: { type: string; payload: unknown }[] = [];
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-history-capability",
    runId: "recovery-history-capability-run",
    sourceRoot: base.sourceRoot,
    taskCase: {
      ...base.taskCase,
      evidenceLevel: "history",
      historicalEvents: [],
      initialInput: { id: "secret-task", role: "user", text: "secret task body" },
      transcript: [...base.taskCase.transcript, { id: "private-transcript", role: "user", text: "private transcript" }],
      taskContext: { ...base.taskCase.taskContext, cwd: "C:\\Sensitive\\Workspace" },
    },
    recovery: {
      recover: async () => {
        called = true;
        return {
          status: "completed",
          sessionId: "recovery-history",
          value: {
            status: "insufficient_evidence",
            reportPath: "recovery.md",
            unresolved: ["No recoverable baseline found after forensics."],
            evidenceRefs: [],
          },
        };
      },
    },
    maxToolCalls: 64,
    now,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(called, true);
  assert.equal(attempt.baseline.recovery?.status, "insufficient_evidence");
  assert.deepEqual(
    events
      .map((event) => event.type)
      .filter((type) => type === "recovery.investigation_created"),
    ["recovery.investigation_created"],
  );
  assert.deepEqual(
    events
      .map((event) => event.type)
      .filter((type) => type.startsWith("recovery.forensics_")),
    ["recovery.forensics_started", "recovery.forensics_completed"],
  );
  const modelInput = events.find((event) => event.type === "recovery.model_input");
  assert.ok(modelInput);
  const modelInputPayload = modelInput.payload as {
    artifactId: string;
    contentHash: string;
    byteLength: number;
  };
  const store = await ExperimentStore.open(
    attempt.experimentRoot,
    "recovery-history-capability",
  );
  const bytes = await store.readArtifact({
    artifactId: modelInputPayload.artifactId,
    experimentId: "recovery-history-capability",
    runId: "recovery-history-capability-run",
  });
  assert.equal(bytes.byteLength, modelInputPayload.byteLength);
  assert.equal(sha256(bytes), modelInputPayload.contentHash);
  const persistedInput = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
    evidenceLevel?: string;
    taskCaseId?: string;
    toolNames: string[];
  };
  assert.equal(persistedInput.evidenceLevel, "history");
  assert.equal(persistedInput.taskCaseId, base.taskCase.caseId);
  assert.ok(persistedInput.toolNames.includes("inspect_workspace"));
  const persistedText = Buffer.from(bytes).toString("utf8");
  assert.doesNotMatch(persistedText, /secret task body|private transcript|C:\\Sensitive\\Workspace/);
  await store.close();
});

test("Recovery runs maximum-effort forensics even with an empty transcript and evidence catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  let called = false;
  const events: { type: string; payload: unknown }[] = [];
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-capability",
    runId: "recovery-capability-run",
    sourceRoot: base.sourceRoot,
    taskCase: { ...base.taskCase, transcript: [], historicalEvents: [] },
    recovery: {
      recover: async (context) => {
        called = true;
        assert.equal(context.attemptMode, "maximum-effort-safe");
        return {
          status: "completed",
          sessionId: "recovery-empty",
          value: {
            status: "insufficient_evidence",
            reportPath: "recovery.md",
            unresolved: ["Forensics found no historical baseline."],
            evidenceRefs: [],
          },
        };
      },
    },
    maxToolCalls: 64,
    now,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(called, true);
  assert.equal(attempt.recovery.status, "completed");
  assert.equal(attempt.baseline.recovery?.status, "insufficient_evidence");
  const completed = events.find(
    (event) => event.type === "recovery.forensics_completed",
  );
  assert.deepEqual(completed?.payload, {
    git: { isRepo: false, headState: "unborn", statusAvailable: false },
    transcriptEntries: 0,
    historicalEventEntries: 0,
    preimageCount: 0,
    patchCount: 0,
    verifiedEvidenceCount: 0,
    evidenceQuality: {
      sourceReachability: { available: 2, attempted: 4 },
      taskRelevantEvidence: 0,
      strongEvidence: 0,
      operationBearingEvidence: 0,
      conflictRate: 0,
    },
    operations: [
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
    ],
  });
});

test("Recovery retries a transient staging failure before maximum-effort forensics", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-preflight-retry-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const events: { type: string; payload: unknown }[] = [];
  let copyCalls = 0;
  const provider = new LocalWorkspaceProvider(
    join(root, "provider"),
    async (source, destination) => {
      copyCalls += 1;
      if (copyCalls === 1)
        throw new Error(`copy exploded at ${join(root, "secret-source")}`);
      await mkdir(destination, { recursive: true });
      await writeFile(
        join(destination, "README.md"),
        await readFile(join(source, "README.md")),
      );
    },
  );
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-preflight-retry",
    runId: "recovery-preflight-retry-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => ({
        status: "completed",
        sessionId: "recovery-preflight-retry",
        value: {
          status: "insufficient_evidence",
          reportPath: "recovery.md",
          unresolved: ["No trusted historical baseline."],
          evidenceRefs: [],
        },
      }),
    },
    maxToolCalls: 64,
    now,
    environmentProvider: provider,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.ok(
    copyCalls >= 2,
    "the Provider receives a second staging attempt before candidate copies",
  );
  assert.equal(attempt.baseline.recovery?.status, "insufficient_evidence");
  assert.deepEqual(
    events.find((event) => event.type === "recovery.preflight_retry")?.payload,
    {
      attempt: 2,
      reasonCode: "staging_creation_failed",
      operation: "begin_recovery_staging",
      exitCategory: "hard_failure",
      retryable: true,
    },
  );
  assert.equal(
    events.some((event) => event.type === "recovery.preflight_failed"),
    false,
  );
  assert.equal(
    events.some((event) => event.type === "recovery.forensics_started"),
    true,
  );
});

test("Recovery records a redacted preflight diagnostic after staging retry is exhausted", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-preflight-diagnostic-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const events: { type: string; payload: unknown }[] = [];
  let copyCalls = 0;
  const provider = new LocalWorkspaceProvider(
    join(root, "provider"),
    async (source, destination) => {
      copyCalls += 1;
      if (copyCalls <= 2)
        throw new Error(`copy exploded at ${join(root, "secret-source")}`);
      await mkdir(destination, { recursive: true });
      await writeFile(
        join(destination, "README.md"),
        await readFile(join(source, "README.md")),
      );
    },
  );
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-preflight-diagnostic",
    runId: "recovery-preflight-diagnostic-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => {
        throw new Error("must not run");
      },
    },
    maxToolCalls: 64,
    now,
    environmentProvider: provider,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(
    copyCalls,
    3,
    "the fallback reads the source only after the two staging attempts",
  );
  assert.equal(attempt.baseline.recovery?.failureStage, "preflight_failed");
  const expectedDiagnostic = {
    reasonCode: "staging_creation_failed",
    operation: "begin_recovery_staging",
    exitCategory: "hard_failure",
    retryable: true,
  };
  assert.deepEqual(
    events.find((event) => event.type === "recovery.preflight_retry")?.payload,
    { attempt: 2, ...expectedDiagnostic },
  );
  assert.deepEqual(
    events.find((event) => event.type === "recovery.preflight_failed")?.payload,
    expectedDiagnostic,
  );
  assert.equal(
    events.some((event) => event.type.startsWith("recovery.forensics_")),
    false,
  );
  const evaluation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-evaluation"),
      "utf8",
    ),
  ) as {
    rows: {
      providerFailureRetryable?: boolean;
      pathBoundaryRejected?: boolean;
    }[];
  };
  assert.equal(evaluation.rows[0]?.providerFailureRetryable, true);
  assert.equal("pathBoundaryRejected" in (evaluation.rows[0] ?? {}), false);
});

test("Recovery evaluation records path-boundary rejection without accepting the plan", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-path-boundary-metric-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const submit = tools.find((tool) => tool.name === "submit_recovery_plan");
      assert.ok(submit);
      await submit.execute(
        {
          planId: "unsafe-plan",
          factsUsed: ["fact:workspace-current"],
          hypotheses: [
            {
              hypothesisId: "current-workspace",
              rationale: "inspect",
              paths: ["README.md"],
              supportingFactRefs: ["fact:workspace-current"],
              counterFactRefs: [],
              expectedChecks: ["inspect"],
              confidence: "low",
            },
          ],
          candidates: [
            {
              hypothesisId: "current-workspace",
              operations: [
                {
                  operation: "restore",
                  path: ".git/config",
                  rationale: "invalid path",
                },
              ],
            },
          ],
          verificationPlan: ["inspect"],
        },
        new AbortController().signal,
      );
      throw new Error("unsafe plan unexpectedly accepted");
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-path-boundary-metric",
    runId: "recovery-path-boundary-metric-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery,
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.failureStage, "agent_tool_failed");
  const evaluation = JSON.parse(
    await readFile(
      join(attempt.experimentRoot, "artifacts", "recovery-evaluation"),
      "utf8",
    ),
  ) as {
    rows: {
      providerFailureRetryable?: boolean;
      pathBoundaryRejected?: boolean;
    }[];
  };
  assert.equal(evaluation.rows[0]?.pathBoundaryRejected, true);
  assert.equal("providerFailureRetryable" in (evaluation.rows[0] ?? {}), false);
});

test("Recovery maps a cancelled Agent invocation to the cancelled failure stage", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-cancelled-stage-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-cancelled-stage",
    runId: "recovery-cancelled-stage-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => ({
        status: "cancelled",
        sessionId: "recovery-cancelled",
      }),
    },
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.failureStage, "cancelled");
  assert.equal(
    attempt.baseline.warnings.some((warning) => /cancelled/i.test(warning)),
    true,
  );
});


test("Recovery promotes a task-ready staging baseline automatically", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-auto-ready-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const events: { type: string; payload: unknown }[] = [];
  const readinessTask = {
    ...base.taskCase,
    taskContext: {
      ...base.taskCase.taskContext,
      relevantPaths: ["README.md"],
    },
  } as TaskCase;
  let seenReadiness: unknown;
  let recoveryCalls = 0;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      seenReadiness = _context.readiness;
      recoveryCalls += 1;
      const evidenceRef = _context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      if (recoveryCalls > 2) {
        await tools.find((tool) => tool.name === "write_file")?.execute(
          { path: "README.md", content: "# continue recovered\n" },
          new AbortController().signal,
        );
        await tools.find((tool) => tool.name === "write_recovery_manifest")?.execute(
          { actions: [{ operation: "create", path: "README.md", evidenceRefs: [evidenceRef] }], unresolved: [] },
          new AbortController().signal,
        );
      }
      await tools.find((tool) => tool.name === "write_recovery_report")?.execute(
        { content: "# Recovery\n\nThe task input is available for continuation." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-auto-ready",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: [],
          evidenceRefs: [evidenceRef],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-auto-ready",
    runId: "recovery-auto-ready-run",
    sourceRoot: base.sourceRoot,
    taskCase: readinessTask,
    recovery,
    maxToolCalls: 64,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(recoveryCalls, 3);
  assert.equal(events.filter((event) => event.type === "recovery.readiness_feedback").length, 2);
  assert.deepEqual((seenReadiness as { relevantPaths: string[] }).relevantPaths, ["README.md"]);
  const readinessChecks = events.filter((event) => event.type === "recovery.readiness_checked");
  assert.equal((readinessChecks.at(-1)?.payload as { status: string } | undefined)?.status, "ready");
  assert.equal(attempt.taskReadiness?.status, "ready");
  assert.equal(attempt.baseline.recovery?.taskOutcome, "ready_for_task");
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.root?.includes("baselines"), true);
  assert.equal(await readFile(join(attempt.baseline.root ?? "", "README.md"), "utf8"), "# continue recovered\n");
  const lifecycle = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-attempts"), "utf8")) as { state: string };
  assert.equal(lifecycle.state, "accepted");
  assert.ok(events.some((event) => event.type === "recovery.ready_for_task"));
  assert.equal(events.filter((event) => event.type === "recovery.lifecycle_completed").length, 1);
  const evaluation = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-evaluation"), "utf8")) as { rows: { taskOutcome?: string }[] };
  assert.equal(evaluation.rows[0]?.taskOutcome, "ready_for_task");
  assert.equal((await attempt.accept?.())?.root, attempt.baseline.root);
});
















test("Recovery stops a readiness loop with an unrecoverable task outcome", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-readiness-no-progress-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
      await tools.find((tool) => tool.name === "write_recovery_manifest")?.execute(
        { actions: [], unresolved: ["README.md is not available"] },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write_recovery_report")?.execute(
        { content: "# Recovery\n\nThe task file is unavailable." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: `readiness-no-progress-${calls}`,
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: ["README.md is not available"],
          evidenceRefs: [evidenceRef],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-readiness-no-progress",
    runId: "recovery-readiness-no-progress-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxToolCalls: 64,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(calls, 3);
  assert.equal(attempt.baseline.recovery?.taskOutcome, "unrecoverable");
  assert.equal(events.filter((event) => event.type === "recovery.readiness_feedback").length, 2);
  assert.equal(events.filter((event) => event.type === "recovery.no_progress").length, 1);
  const evaluation = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-evaluation"), "utf8")) as { rows: { taskOutcome?: string }[] };
  assert.equal(evaluation.rows[0]?.taskOutcome, "unrecoverable");
});

test("Recovery classifies a readiness boundary violation as blocked by safety", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-readiness-blocked-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const task = {
    ...base.taskCase,
    taskContext: { ...base.taskCase.taskContext, relevantPaths: ["../outside.txt"] },
  } as TaskCase;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const evidenceRef = _context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      await tools.find((tool) => tool.name === "write_recovery_manifest")?.execute(
        { actions: [], unresolved: ["outside path is not inspected"] },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write_recovery_report")?.execute(
        { content: "# Recovery\n\nThe requested path is outside staging." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "readiness-blocked",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          manifestPath: "recovery-manifest.json",
          unresolved: ["outside path is not inspected"],
          evidenceRefs: [evidenceRef],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-readiness-blocked",
    runId: "recovery-readiness-blocked-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxToolCalls: 64,
    maxModelAttempts: 2,
    now,
  });
  assert.equal(attempt.baseline.recovery?.taskOutcome, "blocked_by_safety");
  assert.equal(attempt.baseline.recovery?.failureStage, "provider_validation_failed");
});
