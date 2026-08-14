import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ComparisonAgentPort,
  ComparisonResult,
} from "../agents/comparison-agent.js";
import {
  historicalUserFollowups,
  type ControllerDecision,
  type ControllerPort,
} from "../agents/controller-agent.js";
import type {
  RecoveryAgentPort,
  RecoveryResult,
} from "../agents/recovery-agent.js";
import { rewindIsolatedWorkspaceToStart } from "./session-start-workspace.js";
import { CandidateRun } from "./candidate-run.js";
import type {
  CandidateSpec,
  EventEnvelope,
  RunManifest,
  RunPolicy,
  RunRecord,
  TaskCase,
} from "../core/schema.js";
import type {
  ResolvedRuntime,
  RuntimePort,
  TargetEvent,
  TargetEventSink,
} from "../core/runtime.js";
import {
  LocalWorkspaceProvider,
  type EnvironmentBaseline,
  type PreparedEnvironmentRef,
  type RecoveryPreview,
  type RecoveryStaging,
} from "../environment/local-workspace-provider.js";
import type { ContaminationSignals } from "../environment/contamination.js";
import { observationTools } from "../infrastructure/agent-tools.js";
import {
  recoveryObservationTools,
  recoveryTools,
  resolvedRecoveryFacts,
  validateRecoveryEvidence,
} from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import {
  ExperimentStore,
  writeImmutableJson,
} from "../infrastructure/store/experiment-store.js";
import { findProductPack } from "../products/index.js";
import type { ProductPack } from "../products/contract.js";
import {
  describeStop,
  historicalCwdOf,
  hostReplayConditions,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import {
  assertIds,
  assertPaths,
  invocationFact,
  isCompleted,
  isMissing,
} from "./experiment-helpers.js";
import { captureWorkspaceScope, inspectRun } from "./experiment-inspection.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import { finishExperiment } from "./experiment-report.js";

export { hostReplayConditions, inferSourceRootKind, historicalCwdOf, describeStop };
export type { SourceRootKind };
export { preflightCodexExperiment } from "./experiment-preflight.js";

export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: { callTimeoutMs: number; maxStructuredRepairAttempts: number };
};

export type CodexExperimentPreflight = {
  sourceBaseline: "available" | "partial" | "unavailable";
  resolved: ResolvedRuntime;
  sourceFingerprint?: string;
  workspace?: EnvironmentBaseline["budget"];
  limitations: readonly string[];
  comparisonClass: "observational" | "recovered" | "recovered_partial";
  contamination?: ContaminationSignals;
};

export type CodexExperimentResult = {
  taskCase: TaskCase;
  experimentRoot: string;
  reportPath: string;
  preflight: CodexExperimentPreflight;
  record: RunRecord;
  decision: StructuredAgentResult<ControllerDecision>;
  comparison: { result: StructuredAgentResult<ComparisonResult> };
  followupSubmission: boolean;
  targetEvents: readonly string[];
  facts: {
    elapsedMs: number;
    turns: number;
    controllerCalls: number;
    wallClockMs?: number;
    tokenCount?: number;
  };
};

export type CodexExperimentInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  sourceRootKind?: SourceRootKind;
  taskCase: TaskCase | ((baseline: EnvironmentBaseline) => TaskCase);
  candidate: CandidateSpec;
  policy: RunPolicy;
  agentConfig: ExperimentAgentConfig;
  /** Comparison may use a different persisted Harness model. */
  comparisonAgentConfig?: ExperimentAgentConfig;
  runtime: RuntimePort;
  pack?: ProductPack;
  environmentProvider?: LocalWorkspaceProvider;
  /** A previously validated Recovery preview selected by the operator. */
  preResolvedBaseline?: EnvironmentBaseline;
  /** Digest captured by preflight; prevents replaying a source that changed while the user reviewed it. */
  expectedSourceFingerprint?: string;
  controller: ControllerPort;
  comparison: ComparisonAgentPort;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  captureArtifacts?: (input: {
    store: ExperimentStore;
    environment: PreparedEnvironmentRef;
    workspaceProvider: LocalWorkspaceProvider;
    sourceRoot: string;
    experimentId: string;
    runId: string;
  }) => Promise<readonly RunRecord["artifactRefs"][number][] | readonly []>;
};

