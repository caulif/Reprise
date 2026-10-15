import type { ArtifactRenderer } from '../infrastructure/artifact-renderer.js';
import { join, resolve } from "node:path";
import type { ComparisonAgentPort, ComparisonResult } from "../agents/comparison-contract.js";
import { type ControllerDecision, type ControllerPort } from "../agents/controller-agent.js";
import { materializeIsolatedStart } from "./session-start-workspace.js";
import { commitCandidateLaunchContext } from "./recovery/launch-context.js";
import { persistRunPreflight } from "./experiment-layout.js";
import { CandidateRun } from "./candidate-run.js";
import { createCandidateRuntimeSink } from "./candidate-run-events.js";
import { progressDigestFromFingerprint } from "./candidate-run-safety.js";
import type { CandidateLaunchContext, CandidateSpec, EventEnvelope, RunManifest, RunPolicy, RunRecord, TaskCase } from "../core/schema.js";
import type { AgentBudget, HarnessConfigurationReference } from '../core/schema.js';
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
import type { HistoricalArtifactExtractFn } from "../products/shared/freeze.js";
import {
  historicalCwdOf,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import { assertIds, assertPaths, sourceDirectoryExists } from "./experiment-helpers.js";
import { captureWorkspaceScope } from "./controller-queries.js";
import { runControllerLoop } from "./experiment-controller-loop.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import type { ResultPathLinks } from "./result-paths.js";
import { finishActivity, registerActivity, activityControlReady, type ExperimentActivity } from "./experiment-activity.js";
import { ExperimentStartup, cleanupOperation, throwFailures, type CleanupFailure } from './experiment-startup.js';
import { finishExperiment, attachExperimentComparison } from "./experiment-report.js";
export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: AgentBudget;
  effectiveReference?: HarnessConfigurationReference;
};
export type ExperimentResult = {
  taskCase: TaskCase;
  experimentRoot: string;
  reportPath: string;
  preflight: ExperimentPreflight;
  record: RunRecord;
  decision: StructuredAgentResult<ControllerDecision> | { status: 'not_reconstructed' };
  comparison: { result: StructuredAgentResult<ComparisonResult> | { status: "skipped" } };
  followupSubmission?: boolean;
  targetEvents: readonly string[];
  checkpoint?: RecoveryCheckpoint;
  facts: {
    elapsedMs: number;
    turns: number;
    controllerCalls: number;
    wallClockMs?: number;
    tokenCount?: number;
    costUsd?: number;
    comparisonActivity?: { modelRequests: number; toolCalls: number; compactions: number };
  };
  pathLinks?: ResultPathLinks;
};
export type ExperimentInput = {
  dataDir: string;
  caseId: string;
  experimentId: string;
  runId: string;
  sourceRoot: string;
  sourceRootKind?: SourceRootKind;
  taskCase: TaskCase;
  candidate: CandidateSpec;
  policy: RunPolicy;
  agentConfig: ExperimentAgentConfig;
  /** Comparison may use a different persisted Harness model. */
  comparisonAgentConfig?: ExperimentAgentConfig;
  runtime: ProductRuntime;
  pack?: ProductPack;
  activity?: ExperimentActivity;
  startup?: ExperimentStartup;
  environmentProvider?: LocalWorkspaceProvider;
  /** A previously validated Recovery preview selected by the operator. */
  preResolvedBaseline?: EnvironmentBaseline;
  /** Digest captured by preflight; prevents replaying a source that changed while the user reviewed it. */
  expectedSourceFingerprint?: string;
  controller: ControllerPort;
  comparison: ComparisonAgentPort;
  comparisonPreviewRenderer?: ArtifactRenderer;
  now: string;
  onEvent?: (event: EventEnvelope) => void;
  /** Optional Pack-bound historical deliverable extractor for old-case prepare. */
  extractHistoricalArtifacts?: HistoricalArtifactExtractFn;
  /** When true, Comparison runs before this handle's result settles. Default is skip. */
  compare?: boolean;
  /** Hold the isolated workspace until runComparison or skipComparison. */
  deferComparison?: boolean;
  /** Host must find frozen observations under this experiment before creating CandidateRun. */
  requireObservations?: boolean;
  signal?: AbortSignal;
  captureArtifacts?: (input: {
    signal: AbortSignal;
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
  activity?: ExperimentActivity | undefined;
  runComparison(): Promise<void>;
  skipComparison(): Promise<void>;
  cancel(): Promise<void>;
};
type ActiveRun = { cancel(source?: 'user' | 'supervisor' | 'budget'): Promise<unknown> };
type ExperimentControl = {
  signal: AbortSignal;
  setActive(run: ActiveRun): void;
  setController(controller: ControllerPort, runId: string): void;
  setComparisonAttempt(attemptId: string): void;
  cancelled(): boolean;
  cancellationSource(): 'user' | 'supervisor' | 'budget';
  waitForComparison(partial: ExperimentResult): Promise<boolean>;
  ready(): Promise<void>;
  finishActivity(): Promise<void>;
  cancellationFinished(): Promise<void>;
};
/**
 * The publishing-level experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startExperiment(
  input: ExperimentInput,
): ExperimentHandle {
  input = { ...input };
  const abort = new AbortController();
  let active: ActiveRun | undefined;
  let activeController: ControllerPort | undefined;
  let activeRunId: string | undefined;
  let comparisonAttemptId: string | undefined;
  let cancelRequested = false;
  let cancellation: Promise<void> | undefined;
  let cancellationSource: 'user' | 'supervisor' | 'budget' = 'user';
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
  const cancel = async (source: 'user' | 'supervisor' | 'budget' = 'user'): Promise<void> => {
    if (cancellation) return cancellation;
    cancellationSource = source;
    cancelRequested = true;
    cancellation = Promise.resolve().then(async () => {
      const failures: CleanupFailure[] = [];
      const stopping = active ? cleanupOperation(failures, 'candidate_cancel', () => active!.cancel(source)) : undefined;
      abort.abort(new DOMException('Experiment was cancelled.', 'AbortError'));
      decideComparison?.(false);
      await Promise.all([stopping,
        comparisonAttemptId ? cleanupOperation(failures, 'comparison_cancel', () => input.comparison.cancel(comparisonAttemptId!)) : undefined,
        activeController && activeRunId ? cleanupOperation(failures, 'controller_cancel', async () => activeController!.cancel?.(activeRunId!, `run:${activeRunId}:cancelled`)) : undefined]);
      throwFailures(failures.map(item => item.error), 'Experiment cancellation failed.');
    });
    return cancellation;
  };
  const externalAbort = () => {
    const reason: unknown = input.signal?.reason;
    return cancel(reason && typeof reason === 'object' && 'source' in reason && reason.source === 'user' ? 'user' : reason instanceof Error && reason.name === 'TimeoutError' ? 'budget' : 'supervisor');
  };
  const externalListener = () => { void externalAbort().catch(error => { process.emitWarning(`Experiment cancellation failed: ${error instanceof Error ? error.name : 'unknown'}`); }); };
  if (input.signal?.aborted) externalListener();
  else input.signal?.addEventListener('abort', externalListener, { once: true });
  let activity = input.activity;
  const result = executeExperiment(input, {
    signal: abort.signal,
    setActive(run) {
      active = run;
    },
    setController(controller, runId) {
      activeController = controller;
      activeRunId = runId;
    },
    setComparisonAttempt(attemptId) {
      comparisonAttemptId = attemptId;
    },
    cancelled() {
      return cancelRequested;
    },
    cancellationSource() { return cancellationSource; },
    async waitForComparison(partial) {
      resolveCandidate?.(partial);
      if (cancelRequested) return false;
      if (!comparisonDecision) return Boolean(input.compare);
      return comparisonDecision;
    },
    ready: async () => {
      activity ??= registerActivity({ kind: input.compare ? 'compare' : 'run', experimentId: input.experimentId,
        runId: input.runId, cancel, dataDir: input.dataDir });
      activity.cancel = cancel;
      await activityControlReady(activity);
    },
    finishActivity: async () => { if (activity) await finishActivity(activity); },
    cancellationFinished: () => cancellation ?? Promise.resolve(),
  }).finally(() => input.signal?.removeEventListener('abort', externalListener));
  const candidateFinished = deferredCandidate ? Promise.race([deferredCandidate, result]) : result;
  // Either handle promise may be ignored; observing this rejection leaves it available to awaiting callers.
  if (deferredCandidate) void candidateFinished.catch(() => undefined);
  const handle: ExperimentHandle = {
    result,
    candidateFinished,
    get activity() { return activity; },
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
  control: Pick<ExperimentControl, 'cancelled' | 'signal'>,
  startup: ExperimentStartup,
) {
  assertPaths(input.dataDir, input.sourceRoot);
  assertIds(input);
  if (
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
  startup.stage = 'runtime';
  const resolved = await resolveVerifiedCandidate(
    input.runtime,
    input.candidate,
  );
  control.signal.throwIfAborted();
  startup.stage = 'baseline';
  const baseline =
    input.preResolvedBaseline ??
    (await provider.resolveBaseline(
      { caseId: input.caseId, sourceRoot: resolve(input.sourceRoot) },
      [],
      {},
    ));
  control.signal.throwIfAborted();
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
  const taskCase = startup.taskCase;
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
  startup.stage = 'metadata';
  const preflight = preflightFromBaseline(baseline, resolved);
  await persistRunPreflight(experimentRoot, input.runId, preflight);
  if (preflight.sourceBaseline === "unavailable")
    throw new Error(
      "Candidate was not started because the source baseline is unavailable.",
    );
  if (control.cancelled())
    throw new Error("Experiment was cancelled before Candidate startup.");
  startup.stage = 'checkpoint';
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
  startup: ExperimentStartup;
  signal: AbortSignal;
  onPrepared(environment: PreparedEnvironmentRef): void;
}) {
  const { input: experiment, experimentRoot, provider, resolved, baseline, taskCase, historicalCwd } = input;
  let sourceRootKind = input.sourceRootKind;
  const comparisonAgentConfig = experiment.comparisonAgentConfig ?? experiment.agentConfig;
  input.startup.stage = 'prepare';
  let environment = await provider.prepareRun(baseline, experiment.runId);
  input.onPrepared(environment);
  input.signal.throwIfAborted();
  input.startup.stage = 'materialize';
  const prepared = await materializeIsolatedStart({
    workspaceRoot: environment.root,
    taskCase,
    ...(historicalCwd ? { historicalCwd } : {}),
    sourceRootKind,
  });
  input.signal.throwIfAborted();
  if (prepared.sourceRootKind === "historical_start") sourceRootKind = "historical_start";
  if (prepared.startMutated || prepared.imported.length) {
    environment = {
      ...environment,
      beforeFingerprint: await provider.fingerprint(environment),
    };
  }
  input.startup.stage = 'launch';
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
  const attempt = input.startup.attempt;
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
      executionIsolation: experiment.runtime.executionIsolation?.() ?? { hostPrivateReads: 'unknown', mechanism: 'undeclared' },
      ...(environment.gitSink ? { gitSink: environment.gitSink } : {}),
    },
    controller: resolvedAgentConfiguration(experiment.agentConfig),
    comparison: resolvedAgentConfiguration(comparisonAgentConfig),
    startedAt: experiment.now,
  };
  const store = input.startup.store;
  return {
    sourceRootKind,
    importedInputs: prepared.imported,
    environment,
    attempt,
    manifest,
    store,
    targetEvents: [] as string[],
    launch,
  };
}

function resolvedAgentConfiguration(config: ExperimentAgentConfig): RunManifest['controller'] {
  return { providerId: config.providerId, requestedModel: config.requestedModel,
    budget: { callTimeoutMs: config.budget.callTimeoutMs, maxStructuredRepairAttempts: config.budget.maxStructuredRepairAttempts,
      ...(config.budget.maxCalls === undefined ? {} : { maxCalls: config.budget.maxCalls }),
      ...(config.budget.comparisonResources ? { comparisonResources: config.budget.comparisonResources } : {}) },
    ...(config.effectiveReference ? { effectiveReference: config.effectiveReference } : {}) };
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
  taskCase: TaskCase;
}): Promise<CandidateRun> {
  const { input, store, checkpoint, resolved, environment, provider, attempt, manifest, release, targetEvents, launch } = args;
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
    ? (await store.listArtifacts(input.preResolvedBaseline.recovery.reportRunId)).find(
        (artifact) =>
          artifact.artifactId ===
          input.preResolvedBaseline?.recovery?.reportRef,
      )
    : undefined;
  const recoveryArtifactRef = recoveryArtifact
    ? {
        artifactId: recoveryArtifact.artifactId,
        experimentId: input.experimentId,
        ...(recoveryArtifact.owner.runId ? { runId: recoveryArtifact.owner.runId } : {}),
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
  try { return new CandidateRun({
    runner,
    policy: {
      turnTimeoutMs: input.policy.turnTimeoutMs,
      maxTargetTurns: input.policy.maxTargetTurns,
      maxModelCalls: input.policy.maxModelCalls,
      maxConsecutiveNoProgress: input.policy.maxConsecutiveNoProgress,
    },
    release,
    progressFingerprint: async () => progressDigestFromFingerprint(await provider.fingerprint(environment)),
    persistence: {
      journal: store,
      attempt,
      manifest,
      ...(recoveryArtifactRef ? { artifactRefs: [recoveryArtifactRef] } : {}),
      captureArtifacts: signal =>
        input.captureArtifacts
          ? input.captureArtifacts({
              signal,
              store,
              environment,
              workspaceProvider: provider,
              sourceRoot: resolve(input.sourceRoot),
              experimentId: input.experimentId,
              runId: input.runId,
            })
          : captureWorkspaceScope({
              signal,
              ...(args.taskCase.execution?.mode === 'task_completion' && args.taskCase.execution.snapshotRetainPaths ? { snapshotRetainPaths: args.taskCase.execution.snapshotRetainPaths } : {}),
              store,
              environment,
              workspaceProvider: provider,
              experimentId: input.experimentId,
              runId: input.runId,
            }),
    },
  }); } catch (error) {
    const cleanup: CleanupFailure[] = [];
    await cleanupOperation(cleanup, 'runner_close', () => runner.close());
    throwFailures([error, ...cleanup.map(item => item.error)], 'Candidate construction and Runner close failed.');
  }
}
async function finishCandidateRun(args: {
  importedInputs: Awaited<ReturnType<typeof materializeIsolatedStart>>['imported'];
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
  if (control.cancelled()) await run.cancel(control.cancellationSource());
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
        sourceRoot: resolve(input.sourceRoot),
        importedInputs: args.importedInputs,
        workspaceProvider: args.provider,
        sourceRootKind,
        requestedModel: input.candidate.requestedModel,
        resolvedModel: resolved.resolvedModel,
        candidateProductId: input.candidate.productId,
        ...(input.pack ? { candidatePack: input.pack } : {}),
        experimentRoot,
        dataDir: input.dataDir,
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
    onComparisonAttempt: (attemptId: string) => control.setComparisonAttempt(attemptId),
  };
  const partial = await finishExperiment(finishInput);
  if (!(await control.waitForComparison(partial))) return partial;
  return attachExperimentComparison({ ...finishInput, compare: true }, partial.record);
}
async function executeExperiment(
  input: ExperimentInput,
  control: ExperimentControl,
): Promise<ExperimentResult> {
  if (input.taskCase.caseId !== input.caseId) throw new Error('Experiment caseId must match TaskCase.caseId.');
  const startup = input.startup ?? await ExperimentStartup.admit(input);
  input = { ...input, taskCase: startup.taskCase, candidate: startup.attempt.candidate, policy: startup.attempt.policy };
  let acquired: { provider: LocalWorkspaceProvider; environment: PreparedEnvironmentRef } | undefined;
  let released: Promise<{ status: 'released' | 'already_released' }> | undefined;
  const release = () => released ??= acquired!.provider.release(acquired!.environment);
  let run: CandidateRun | undefined;
  let result: ExperimentResult | undefined;
  const failures: unknown[] = [];
  const cleanup: CleanupFailure[] = [];
  try {
    await control.ready();
    const context = await captureExperimentContext(input, control, startup);
    const session = await openExperimentSession({ input, ...context, startup, signal: control.signal,
      onPrepared(environment) { acquired = { provider: context.provider, environment }; } });
    const { environment, attempt, manifest, store, targetEvents, sourceRootKind } = session;
    const { provider, resolved, checkpoint, taskCase, preflight, experimentRoot, startedAt } = context;
    startup.stage = 'runner';
    run = await startCandidateRun({
      input,
      store,
      checkpoint,
      resolved,
      environment,
      provider,
      attempt,
      manifest,
      release,
      targetEvents,
      launch: session.launch,
      taskCase,
    });
    result = await finishCandidateRun({
      importedInputs: session.importedInputs,
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
    failures.push(error);
    if (run && !run.isStopping()) await cleanupOperation(cleanup, 'candidate_cancel', () => run!.cancel(control.cancellationSource()));
    await cleanupOperation(cleanup, 'controller_cancel', async () => input.controller.cancel?.(input.runId));
  }
  if (acquired && !released && !run?.isStopping()) await cleanupOperation(cleanup, 'environment', release);
  await cleanupOperation(cleanup, 'cancellation', () => control.cancellationFinished());
  await cleanupOperation(cleanup, 'activity', () => control.finishActivity());
  if (!run && failures.length) await cleanupOperation(cleanup, 'startup_audit', () => startup.fail(failures[0], control.cancelled(), cleanup, control.cancellationSource()));
  await startup.close(cleanup);
  throwFailures([...failures, ...cleanup.map(item => item.error)], 'Experiment and cleanup failed.');
  if (!result) throw new Error('Experiment finished without a result.');
  return result;
}
