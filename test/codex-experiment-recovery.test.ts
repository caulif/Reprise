import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RecoveryAgentPort } from "../src/agents/recovery-agent.js";
import { recoverCodexExperiment, startCodexExperiment, classifyRecoveryFailureStage } from "../src/application/experiment.js";
import { LocalWorkspaceProvider } from "../src/environment/local-workspace-provider.js";
import { sha256 } from "../src/core/identity.js";
import { now, VerifiedRuntime, input } from "./codex-experiment-support.js";

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
  assert.equal(
    classifyRecoveryFailureStage(
      "provider_validation_failed",
      new Error("HTTP 400 context_length_exceeded"),
    ),
    "agent_model_failed",
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
      const writer = tools.find((tool) => tool.name === "write");
      assert.ok(writer);
      await writer.execute(
        { path: "README.md", content: "# original\n" },
        new AbortController().signal,
      );
      await writer.execute(
        {
          path: "recovery.md",
          content: "# Recovery\n\nRestored README.md from the verified task-start commit.",
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
    await readFile(join(attempt.baseline.root ?? attempt.staging?.root ?? "", "README.md"), "utf8"),
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
      const writer = tools.find((tool) => tool.name === "write");
      assert.ok(writer);
      await writer.execute(
        { path: "README.md", content: "# recovered\n" },
        new AbortController().signal,
      );
      await writer.execute(
        { path: "recovery.md", content: "# Recovery\n\nCandidate restored README." },
        new AbortController().signal,
      );
      const evidenceRef = context.resolved.evidenceRefs[0];
      assert.ok(evidenceRef);
      return {
        status: "completed",
        sessionId: "recovery-candidate",
        value: {
          status: "partial",
          reportPath: "recovery.md",
          unresolved: ["Current task transcript does not prove the preimage."],
          evidenceRefs: [evidenceRef],
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
    await readFile(join(attempt.baseline.root ?? attempt.staging?.root ?? "", "README.md"), "utf8"),
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
      ["write", "before", "README.md"],
      ["write", "after", "README.md"],
      ["write", "before", "recovery.md"],
      ["write", "after", "recovery.md"],
    ],
  );
  const controlledPostimages = events
    .filter((event) => event.type === "recovery.controlled_write")
    .map((event) => event.payload)
    .filter((entry) => entry.phase === "after");
  assert.equal(controlledPostimages.length, 2);
  assert.deepEqual(
    controlledPostimages.map((entry) => entry.origin),
    ["agent_direct_write", "agent_direct_write"],
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
  assert.equal(
    events.some((event) => event.type === "recovery.investigation_packet"),
    true,
  );
  assert.equal(events.find((event) => event.type === "recovery.plan_submitted"), undefined);
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
  assert.equal(lifecycle.state, "accepted");
  assert.equal(attempt.acceptedAutomatically, true);
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
