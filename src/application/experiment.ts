import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ComparisonAgentPort,
  ComparisonResult,
} from "../agents/comparison-agent.js";
import {
  historicalUserFollowups,
  type ControllerDecision,
  type ControllerPort,
  type SteeringContext,
} from "../agents/controller-agent.js";
import { rewindIsolatedWorkspaceToStart } from "./session-start-workspace.js";
import { CandidateRun } from "./candidate-run.js";
import { currentRunEventRefs, observationReadRecord } from "./controller-request.js";
import { sha256 } from "../core/identity.js";
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
  type RecoveryCheckpoint,
} from "../environment/local-workspace-provider.js";
import type { ContaminationSignals } from "../environment/contamination.js";
import { observationTools } from "../infrastructure/agent-tools.js";
import type { StructuredAgentResult } from "../infrastructure/pi-agent-host.js";
import {
  ExperimentStore,
  writeImmutableJson,
} from "../infrastructure/store/experiment-store.js";
import { findProductPack } from "../products/index.js";
import type { ProductPack } from "../products/contract.js";
import {
  historicalCwdOf,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import {
  assertIds,
  assertPaths,
  invocationFact,
  isCompleted,
  persistTaskCase,
} from "./experiment-helpers.js";
import { captureWorkspaceScope, inspectRun } from "./experiment-inspection.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import { finishExperiment } from "./experiment-report.js";


export type { SourceRootKind };
export { preflightCodexExperiment } from "./experiment-preflight.js";
export { recoverCodexExperiment, classifyRecoveryFailureStage } from "./experiment-recovery.js";
export type { RecoveryAttempt, RecoveryAttemptMode, RecoveryAttemptInput } from "./experiment-recovery.js";

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
  checkpoint?: RecoveryCheckpoint;
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

async function captureCodexExperimentContext(
  input: CodexExperimentInput,
  control: { cancelled(): boolean },
) {
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
  const sourceRootKind = inferSourceRootKind({
    sourceRoot: resolve(input.sourceRoot),
    ...(historicalCwd ? { historicalCwd } : {}),
    ...(input.sourceRootKind ? { explicit: input.sourceRootKind } : {}),
  });
  await mkdir(experimentRoot, { recursive: true });
  const preflight = preflightFromBaseline(baseline, resolved);
  await persistTaskCase(
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
  const checkpoint = baseline.recovery
    ? undefined
    : await provider.captureRecoveryCheckpoint({
        caseId: input.caseId,
        sourceRoot: resolve(input.sourceRoot),
      });
  return {
    experimentRoot,
    startedAt,
    provider,
    resolved,
    baseline,
    taskCase,
    historicalCwd,
    sourceRootKind,
    preflight,
    checkpoint,
  };
}

async function openCodexExperimentSession(input: {
  input: CodexExperimentInput;
  experimentRoot: string;
  provider: LocalWorkspaceProvider;
  resolved: Awaited<ReturnType<typeof resolveVerifiedCandidate>>;
  baseline: EnvironmentBaseline;
  taskCase: TaskCase;
  historicalCwd: string | undefined;
  sourceRootKind: SourceRootKind;
}) {
  const { input: experiment, experimentRoot, provider, resolved, baseline, taskCase, historicalCwd } = input;
  let sourceRootKind = input.sourceRootKind;
  const comparisonAgentConfig = experiment.comparisonAgentConfig ?? experiment.agentConfig;
  const spec = {
    experimentId: experiment.experimentId,
    taskCaseId: experiment.caseId,
    candidates: [experiment.candidate],
    controller: experiment.agentConfig,
    comparison: comparisonAgentConfig,
    runPolicy: experiment.policy,
    outputRoot: experimentRoot,
  };
  await writeImmutableJson(join(experimentRoot, "experiment.json"), {
    spec,
    runIds: [experiment.runId],
  });
  let environment = await provider.prepareRun(baseline, experiment.runId);
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
    runId: experiment.runId,
    experimentId: experiment.experimentId,
    caseId: experiment.caseId,
    candidate: experiment.candidate,
    policy: experiment.policy,
    createdAt: experiment.now,
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
    controller: experiment.agentConfig,
    comparison: comparisonAgentConfig,
    startedAt: experiment.now,
  };
  const store = await ExperimentStore.open(experimentRoot, experiment.experimentId);
  const unsubscribe = experiment.onEvent ? store.subscribe(experiment.onEvent) : undefined;
  const lifetime = { released: false };
  const release = async () => {
    lifetime.released = true;
    return provider.release(environment);
  };
  return {
    sourceRootKind,
    environment,
    attempt,
    manifest,
    store,
    unsubscribe,
    lifetime,
    release,
    targetEvents: [] as string[],
  };
}

async function startCodexCandidateRun(args: {
  input: CodexExperimentInput;
  store: ExperimentStore;
  checkpoint: Awaited<ReturnType<typeof captureCodexExperimentContext>>["checkpoint"];
  resolved: Awaited<ReturnType<typeof captureCodexExperimentContext>>["resolved"];
  environment: PreparedEnvironmentRef;
  provider: LocalWorkspaceProvider;
  attempt: RunManifest["attempt"];
  manifest: RunManifest;
  release: () => Promise<{ status: "released" | "already_released" }>;
  targetEvents: string[];
}): Promise<CandidateRun> {
  const { input, store, checkpoint, resolved, environment, provider, attempt, manifest, release, targetEvents } = args;
  await store.acquireWriter();
  if (checkpoint) {
    await store.append({
      type: "recovery.checkpoint_captured",
      runId: input.runId,
      operationId: `${checkpoint.checkpointId}-captured`,
      payload: {
        checkpointId: checkpoint.checkpointId,
        digest: checkpoint.fingerprint.digest,
        resourceCount: checkpoint.fingerprint.resources.length,
      },
    });
  }
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
  const runner = await input.runtime.createRunner(resolved, environment, sink);
  return new CandidateRun({
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
}

async function finishCodexCandidateRun(args: {
  input: CodexExperimentInput;
  control: {
    setActive(run: ActiveRun): void;
    setController(controller: ControllerPort, runId: string): void;
    cancelled(): boolean;
  };
  run: CandidateRun;
  store: ExperimentStore;
  taskCase: TaskCase;
  preflight: CodexExperimentPreflight;
  experimentRoot: string;
  targetEvents: string[];
  startedAt: number;
  sourceRootKind: SourceRootKind;
  environment: PreparedEnvironmentRef;
  provider: LocalWorkspaceProvider;
  resolved: Awaited<ReturnType<typeof captureCodexExperimentContext>>["resolved"];
}): Promise<CodexExperimentResult> {
  const { input, control, run, store, taskCase, preflight, experimentRoot, targetEvents, startedAt, sourceRootKind, environment, provider, resolved } = args;
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
}

async function executeExperiment(
  input: CodexExperimentInput,
  control: {
    setActive(run: ActiveRun): void;
    setController(controller: ControllerPort, runId: string): void;
    cancelled(): boolean;
  },
): Promise<CodexExperimentResult> {
  const {
    experimentRoot,
    startedAt,
    provider,
    resolved,
    baseline,
    taskCase,
    historicalCwd,
    sourceRootKind: initialSourceRootKind,
    preflight,
    checkpoint,
  } = await captureCodexExperimentContext(input, control);
  let sourceRootKind = initialSourceRootKind;
  const session = await openCodexExperimentSession({
    input,
    experimentRoot,
    provider,
    resolved,
    baseline,
    taskCase,
    historicalCwd,
    sourceRootKind,
  });
  sourceRootKind = session.sourceRootKind;
  const {
    environment,
    attempt,
    manifest,
    store,
    unsubscribe,
    lifetime,
    release,
    targetEvents,
  } = session;
  let run: CandidateRun | undefined;
  try {
    run = await startCodexCandidateRun({
      input,
      store,
      checkpoint,
      resolved,
      environment,
      provider,
      attempt,
      manifest,
      release: async () => {
        await release();
        return { status: "released" as const };
      },
      targetEvents,
    });
    return await finishCodexCandidateRun({
      input,
      control,
      run,
      store,
      taskCase,
      preflight,
      experimentRoot,
      targetEvents,
      startedAt,
      sourceRootKind,
      environment,
      provider,
      resolved,
    });
  } catch (error) {
    if (run?.states().at(-1) === "awaiting_controller") await run.cancel();
    throw error;
  } finally {
    unsubscribe?.();
    if (!lifetime.released) await release();
    await store.close();
  }
}

export function controllerRequestSnapshot(context: SteeringContext): Record<string, unknown> {
  return {
    schemaVersion: 1,
    toolSetVersion: 1,
    requestId: context.requestId,
    runId: context.runId,
    runState: context.runState,
    current: context.current,
    trajectory: context.trajectory,
    evidenceCatalog: context.evidenceCatalog,
    budget: context.budget,
    ...(context.replay ? { replay: context.replay } : {}),
  };
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
    const decision = await requestControllerDecision(input, state, controllerCalls);
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
  return finalizeControllerLoop(state, decisions, controllerCalls, followupSubmission);
}

function finalizeControllerLoop(
  state: SteeringContext["runState"],
  decisions: StructuredAgentResult<ControllerDecision>[],
  controllerCalls: number,
  followupSubmission: boolean,
): {
  decision: StructuredAgentResult<ControllerDecision>;
  followupSubmission: boolean;
} {
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

async function requestControllerDecision(
  input: Parameters<typeof runControllerLoop>[0],
  state: SteeringContext["runState"],
  controllerCalls: number,
) {
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
  const requestId = `controller-request-${input.runId}-${controllerCalls + 1}`;
  const context = {
    requestId,
    runId: input.runId,
    runState: state,
    task: {
      initialInput: input.taskCase.initialInput,
      baseline: input.taskCase.baseline,
      privacy: input.taskCase.privacy,
      historicalUserTurns: historicalUserFollowups(
        input.taskCase.transcript,
        input.taskCase.initialInput.id,
      ),
    },
    current: {
      summary: observation.currentSummary,
      evidenceRefs: observation.evidenceRefs,
    },
    evidenceCatalog: observation.evidenceRefs.map((ref) => ({ ref, runId: input.runId, source: "initial" as const })),
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
      isolation:
        "Writes stay in the isolated replica and never land in the original user directory.",
      requestedModel: input.requestedModel,
      resolvedModel: input.resolvedModel,
      changedPaths: observation.changedPaths,
    },
  };
  await input.store.append({
    type: "controller.requested",
    runId: input.runId,
    operationId: requestId,
    payload: {
      schemaVersion: 1,
      toolSetVersion: 1,
      requestId,
      runId: input.runId,
      inputDigest: sha256(JSON.stringify(controllerRequestSnapshot(context))),
      snapshot: controllerRequestSnapshot(context),
    },
  });
  const tools = observationTools(input.store, {
    runId: input.runId,
    transcript: input.taskCase.transcript,
    allowModelText: input.taskCase.privacy.allowModelText,
  }).map((tool) => ({
    ...tool,
    onCompleted: async (result: { content: string; details?: unknown }) => {
      await input.store.append(
        observationReadRecord({
          requestId,
          runId: input.runId,
          details: result.details,
          allowedRefs: currentRunEventRefs(input.store.events(input.runId), input.runId),
        }),
      );
    },
  }));
  return input.controller.decide(context, tools);
}