export type ExperimentHandle = {
  result: Promise<CodexExperimentResult>;
  cancel(): Promise<void>;
};

export type RecoveryAttempt = {
  readonly baseline: EnvironmentBaseline;
  readonly providerPreview?: RecoveryPreview;
  readonly staging?: RecoveryStaging;
  readonly recovery: StructuredAgentResult<RecoveryResult>;
  readonly experimentRoot: string;
  readonly experimentId: string;
  readonly provider: LocalWorkspaceProvider;
  accept?(): Promise<EnvironmentBaseline>;
};

export type RecoveryAttemptInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  taskCase: TaskCase;
  recovery: RecoveryAgentPort;
  maxToolCalls: number;
  environmentProvider?: LocalWorkspaceProvider;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
};

/** Runs Recovery only in unpublished Provider staging. The caller must explicitly accept the returned preview. */
export async function recoverCodexExperiment(
  input: RecoveryAttemptInput,
): Promise<RecoveryAttempt> {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
  const experimentRoot = join(
    resolve(input.dataDir),
    "experiments",
    input.experimentId,
  );
  const provider =
    input.environmentProvider ??
    new LocalWorkspaceProvider(join(experimentRoot, "environment"));
  await mkdir(experimentRoot, { recursive: true });
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent
    ? store.subscribe(input.onEvent)
    : undefined;
  let staging: RecoveryStaging | undefined;
  let recovery: StructuredAgentResult<RecoveryResult> | undefined;
  try {
    await store.acquireWriter();
    const pack = findProductPack(input.taskCase.source.productId);
    const descriptor = pack.recoveryPlaybook();
    const playbook = {
      productId: pack.manifest.productId,
      ...descriptor,
    };
    staging = await provider.beginRecovery({
      caseId: input.caseId,
      sourceRoot: resolve(input.sourceRoot),
      playbook,
    });
    const audit = {
      append: async (
        event: import("../infrastructure/pi-agent-host.js").AgentAuditEvent,
      ): Promise<void> => {
        await store.append({
          type: event.type,
          runId: input.runId,
          payload: {
            role: event.role,
            sessionId: event.sessionId,
            ...event.payload,
          },
        });
      },
    };
    await store.append({
      type: "recovery.started",
      runId: input.runId,
      operationId: "recovery-started",
      payload: {
        sourceDigest: staging.sourceFingerprint.digest,
        playbook: { version: playbook.version, sha256: playbook.sha256 },
      },
    });
    const facts = await resolvedRecoveryFacts(staging.root, input.taskCase);
    const context = {
      task: {
        caseId: input.taskCase.caseId,
        initialInput: input.taskCase.initialInput,
      },
      session: {
        transcriptLength: input.taskCase.transcript.length,
        historicalEventCount: input.taskCase.historicalEvents.length,
      },
      clues: recoveryClues(input.taskCase),
      resolved: facts,
      playbook,
      staging: {
        fileCount: staging.sourceBudget.fileCount,
        totalBytes: staging.sourceBudget.totalBytes,
      },
      budget: { maxToolCalls: input.maxToolCalls, timeoutMs: 600_000 },
      allowModelText: input.taskCase.privacy.allowModelText,
    };
    recovery = await input.recovery.recover(
      context,
      [
        ...recoveryObservationTools(input.taskCase),
        ...recoveryTools(
          staging.root,
          input.maxToolCalls,
          staging.temporaryRoot ? { homeRoot: staging.temporaryRoot } : {},
        ),
      ],
      audit,
    );
    await writeImmutableJson(join(experimentRoot, "recovery.json"), recovery);
    await store.append({
      type: "recovery.completed",
      runId: input.runId,
      operationId: "recovery-completed",
      payload: invocationFact(recovery),
    });
    if (recovery.status !== "completed")
      throw new Error(`Recovery did not complete: ${recovery.status}.`);
    validateRecoveryEvidence(facts.evidenceRefs, recovery.value);
    const providerPreview = await provider.validateRecovery(
      staging,
      recovery.value,
      facts.verifiedEvidence,
    );
    if (providerPreview.reportText) {
      await store.commitArtifact({
        artifactId: "recovery-md",
        kind: "recovery_report",
        mediaType: "text/markdown",
        bytes: Buffer.from(providerPreview.reportText, "utf8"),
      });
    }
    return {
      baseline: providerPreview.baseline,
      providerPreview,
      staging,
      recovery,
      experimentRoot,
      experimentId: input.experimentId,
      provider,
      accept: () => provider.acceptRecovery(providerPreview),
    };
  } catch (error) {
    if (staging) await provider.discardRecovery(staging).catch(() => undefined);
    const fallback = await provider.resolveBaseline(
      { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
      [],
      {},
    );
    const failureMessage =
      error instanceof Error ? error.message : String(error);
    const baseline: EnvironmentBaseline = {
      ...fallback,
      warnings: [
        ...fallback.warnings,
        `Recovery failed; replay uses the current source state: ${failureMessage}`,
      ],
      recovery: {
        status: "failed",
        unresolved: ["Recovery was not verified."],
        sourceDigest: fallback.fingerprint.digest,
        recoveredDigest: fallback.fingerprint.digest,
      },
    };
    const failed = recovery ?? {
      status: "failed" as const,
      failure: {
        code: "agent_failure" as const,
        message: failureMessage,
        attempts: 1,
      },
    };
    await writeImmutableJson(join(experimentRoot, "recovery-validation.json"), {
      status: "failed",
      message: failureMessage,
      agentInvocation: failed,
    });
    await store.append({
      type: "recovery.warning",
      runId: input.runId,
      operationId: "recovery-warning",
      payload: { message: failureMessage, fallback: "current_state" },
    });
    return {
      baseline,
      recovery: failed,
      experimentRoot,
      experimentId: input.experimentId,
      provider,
    };
  } finally {
    unsubscribe?.();
    await store.close();
  }
}

type ActiveRun = { cancel(): Promise<unknown> };

/**
 * The publishing-level Codex experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startCodexExperiment(
  input: CodexExperimentInput,
): ExperimentHandle {
  let active: ActiveRun | undefined;
  let activeController: ControllerPort | undefined;
  let activeRunId: string | undefined;
  let cancelRequested = false;
  const result = executeExperiment(input, {
    setActive(run) {
      active = run;
    },
    setController(controller, runId) {
      activeController = controller;
      activeRunId = runId;
    },
    cancelled() {
      return cancelRequested;
    },
  });
  return {
    result,
    async cancel(): Promise<void> {
      cancelRequested = true;
      if (activeController && activeRunId)
        await activeController.cancel?.(
          activeRunId,
          `run:${activeRunId}:cancelled`,
        );
      if (active) await active.cancel();
    },
  };
}

async function executeExperiment(
  input: CodexExperimentInput,
  control: {
    setActive(run: ActiveRun): void;
    setController(controller: ControllerPort, runId: string): void;
    cancelled(): boolean;
  },
): Promise<CodexExperimentResult> {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
  findProductPack(input.candidate.productId);
  if (
    typeof input.taskCase !== "function" &&
    input.caseId !== input.taskCase.caseId
  )
    throw new Error("Experiment caseId must match TaskCase.caseId.");
  const experimentRoot = join(
    resolve(input.dataDir),
    "experiments",
    input.experimentId,
  );
  const startedAt = Date.now();
  const provider =
    input.environmentProvider ??
    new LocalWorkspaceProvider(join(experimentRoot, "environment"));
  const resolved = await resolveVerifiedCandidate(
    input.runtime,
    input.candidate,
  );
  const baseline =
    input.preResolvedBaseline ??
    (await provider.resolveBaseline(
      { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
      [],
      {},
    ));
  const sourceDigest =
    baseline.recovery?.sourceDigest ?? baseline.fingerprint.digest;
  if (
    input.expectedSourceFingerprint &&
    sourceDigest !== input.expectedSourceFingerprint
  ) {
    throw new Error(
      "The selected source changed after preflight. Run preflight again before starting the Candidate.",
    );
  }
  const taskCase =
    typeof input.taskCase === "function"
      ? input.taskCase(baseline)
      : input.taskCase;
  if (taskCase.caseId !== input.caseId)
    throw new Error(
      "Recovered TaskCase.caseId must match the experiment caseId.",
    );
  const historicalCwd = historicalCwdOf(taskCase);
  let sourceRootKind = inferSourceRootKind({
    sourceRoot: resolve(input.sourceRoot),
    ...(historicalCwd ? { historicalCwd } : {}),
    ...(input.sourceRootKind ? { explicit: input.sourceRootKind } : {}),
  });
  await mkdir(experimentRoot, { recursive: true });
  const preflight = preflightFromBaseline(baseline, resolved);
  await ensureTaskCase(
    join(resolve(input.dataDir), "cases", input.caseId, "case.json"),
    taskCase,
  );
  await writeImmutableJson(join(experimentRoot, "preflight.json"), preflight);
  if (preflight.sourceBaseline === "unavailable")
    throw new Error(
      "Candidate was not started because the source baseline is unavailable.",
    );
  if (control.cancelled())
    throw new Error("Experiment was cancelled before Candidate startup.");

  const comparisonAgentConfig =
    input.comparisonAgentConfig ?? input.agentConfig;
  const spec = {
    experimentId: input.experimentId,
    taskCaseId: input.caseId,
    candidates: [input.candidate],
    controller: input.agentConfig,
    comparison: comparisonAgentConfig,
    runPolicy: input.policy,
    outputRoot: experimentRoot,
  };
  await writeImmutableJson(join(experimentRoot, "experiment.json"), {
    spec,
    runIds: [input.runId],
  });
  let environment = await provider.prepareRun(baseline, input.runId);
  if (sourceRootKind === "historical_cwd") {
    const rewind = await rewindIsolatedWorkspaceToStart({
      workspaceRoot: environment.root,
      taskCase,
      ...(historicalCwd ? { historicalCwd } : {}),
    });
    if (rewind.removed.length) {
      sourceRootKind = "historical_start";
      environment = {
        ...environment,
        beforeFingerprint: await provider.fingerprint(environment),
      };
    }
  }
  const attempt = {
    schemaVersion: 1 as const,
    runId: input.runId,
    experimentId: input.experimentId,
    caseId: input.caseId,
    candidate: input.candidate,
    policy: input.policy,
    createdAt: input.now,
  };
  const manifest: RunManifest = {
    schemaVersion: 1,
    attempt,
    resolvedModel: {
      requested: resolved.requestedModel,
      resolved: resolved.resolvedModel,
    },
    runtime: {
      productId: resolved.productId,
      executable: resolved.executable,
      ...(resolved.version ? { version: resolved.version } : {}),
    },
    environment: {
      environmentId: environment.environmentId,
      workspacePath: environment.root,
    },
    controller: input.agentConfig,
    comparison: comparisonAgentConfig,
    startedAt: input.now,
  };
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent
    ? store.subscribe(input.onEvent)
    : undefined;
  let released = false;
  const release = async () => {
    released = true;
    return provider.release(environment);
  };
  const targetEvents: string[] = [];
  let run: CandidateRun | undefined;
  try {
    await store.acquireWriter();
    const recoveryArtifact = input.preResolvedBaseline?.recovery?.reportRef
      ? (await store.listArtifacts()).find(
          (artifact) =>
            artifact.artifactId ===
            input.preResolvedBaseline?.recovery?.reportRef,
        )
      : undefined;
    const recoveryArtifactRef = recoveryArtifact
      ? {
          artifactId: recoveryArtifact.artifactId,
          experimentId: input.experimentId,
        }
      : undefined;
    const sink: TargetEventSink = {
      append: async (targetEvent: TargetEvent): Promise<void> => {
        const event = await store.append({
          type: targetEvent.type,
          runId: input.runId,
          payload: targetEvent.payload,
          occurredAt: targetEvent.occurredAt,
        });
        targetEvents.push(`event:${event.eventId}`);
      },
    };
    const runner = await input.runtime.createRunner(
      resolved,
      environment,
      sink,
    );
    run = new CandidateRun({
      runner,
      policy: {
        turnTimeoutMs: input.policy.turnTimeoutMs,
        maxTargetTurns: input.policy.maxTargetTurns,
      },
      release,
      persistence: {
        journal: store,
        attempt,
        manifest,
        ...(recoveryArtifactRef ? { artifactRefs: [recoveryArtifactRef] } : {}),
        captureArtifacts: () =>
          input.captureArtifacts
            ? input.captureArtifacts({
                store,
                environment,
                workspaceProvider: provider,
                sourceRoot: resolve(input.sourceRoot),
                experimentId: input.experimentId,
                runId: input.runId,
              })
            : captureWorkspaceScope({
                store,
                environment,
                workspaceProvider: provider,
                experimentId: input.experimentId,
                runId: input.runId,
              }),
      },
    });
    control.setActive(run);
    control.setController(input.controller, input.runId);
    if (control.cancelled()) await run.cancel();
    else {
      const controller = await runControllerLoop({
        run,
        controller: input.controller,
        store,
        runId: input.runId,
        taskCase,
        policy: input.policy,
        controllerModel: input.agentConfig.requestedModel,
        environment,
        workspaceProvider: provider,
        sourceRootKind,
        requestedModel: input.candidate.requestedModel,
        resolvedModel: resolved.resolvedModel,
      });
      return await finishExperiment({
        input,
        taskCase,
        preflight,
        store,
        run,
        controller,
        experimentRoot,
        targetEvents,
        startedAt,
        sourceRootKind,
      });
    }
    const cancelled = {
      decision: {
        status: "cancelled" as const,
        factRef: `run:${input.runId}:cancelled`,
      },
      followupSubmission: false,
    };
    return await finishExperiment({
      input,
      taskCase,
      preflight,
      store,
      run,
      controller: cancelled,
      experimentRoot,
      targetEvents,
      startedAt,
      sourceRootKind,
    });
  } catch (error) {
    if (run?.states().at(-1) === "awaiting_controller") await run.cancel();
    throw error;
  } finally {
    unsubscribe?.();
    if (!released) await release();
    await store.close();
  }
}

async function runControllerLoop(input: {
  run: CandidateRun;
  controller: ControllerPort;
  store: ExperimentStore;
  runId: string;
  taskCase: TaskCase;
  policy: RunPolicy;
  controllerModel: string;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
  sourceRootKind: SourceRootKind;
  requestedModel: string;
  resolvedModel: string;
}): Promise<{
  decision: StructuredAgentResult<ControllerDecision>;
  followupSubmission: boolean;
}> {
  let state = await input.run.start(
    {
      id: input.taskCase.initialInput.id,
      text: input.taskCase.initialInput.text,
    },
    {
      runId: input.runId,
      turnIndex: 0,
      clientMessageId: `initial-${input.runId}`,
    },
  );
  const decisions: StructuredAgentResult<ControllerDecision>[] = [];
  let controllerCalls = 0;
  let duplicateInputs = 0;
  let followupSubmission = false;
  const startedAt = Date.now();
  await input.store.append({
    type: "controller.started",
    runId: input.runId,
    operationId: "controller-started",
    payload: { model: input.controllerModel },
  });
  while (state === "awaiting_controller") {
    if (Date.now() - startedAt >= input.policy.wallClockMs) {
      state = await input.run.stopByHarness("limit.wall_clock");
      break;
    }
    if (controllerCalls >= input.policy.maxModelCalls) {
      state = await input.run.stopByHarness("limit.controller_calls");
      break;
    }
    const observation = await inspectRun(
      input.store,
      undefined,
      input.taskCase.privacy.allowModelText,
      input.taskCase.source.productId,
      {
        runId: input.runId,
        environment: input.environment,
        workspaceProvider: input.workspaceProvider,
      },
      {
        sourceRootKind: input.sourceRootKind,
        requestedModel: input.requestedModel,
        resolvedModel: input.resolvedModel,
      },
    );
    const decision = await input.controller.decide(
      {
        runId: input.runId,
        runState: state,
        task: {
          initialInput: input.taskCase.initialInput,
          baseline: input.taskCase.baseline,
          privacy: input.taskCase.privacy,
          historicalUserTurns: historicalUserFollowups(input.taskCase.transcript, input.taskCase.initialInput.id),
        },
        current: {
          summary: observation.currentSummary,
          evidenceRefs: observation.evidenceRefs,
        },
        trajectory: {
          summary: observation.trajectorySummary,
          evidenceRefs: observation.evidenceRefs,
        },
        budget: {
          decisionsUsed: controllerCalls,
          decisionsLimit: input.policy.maxModelCalls,
        },
        replay: {
          sourceRootKind: input.sourceRootKind,
          isolation: "Writes stay in the isolated replica and never land in the original user directory.",
          requestedModel: input.requestedModel,
          resolvedModel: input.resolvedModel,
          changedPaths: observation.changedPaths,
        },
      },
      observationTools(input.store, {
        runId: input.runId,
        transcript: input.taskCase.transcript,
        allowModelText: input.taskCase.privacy.allowModelText,
      }),
    );
    controllerCalls += 1;
    decisions.push(decision);
    await input.store.append({
      type: "controller.decision",
      runId: input.runId,
      operationId: `controller-decision-${controllerCalls}`,
      payload: invocationFact(decision),
    });
    if (decision.status !== "completed") {
      state =
        decision.status === "failed"
          ? await input.run.failController({
              code: decision.failure.code,
              message: decision.failure.message,
            })
          : decision.status === "cancelled"
            ? await input.run.cancel()
            : await input.run.stopByHarness("stalled.no_progress");
      break;
    }
    if (decision.value.type === "done") {
      state = await input.run.settleController(decision.value.reason);
      break;
    }
    const previous = decisions.at(-2);
    duplicateInputs =
      isCompleted(previous) &&
      previous.value.type === "send" &&
      previous.value.message === decision.value.message
        ? duplicateInputs + 1
        : 0;
    if (duplicateInputs >= input.policy.maxConsecutiveNoProgress) {
      state = await input.run.stopByHarness("stalled.no_progress");
      break;
    }
    followupSubmission = true;
    state = await input.run.submit(
      {
        id: `controller-${input.runId}-${controllerCalls}`,
        text: decision.value.message,
      },
      {
        runId: input.runId,
        turnIndex: controllerCalls,
        clientMessageId: `controller-${controllerCalls}-${input.runId}`,
      },
    );
  }
  if (state !== "finished")
    throw new Error(`Candidate did not reach a terminal state: ${state}.`);
  const last = decisions.at(-1);
  if (!last)
    return {
      decision: {
        status: "failed",
        failure: {
          code: "agent_failure",
          message: "Controller produced no decision.",
          attempts: controllerCalls,
        },
      },
      followupSubmission,
    };
  return { decision: last, followupSubmission };
}

function recoveryClues(taskCase: TaskCase): {
  cwd?: string;
  historicalCommit?: string;
  sourceVersion?: string;
} {
  const context = taskCase.taskContext ?? {};
  const string = (value: unknown): string | undefined =>
    typeof value === "string" && value.length ? value : undefined;
  const cwd = string(context.cwd);
  const historicalCommit = string(context.historicalCommit);
  const sourceVersion = string(context.sourceVersion);
  return {
    ...(cwd ? { cwd } : {}),
    ...(historicalCommit ? { historicalCommit } : {}),
    ...(sourceVersion ? { sourceVersion } : {}),
  };
}

async function ensureTaskCase(path: string, taskCase: TaskCase): Promise<void> {
  try {
    const persisted = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<TaskCase>;
    if (
      persisted.caseId !== taskCase.caseId ||
      persisted.contentHash !== taskCase.contentHash
    )
      throw new Error(
        `TaskCase ${taskCase.caseId} conflicts with existing immutable content.`,
      );
  } catch (error) {
    if (isMissing(error)) await writeImmutableJson(path, taskCase);
    else throw error;
  }
}
