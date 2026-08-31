import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecoveryAgent, type RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import { recoverCodexExperiment, startCodexExperiment } from "../src/application/experiment.js";
import { PiAgentHost } from "../src/infrastructure/pi-agent-host.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { ExperimentStore } from "../src/infrastructure/store/experiment-store.js";
import { isRecord } from "../src/core/json.js";
import { sha256 } from "../src/core/identity.js";
import type { TaskCase } from "../src/core/schema.js";
import { now, VerifiedRuntime, input } from "./codex-experiment-support.js";

test("Recovery orchestration persists audit/report and accepted baseline can start Candidate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-recovery-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(
    events.some((event) => event.type === "recovery.investigation_packet"),
    true,
  );
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
            (tool) => tool.name === "powershell",
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
        event.payload.tool === "powershell",
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
  assert.ok(persistedInput.toolNames.includes("ls"));
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
      assert.equal(tools.some((tool) => tool.name === "submit_recovery_plan"), false);
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nNo plan tool." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-path-boundary-metric",
        value: {
          status: "insufficient_evidence",
          reportPath: "recovery.md",
          unresolved: ["no candidate justified"],
          evidenceRefs: [],
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
    maxToolCalls: 64,
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
        await tools.find((tool) => tool.name === "write")?.execute(
          { path: "README.md", content: "# continue recovered\n" },
          new AbortController().signal,
        );
      }
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe task input is available for continuation." },
        new AbortController().signal,
      );
      return {
        status: "completed",
        sessionId: "recovery-auto-ready",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          unresolved: ["README.md was reconstructed on a later turn"],
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

test("Recovery keeps the first TypeBox-valid envelope when a later model request exceeds context", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-keep-envelope-"));
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
      if (calls > 1) throw new Error("HTTP 400 context_length_exceeded");
      const evidenceRef = _context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
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
    experimentId: "recovery-keep-envelope",
    runId: "recovery-keep-envelope-run",
    sourceRoot: base.sourceRoot,
    taskCase: task,
    recovery,
    maxToolCalls: 64,
    maxModelAttempts: 3,
    now,
    onEvent: (event) => events.push({ type: event.type, payload: event.payload }),
  });
  assert.equal(calls, 2);
  assert.equal(attempt.baseline.match, "recovered_partial");
  assert.equal(attempt.acceptedAutomatically, true);
  assert.equal(attempt.baseline.root?.includes("baselines"), true);
  assert.equal(attempt.baseline.recovery?.status, "partial");
  assert.equal(attempt.accept !== undefined, true);
  assert.equal(
    events.some(
      (event) =>
        event.type === "recovery.model_retry" &&
        (event.payload as { keptCompletedEnvelope?: boolean }).keptCompletedEnvelope === true,
    ),
    true,
  );
});

test("Recovery classifies a first-turn context-length error as agent_model_failed without an accept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-recovery-context-first-fail-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
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
    maxToolCalls: 64,
    now,
  });
  assert.equal(attempt.baseline.recovery?.failureStage, "agent_model_failed");
  assert.equal(attempt.accept === undefined, true);
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
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe task file is unavailable." },
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
      await tools.find((tool) => tool.name === "write")?.execute(
        { path: "recovery.md", content: "# Recovery\n\nThe requested path is outside staging." },
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
