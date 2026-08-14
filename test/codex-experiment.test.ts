import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComparisonAgentPort } from "../src/agents/comparison-agent.js";
import { RecoveryAgent, type RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import type { ControllerPort } from "../src/agents/controller-agent.js";
import {
  preflightCodexExperiment,
  recoverCodexExperiment,
  startCodexExperiment,
} from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/pi-agent-host.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import type {
  ResolvedRuntime,
  RuntimePort,
  TargetEventSink,
  TargetRunner,
} from "../src/core/runtime.js";
import { isRecord } from "../src/core/json.js";
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
    return [{ productId: "codex", executable: "verified-test", observedVersion: "fixture", status: "available" as const, observedAt: now }];
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
      { content: "# Comparison\n\nEvidence-based narrative." },
      new AbortController().signal,
    );
    return {
      status: "completed",
      sessionId: "comparison-1",
      value: {
        status: "completed",
        reportPath: "comparison.md",
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
    await readFile(join(result.experimentRoot, "comparison.md"), "utf8"),
    /Evidence-based narrative/,
  );
  const report = await readFile(result.reportPath, "utf8");
  assert.match(report, /href="comparison\.md"/);
  assert.match(report, /not a ranking/i);
  assert.match(report, /Evidence-based narrative/);
  assert.match(report, /\d+ ms/);
  assert.match(report, /host-trace\.json/);
  assert.doesNotMatch(report, /unknown/);
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
    return [{ productId: "codex", executable: "multi-turn-test", observedVersion: "fixture", status: "available" as const, observedAt: now }];
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

test("a completed comparison without comparison.md is recorded as an Agent failure, not a fallback narrative", async (t) => {
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
        reportPath: "comparison.md",
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
    /No validated comparison narrative/,
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
  assert.match(validation.message, /not owned/i);
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
      message:
        "Recovery changed the user source directory; staging will be discarded.",
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
  await runGit(["add", "README.md"]);
  await runGit(["commit", "-m", "task-start"]);
  const commit = await runGit(["rev-parse", "HEAD"]);
  await writeFile(join(source, "README.md"), "# completed\n");
  const base = input(root, new VerifiedRuntime());
  const task = { ...base.taskCase, taskContext: { historicalCommit: commit } };
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const shell = tools.find((tool) => tool.name === "staging_shell");
      const report = tools.find(
        (tool) => tool.name === "write_recovery_report",
      );
      assert.ok(shell);
      assert.ok(report);
      await shell.execute(
        { command: `git checkout ${commit} -- README.md` },
        new AbortController().signal,
      );
      await report.execute(
        {
          content:
            "# Recovery\n\nRestored README.md from the verified task-start commit.",
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
    await readFile(join(attempt.experimentRoot, "artifacts", "recovery-md"), "utf8"),
    /recovery-audit-marker/,
  );
  await store.close();
});
