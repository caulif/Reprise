import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryAgent, type RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import { recoverCodexExperiment } from "../src/application/recovery/recover.js";
import { startCodexExperiment } from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/agent/host.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import { isRecord } from "../src/core/json.js";
import { sha256 } from "../src/core/identity.js";
import type { TaskCase } from "../src/core/schema.js";
import { now, VerifiedRuntime, input, patientPolicy } from "./codex-experiment-support.js";

test("Recovery orchestration persists audit/report and accepted baseline can start Candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const events: { type: string; payload: unknown }[] = [];
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      const writer = tools.find(
        (tool) => tool.name === "write",
      );
      await writer?.execute(
        { path: "recovery.md", content: "# Recovery\n\nRestored from current evidence." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-1",
        value: {
          status: "ready",
          reportPath: "recovery.md",
          unresolved: [],
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
    allowCurrentStateFallback: true,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(
    events.some((event) => event.type === "recovery.investigation_created"),
    true,
  );
  assert.equal(attempt.baseline.recovery?.status, "ready");
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
    policy: { ...base.policy, ...patientPolicy },
  }).result;
  assert.equal(result.record.outcome.termination.kind, "completed");
  assert.match(
    await readFile(result.reportPath, "utf8"),
    /artifacts\/recovery-md.*recovery_report/,
  );
});

test("Recovery persists shell audit details alongside the report narrative for cross-checking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-audit-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const command = "echo recovery-audit-marker";
  const base = input(root, new VerifiedRuntime());
  const recovery = new RecoveryAgent({
    host: new PiAgentHost({
      createSession: (session) => ({
        append: async () => {
          const shell = session.tools.find(
            (tool) => tool.name === "shell_exec",
          );
          const report = session.tools.find(
            (tool) => tool.name === "write",
          );
          assert.ok(shell);
          assert.ok(report);
          await shell.execute({ command }, new AbortController().signal);
          await report.execute(
            {
              path: "recovery.md",
              content:
                "# Recovery\n\nExecuted `echo recovery-audit-marker` while inspecting staging.",
            },
            new AbortController().signal,
          );
          return JSON.stringify({
            status: "blocked",
            reportPath: "recovery.md",
            unresolved: ["No historical commit."],
            evidenceRefs: [],
          });
        },
        cancel() {},
      }),
    }),
    timeoutMs: 30_000,
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
        event.payload.tool === "shell_exec",
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
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  let called = false;
  let observedBudget: number | undefined;
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
      timeoutMs: 43210,
      recover: async (_context, tools) => {
        observedBudget = _context.budget.timeoutMs;
        called = true;
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "recovery.md", content: "# Recovery\n\nHistory-only investigation." },
          new AbortController().signal,
        );
        return {
          status: "completed",
          sessionId: "recovery-history",
          value: {
            status: "blocked",
            reportPath: "recovery.md",
            unresolved: ["No recoverable baseline found after forensics."],
          },
        };
      },
    },
    now,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(called, true);
  assert.equal(observedBudget, 43210);
  assert.equal(attempt.baseline.recovery?.status, "blocked");
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
    budget: { timeoutMs: number };
    toolNames: string[];
  };
  assert.equal(persistedInput.evidenceLevel, "history");
  assert.equal(persistedInput.taskCaseId, base.taskCase.caseId);
  assert.equal(persistedInput.budget.timeoutMs, observedBudget);
  assert.ok(persistedInput.toolNames.includes("ls"));
  const persistedText = Buffer.from(bytes).toString("utf8");
  assert.doesNotMatch(persistedText, /secret task body|private transcript|C:\\Sensitive\\Workspace/);
  await store.close();
});

test("Recovery runs maximum-effort forensics even with an empty transcript and evidence catalog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-capability-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
      recover: async (_context, tools) => {
        called = true;
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "recovery.md", content: "# Recovery\n\nEmpty catalog." },
          new AbortController().signal,
        );
        return {
          status: "completed",
          sessionId: "recovery-empty",
          value: {
            status: "blocked",
            reportPath: "recovery.md",
            unresolved: ["Forensics found no historical baseline."],
          },
        };
      },
    },
    now,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(called, true);
  assert.equal(attempt.recovery.status, "completed");
  assert.equal(attempt.baseline.recovery?.status, "blocked");
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
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
      recover: async (_context, tools) => {
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "recovery.md", content: "# Recovery\n\nStaging retry." },
          new AbortController().signal,
        );
        return {
        status: "completed",
        sessionId: "recovery-preflight-retry",
        value: {
          status: "blocked",
          reportPath: "recovery.md",
          unresolved: ["No trusted historical baseline."],
        },
      };
      },
    },
    now,
    environmentProvider: provider,
    onEvent: (event) =>
      events.push({ type: event.type, payload: event.payload }),
  });
  assert.ok(
    copyCalls >= 2,
    "the Provider receives a second staging attempt before candidate copies",
  );
  assert.equal(attempt.baseline.recovery?.status, "blocked");
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
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      assert.equal(tools.some((tool) => tool.name === "submit_recovery_plan"), false);
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nNo plan tool." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-path-boundary-metric",
        value: {
          status: "blocked",
          reportPath: "recovery.md",
          unresolved: ["no candidate justified"],
        },
      };
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
    now,
  });
  assert.equal(attempt.baseline.match, "current_state_fallback");
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
  assert.equal(evaluation.rows[0]?.pathBoundaryRejected, undefined);
  assert.equal("providerFailureRetryable" in (evaluation.rows[0] ?? {}), false);
});

