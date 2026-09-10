import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ComparisonAgentPort, ComparisonResult } from "../agents/comparison-agent.js";
import { type ControllerDecision, type ControllerPort } from "../agents/controller-agent.js";
import { materializeIsolatedStart } from "./session-start-workspace.js";
import { commitCandidateLaunchContext } from "./recovery/launch-context.js";
import { persistExperimentSpec, persistRunPreflight } from "./experiment-layout.js";
import { CandidateRun } from "./candidate-run.js";
import { createCandidateRuntimeSink } from "./candidate-run-events.js";
import type { CandidateLaunchContext, CandidateSpec, EventEnvelope, RunManifest, RunPolicy, RunRecord, TaskCase } from "../core/schema.js";
import type { ProductRuntime } from "../core/runtime.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import {
  LocalWorkspaceProvider,
  type EnvironmentBaseline,
  type PreparedEnvironmentRef,
  type RecoveryCheckpoint,
} from "../environment/local-workspace-provider.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import type { ProductPack } from "../products/contract.js";
import {
  historicalCwdOf,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import { assertIds, assertPaths, persistTaskCase, sourceDirectoryExists } from "./experiment-helpers.js";
import { captureWorkspaceScope } from "./controller-queries.js";
import { runControllerLoop } from "./experiment-controller-loop.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import { finishExperimentActivity, registerActivity, activityControlReady, type ExperimentActivity } from "./experiment-activity.js";
import { finishExperiment, attachExperimentComparison } from "./experiment-report.js";
export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: { callTimeoutMs: number; maxStructuredRepairAttempts: number; maxCalls?: number };
};
export type ExperimentResult = {
  taskCase: TaskCase;
  experimentRoot: string;
  reportPath: string;
  preflight: ExperimentPreflight;
  record: RunRecord;
  decision: StructuredAgentResult<ControllerDecision>;
  comparison: { result: StructuredAgentResult<ComparisonResult> | { status: "skipped" } };
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
export type ExperimentInput = {
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
  runtime: ProductRuntime;
  pack?: ProductPack;
  activity?: ExperimentActivity;
  environmentProvider?: LocalWorkspaceProvider;
  /** A previously validated Recovery preview selected by the operator. */
  preResolvedBaseline?: EnvironmentBaseline;
  /** Digest captured by preflight; prevents replaying a source that changed while the user reviewed it. */
  expectedSourceFingerprint?: string;
  controller: ControllerPort;
  comparison: ComparisonAgentPort;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  /** When true, Comparison runs before this handle's result settles. Default is skip. */
  compare?: boolean;
  /** Hold the isolated workspace until runComparison or skipComparison. */
  deferComparison?: boolean;
  /** Host must find frozen observations under this experiment before creating CandidateRun. */
  requireObservations?: boolean;
  signal?: AbortSignal;
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
  result: Promise<ExperimentResult>;
  candidateFinished: Promise<ExperimentResult>;
  activity?: ExperimentActivity;
  runComparison(): Promise<void>;
  skipComparison(): Promise<void>;
  cancel(): Promise<void>;
};
type ActiveRun = { cancel(): Promise<unknown> };
type ExperimentControl = {
  signal: AbortSignal;
  setActive(run: ActiveRun): void;
  setController(controller: ControllerPort, runId: string): void;
  cancelled(): boolean;
  waitForComparison(partial: ExperimentResult): Promise<boolean>;
  ready(): Promise<void>;
};
/**
 * The publishing-level experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startExperiment(
  input: ExperimentInput,
): ExperimentHandle {
  const abort = new AbortController();
  let active: ActiveRun | undefined;
  let activeController: ControllerPort | undefined;
  let activeRunId: string | undefined;
  let cancelRequested = false;
  let decideComparison: ((run: boolean) => void) | undefined;
  const comparisonDecision = input.deferComparison
    ? new Promise<boolean>((resolve) => {
        decideComparison = resolve;
      })
    : undefined;
  let resolveCandidate: ((result: ExperimentResult) => void) | undefined;
  const deferredCandidate = input.deferComparison
    ? new Promise<ExperimentResult>((resolve) => {
        resolveCandidate = resolve;
      })
    : undefined;
  const cancel = async (): Promise<void> => {
    cancelRequested = true;
    abort.abort();
    decideComparison?.(false);
    await input.comparison.cancel?.();
    if (activeController && activeRunId)
      await activeController.cancel?.(
        activeRunId,
        `run:${activeRunId}:cancelled`,
      );
    if (active) await active.cancel();
  };
  if (input.signal?.aborted) void cancel();
  else input.signal?.addEventListener("abort", () => { void cancel(); }, { once: true });
  const activity = input.activity ?? registerActivity({
    kind: input.compare ? "compare" : "run",
    experimentId: input.experimentId,
    runId: input.runId,
    cancel,
    dataDir: input.dataDir,
  });
  if (input.activity) activity.cancel = cancel;
  const published = activityControlReady(activity);
  const result = executeExperiment(input, {
    signal: abort.signal,
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
    async waitForComparison(partial) {
      resolveCandidate?.(partial);
      if (cancelRequested) return false;
      if (!comparisonDecision) return Boolean(input.compare);
      return comparisonDecision;
    },
    ready: () => published,
  }).finally(() => finishExperimentActivity(input.experimentId));
  const handle: ExperimentHandle = {
    result,
    candidateFinished: deferredCandidate ?? result,
    activity,
    async runComparison(): Promise<void> {
      decideComparison?.(true);
    },
    async skipComparison(): Promise<void> {
      decideComparison?.(false);
    },
    cancel,
  };
  return handle;
}
async function captureExperimentContext(
  input: ExperimentInput,
  control: { cancelled(): boolean },
) {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
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
  await persistRunPreflight(experimentRoot, input.runId, preflight);
  if (preflight.sourceBaseline === "unavailable")
    throw new Error(
      "Candidate was not started because the source baseline is unavailable.",
    );
  if (control.cancelled())
    throw new Error("Experiment was cancelled before Candidate startup.");
  const checkpoint = baseline.recovery || !(await sourceDirectoryExists(resolve(input.sourceRoot)))
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
async function openExperimentSession(input: {
  input: ExperimentInput;
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
  await persistExperimentSpec(experimentRoot, spec);
  let environment = await provider.prepareRun(baseline, experiment.runId);
  const prepared = await materializeIsolatedStart({
    workspaceRoot: environment.root,
    taskCase,
    ...(historicalCwd ? { historicalCwd } : {}),
    sourceRootKind,
  });
  if (prepared.sourceRootKind === "historical_start") sourceRootKind = "historical_start";
  if (prepared.startMutated || prepared.imported.length) {
    environment = {
      ...environment,
      beforeFingerprint: await provider.fingerprint(environment),
    };
  }
  const launch = await commitCandidateLaunchContext({
    experimentRoot,
    experimentId: experiment.experimentId,
    runId: experiment.runId,
    workspaceRoot: environment.root,
    productId: resolved.productId,
    requestedModel: resolved.requestedModel,
    resolvedModel: resolved.resolvedModel,
    requireObservations: Boolean(experiment.requireObservations),
  });
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
    launch,
  };
}
async function startCandidateRun(args: {
  input: ExperimentInput;
  store: ExperimentStore;
  checkpoint: Awaited<ReturnType<typeof captureExperimentContext>>["checkpoint"];
  resolved: Awaited<ReturnType<typeof captureExperimentContext>>["resolved"];
  environment: PreparedEnvironmentRef;
  provider: LocalWorkspaceProvider;
  attempt: RunManifest["attempt"];
  manifest: RunManifest;
  release: () => Promise<{ status: "released" | "already_released" }>;
  targetEvents: string[];
  launch: CandidateLaunchContext;
}): Promise<CandidateRun> {
  const { input, store, checkpoint, resolved, environment, provider, attempt, manifest, release, targetEvents, launch } = args;
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
  const runnerRef: { session(): { sessionId: string } } = { session: () => ({ sessionId: "unstarted" }) };
  const sink = createCandidateRuntimeSink({
    journal: store,
    runId: input.runId,
    sessionId: () => runnerRef.session().sessionId,
    onCommitted: (event) => { targetEvents.push(`event:${event.eventId}`); },
  });
  const runner = await input.runtime.createRunner(resolved, environment, sink, launch);
  runnerRef.session = () => runner.session();
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
async function finishCandidateRun(args: {
  input: ExperimentInput;
  control: ExperimentControl;
  run: CandidateRun;
  store: ExperimentStore;
  taskCase: TaskCase;
  preflight: ExperimentPreflight;
  experimentRoot: string;
  targetEvents: string[];
  startedAt: number;
  sourceRootKind: SourceRootKind;
  environment: PreparedEnvironmentRef;
  provider: LocalWorkspaceProvider;
  resolved: Awaited<ReturnType<typeof captureExperimentContext>>["resolved"];
}): Promise<ExperimentResult> {
  const { input, control, run, store, taskCase, preflight, experimentRoot, targetEvents, startedAt, sourceRootKind, environment, resolved } = args;
  control.setActive(run);
  control.setController(input.controller, input.runId);
  if (control.cancelled()) await run.cancel();
  const controller = control.cancelled()
    ? {
        decision: {
          status: "cancelled" as const,
          factRef: `run:${input.runId}:cancelled`,
        },
        followupSubmission: false,
      }
    : await runControllerLoop({
        run,
        controller: input.controller,
        store,
        runId: input.runId,
        taskCase,
        policy: input.policy,
        controllerModel: input.agentConfig.requestedModel,
        environment,
        workspaceProvider: args.provider,
        sourceRootKind,
        requestedModel: input.candidate.requestedModel,
        resolvedModel: resolved.resolvedModel,
        candidateProductId: input.candidate.productId,
        experimentRoot,
        ...(input.agentConfig.budget.maxCalls !== undefined
          ? { maxControllerCalls: input.agentConfig.budget.maxCalls }
          : {}),
      });
  const snapshot = await args.provider.candidateSnapshot(input.runId);
  const finishInput = {
    signal: control.signal,
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
    workspaceRoot: environment.root,
    candidateSnapshotRoot: snapshot.root,
    candidateSnapshotStatus: snapshot.status,
    compare: false as const,
  };
  const partial = await finishExperiment(finishInput);
  if (!(await control.waitForComparison(partial))) return partial;
  return attachExperimentComparison({ ...finishInput, compare: true }, partial.record);
}
async function executeExperiment(
  input: ExperimentInput,
  control: ExperimentControl,
): Promise<ExperimentResult> {
  await control.ready();
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
  } = await captureExperimentContext(input, control);
  let sourceRootKind = initialSourceRootKind;
  const session = await openExperimentSession({
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
    run = await startCandidateRun({
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
      launch: session.launch,
    });
    return await finishCandidateRun({
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
    await input.controller.cancel?.(input.runId);
    throw error;
  } finally {
    unsubscribe?.();
    if (!lifetime.released) await release();
    await store.close();
  }
}