test("Recovery maps a cancelled Agent invocation to the cancelled failure stage", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "reprise-recovery-cancelled-stage-"),
  );
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "# continue recovered\n");
  const events: { type: string; payload: unknown }[] = [];
  const readinessTask = {
    ...base.taskCase,
    taskContext: {
      ...base.taskCase.taskContext,
      relevantPaths: ["README.md"],
    },
  } as TaskCase;
  let recoveryCalls = 0;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      recoveryCalls += 1;
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe task input is available for continuation." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-auto-ready",
        value: {
          status: "ready",
          reportPath: "recovery.md",
          unresolved: [],
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
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(recoveryCalls, 1);
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.recovery?.status, "ready");
  assert.equal(attempt.baseline.recovery?.taskOutcome, "ready_for_task");
  assert.equal(attempt.baseline.root?.includes("baselines"), true);
  assert.equal(await readFile(join(attempt.baseline.root ?? "", "README.md"), "utf8"), "# continue recovered\n");
  const lifecycle = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-attempts"), "utf8")) as { state: string };
  assert.equal(lifecycle.state, "accepted");
  assert.ok(events.some((event) => event.type === "recovery.lifecycle_completed"));
  assert.equal(events.filter((event) => event.type === "recovery.lifecycle_completed").length, 1);
  const evaluation = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-evaluation"), "utf8")) as { rows: { taskOutcome?: string }[] };
  assert.equal(evaluation.rows[0]?.taskOutcome, "ready_for_task");
  assert.equal((await attempt.accept?.())?.root, attempt.baseline.root);
});

test("Recovery keeps the first TypeBox-valid envelope when a later model request exceeds context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-keep-envelope-"));
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
      if (calls > 1) throw new Error("HTTP 400 context_length_exceeded");
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "notes.txt", content: "recovered note\n" },
        new AbortController().signal,
      );
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nFirst envelope stayed after the context-length failure." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-keep-envelope",
        value: {
          status: "ready",
          reportPath: "recovery.md",
          unresolved: ["README.md is not reconstructed"],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-keep-envelope",
    runId: "recovery-keep-envelope-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(calls, 1);
  assert.equal(attempt.baseline.match, "recovered");
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.root?.includes("baselines"), true);
  assert.equal(attempt.baseline.recovery?.status, "ready");
  assert.equal(attempt.accept !== undefined, true);
});

test("Recovery classifies a first-turn context-length error as agent_model_failed without an accept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-context-first-fail-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "source", "README.md"), "# source\n");
  const base = input(root, new VerifiedRuntime());
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-context-first-fail",
    runId: "recovery-context-first-fail-run",
    sourceRoot: base.sourceRoot,
    taskCase: base.taskCase,
    recovery: {
      recover: async () => {
        throw new Error("HTTP 400 context_length_exceeded");
      },
    },
    now,
  });
  assert.equal(attempt.baseline.recovery?.failureStage, "agent_model_failed");
  assert.equal(attempt.accept === undefined, true);
});
















test("Recovery stops a readiness loop with an unrecoverable task outcome", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-readiness-no-progress-"));
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
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe task file is unavailable." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: `readiness-no-progress-${calls}`,
        value: {
          status: "blocked",
          reportPath: "recovery.md",
          unresolved: ["README.md is not available"],
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
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(calls, 1);
  assert.equal(attempt.baseline.recovery?.taskOutcome, "unrecoverable");
  assert.equal(events.filter((event) => event.type === "recovery.readiness_feedback").length, 0);
  const evaluation = JSON.parse(await readFile(join(attempt.experimentRoot, "artifacts", "recovery-evaluation"), "utf8")) as { rows: { taskOutcome?: string }[] };
  assert.equal(evaluation.rows[0]?.taskOutcome, "unrecoverable");
});

test("insufficient evidence does not loop for missing paths and cannot be accepted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-insufficient-stop-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const task = {
    ...base.taskCase,
    taskContext: { ...base.taskCase.taskContext, relevantPaths: ["README.md"] },
  } as TaskCase;
  let calls = 0;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      calls += 1;
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nNo recoverable evidence." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "insufficient-stop",
        value: {
          status: "blocked",
          reportPath: "recovery.md",
          unresolved: ["checked git, transcript, and workspace; no rewindable start"],
        },
      };
    },
  };
  const attempt = await recoverCodexExperiment({
    dataDir: base.dataDir,
    caseId: base.caseId,
    experimentId: "recovery-insufficient-stop",
    runId: "recovery-insufficient-stop-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxModelAttempts: 3,
    now,
  });
  assert.equal(calls, 1);
  assert.equal(attempt.accept === undefined, true);
  assert.equal(attempt.acceptedAutomatically, undefined);
  assert.equal(attempt.baseline.recovery?.status, "blocked");
  const diagnosis = JSON.parse(await readFile(join(attempt.experimentRoot, "recovery-diagnosis.json"), "utf8")) as { finalStatus: string };
  assert.equal(diagnosis.finalStatus, "failed");
});


test("Recovery classifies a readiness boundary violation as blocked by safety", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-readiness-blocked-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const task = {
    ...base.taskCase,
    taskContext: { ...base.taskCase.taskContext, relevantPaths: ["../outside.txt"] },
  } as TaskCase;
  const recovery: RecoveryAgentPort = {
    recover: async (_context, tools) => {
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe requested path is outside staging." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "readiness-blocked",
        value: {
          status: "blocked",
          reportPath: "recovery.md",
          unresolved: ["outside path is not inspected"],
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
    maxModelAttempts: 2,
    now,
  });
  assert.equal(attempt.baseline.recovery?.taskOutcome, "unrecoverable");
  assert.equal(attempt.baseline.recovery?.status, "blocked");
});



