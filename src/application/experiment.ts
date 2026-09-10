import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ControllerReadArtifactSchema, ControllerShellArtifactSchema } from "../core/schema.js";
import type { ComparisonAgentPort, ComparisonResult } from "../agents/comparison-agent.js";
import { type ControllerDecision, type ControllerPort, type SteeringContext } from "../agents/controller-agent.js";
import { materializeIsolatedStart } from "./session-start-workspace.js";
import { commitCandidateLaunchContext } from "./recovery/launch-context.js";
import { persistExperimentSpec, persistRunPreflight } from "./experiment-layout.js";
import { CandidateRun } from "./candidate-run.js";
import {
  appendSentUserMessage,
  assertBriefingOutsideReplica,
  CONTROLLER_PROJECT_MOUNT,
  controllerBriefingRoot,
  controllerPromptContent,
  controllerRequestSnapshot,
  controllerViewSurface,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
} from "./controller-briefing.js";
import { observationReadRecord } from "./controller-request.js";
import { assertCandidateRuntimeJournal, candidateRuntimeJournalPayload } from "./candidate-run-events.js";
import { sha256 } from "../core/identity.js";
import type { CandidateLaunchContext, CandidateSpec, EventEnvelope, RunManifest, RunPolicy, RunRecord, TaskCase } from "../core/schema.js";
import { isCandidateRuntimeJournalType, type ProductRuntime, type TargetEvent, type TargetEventSink } from "../core/runtime.js";
import {
  LocalWorkspaceProvider,
  type EnvironmentBaseline,
  type PreparedEnvironmentRef,
  type RecoveryCheckpoint,
} from "../environment/local-workspace-provider.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import type { ProductPack } from "../products/contract.js";
import {
  historicalCwdOf,
  inferSourceRootKind,
  type SourceRootKind,
} from "./replay-conditions.js";
import { assertIds, assertPaths, experimentAgentAuditSink, invocationFact, persistTaskCase, sourceDirectoryExists } from "./experiment-helpers.js";
import {
  captureWorkspaceScope,
  eventsForLatestSettledTurn,
  inspectRun,
  persistUserVisibleTurn,
  unstartedControllerObservation,
  type ControllerObservation,
} from "./controller-queries.js";
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
  const sink: TargetEventSink = {
    append: async (targetEvent: TargetEvent): Promise<void> => {
      if (!isCandidateRuntimeJournalType(targetEvent.type)) {
        throw new Error(`TargetRunner must emit CandidateRuntimeEvent types, not ${targetEvent.type}.`);
      }
      const event = await store.append({
        type: targetEvent.type,
        runId: input.runId,
        payload: candidateRuntimeJournalPayload(runnerRef.session().sessionId, targetEvent.payload),
        occurredAt: targetEvent.occurredAt,
      });
      assertCandidateRuntimeJournal(event);
      targetEvents.push(`event:${event.eventId}`);
    },
  };
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
  candidateProductId: string;
  experimentRoot: string;
  maxControllerCalls?: number;
}): Promise<{
  decision: StructuredAgentResult<ControllerDecision>;
  followupSubmission: boolean;
}> {
  const decisions: StructuredAgentResult<ControllerDecision>[] = [];
  const startedAt = Date.now();
  await input.store.append({
    type: "controller.started",
    runId: input.runId,
    operationId: "controller-started",
    payload: { model: input.controllerModel },
  });
  try {
    const opened = await deliverOpening(input, decisions);
    if (opened.finished) return opened.result;
    let state = opened.state;
    let controllerCalls = opened.controllerCalls;
    let followupSubmission = false;
    while (state === "awaiting_controller") {
      if (Date.now() - startedAt >= input.policy.wallClockMs) {
        state = await input.run.stopByHarness("limit.wall_clock");
        break;
      }
      if (input.maxControllerCalls !== undefined && controllerCalls >= input.maxControllerCalls) {
        state = await input.run.stopByHarness("limit.controller_calls");
        break;
      }
      const steered = await deliverSteering(input, state, decisions, controllerCalls);
      state = steered.state;
      controllerCalls = steered.controllerCalls;
      followupSubmission = steered.followupSubmission || followupSubmission;
      if (steered.stop) break;
    }
    return finalizeControllerLoop(state, decisions, controllerCalls, followupSubmission);
  } finally {
    input.controller.release?.(input.runId);
  }
}
type LoopInput = Parameters<typeof runControllerLoop>[0];
async function deliverOpening(
  input: LoopInput,
  decisions: StructuredAgentResult<ControllerDecision>[],
): Promise<
  | { finished: true; result: ReturnType<typeof finalizeControllerLoop> }
  | { finished: false; state: SteeringContext["runState"]; controllerCalls: number }
> {
  const opening = await requestControllerDecision(input, "created", 0, "opening");
  decisions.push(opening);
  await persistControllerDecision(input, 1, opening);
  if (opening.status !== "completed" || opening.value.type !== "send") {
    const state = await abortOpening(input, opening);
    return { finished: true, result: finalizeControllerLoop(state, decisions, 1, false) };
  }
  const state = await input.run.start(
    { id: `controller-${input.runId}-1`, text: opening.value.message },
    { runId: input.runId, turnIndex: 0, clientMessageId: `controller-1-${input.runId}` },
  );
  await appendSentUserMessage(controllerBriefingRoot(input.experimentRoot, input.runId), {
    id: `controller-${input.runId}-1`,
    text: opening.value.message,
  });
  return { finished: false, state, controllerCalls: 1 };
}
async function abortOpening(
  input: LoopInput,
  opening: StructuredAgentResult<ControllerDecision>,
): Promise<SteeringContext["runState"]> {
  if (opening.status === "cancelled") return input.run.cancel();
  if (opening.status === "failed") {
    return input.run.failBeforeStart({ code: opening.failure.code, message: opening.failure.message });
  }
  return input.run.failBeforeStart({ code: "invalid_output", message: "Opening decision must be send." });
}
async function deliverSteering(
  input: LoopInput,
  state: SteeringContext["runState"],
  decisions: StructuredAgentResult<ControllerDecision>[],
  controllerCalls: number,
): Promise<{
  state: SteeringContext["runState"];
  controllerCalls: number;
  followupSubmission: boolean;
  stop: boolean;
}> {
  const decision = await requestControllerDecision(input, state, controllerCalls, "steering");
  const calls = controllerCalls + 1;
  decisions.push(decision);
  await persistControllerDecision(input, calls, decision);
  if (decision.status !== "completed") {
    const next =
      decision.status === "failed"
        ? await input.run.failController({ code: decision.failure.code, message: decision.failure.message })
        : decision.status === "cancelled"
          ? await input.run.cancel()
          : await input.run.stopByHarness("stalled.no_progress");
    return { state: next, controllerCalls: calls, followupSubmission: false, stop: true };
  }
  if (decision.value.type === "done") {
    return {
      state: await input.run.settleController(decision.value.reason),
      controllerCalls: calls,
      followupSubmission: false,
      stop: true,
    };
  }
  const next = await input.run.submit(
    { id: `controller-${input.runId}-${calls}`, text: decision.value.message },
    { runId: input.runId, turnIndex: input.store.events(input.runId).filter((event) => event.type === "input.submitted").length, clientMessageId: `controller-${calls}-${input.runId}` },
  );
  await appendSentUserMessage(controllerBriefingRoot(input.experimentRoot, input.runId), {
    id: `controller-${input.runId}-${calls}`,
    text: decision.value.message,
  });
  return { state: next, controllerCalls: calls, followupSubmission: true, stop: false };
}

async function persistControllerDecision(
  input: { store: ExperimentStore; runId: string },
  controllerCalls: number,
  decision: StructuredAgentResult<ControllerDecision>,
): Promise<void> {
  await input.store.append({
    type: "controller.decision",
    runId: input.runId,
    operationId: `controller-decision-${controllerCalls}`,
    payload: invocationFact(decision),
  });
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
  input: LoopInput,
  state: SteeringContext["runState"],
  controllerCalls: number,
  phase: "opening" | "steering",
) {
  const briefingRoot = controllerBriefingRoot(input.experimentRoot, input.runId);
  assertBriefingOutsideReplica(briefingRoot, input.environment.root);
  const packed = await packControllerBriefing(input, phase, briefingRoot);
  const context = steeringContextFrom(input, state, controllerCalls, phase, packed);
  await persistControllerRequested(input, context);
  return input.controller.decide(
    context,
    controllerDecisionTools(input, briefingRoot, context.requestId, packed.observation.changedPaths),
    experimentAgentAuditSink(input.store, input.runId),
  );
}
async function packControllerBriefing(
  input: LoopInput,
  phase: "opening" | "steering",
  briefingRoot: string,
): Promise<{
  observation: Pick<ControllerObservation, "currentSummary" | "trajectorySummary" | "evidenceRefs" | "changedPaths">;
  indexMarkdown: string;
  fileDigests: Record<string, string>;
  briefingRoot: string;
}> {
  if (phase === "opening") {
    const historicalCwd = historicalCwdOf(input.taskCase);
    const written = await writeOpeningBriefing({
      briefingRoot,
      replicaRoot: input.environment.root,
      taskCase: input.taskCase,
      sourceRootKind: input.sourceRootKind,
      ...(historicalCwd ? { historicalCwd } : {}),
    });
    return { observation: unstartedControllerObservation(), ...written, briefingRoot };
  }
  const inspection = await inspectRun(
    input.store,
    undefined,
    input.taskCase.privacy.allowModelText,
    input.candidateProductId,
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
  const turnText = inspection.turnVisibleText ?? "";
  const written = await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: Math.max(1, inspection.turns),
    visibleText: turnText,
    events: eventsForLatestSettledTurn(input.store.events(input.runId)),
    changedPaths: inspection.changedPaths,
    allowModelText: input.taskCase.privacy.allowModelText,
    surface: controllerViewSurface(inspection.settlementStatus, turnText, input.taskCase.privacy.allowModelText),
    ...(inspection.turnPrompt ? { prompt: inspection.turnPrompt } : {}),
    ...(inspection.userView ? { userView: inspection.userView } : {}),
  });
  await persistUserVisibleTurn(input.store, input.runId, inspection.userView);
  return { observation: inspection, ...written, briefingRoot };
}
function steeringContextFrom(
  input: LoopInput,
  state: SteeringContext["runState"],
  controllerCalls: number,
  phase: "opening" | "steering",
  packed: {
    observation: Pick<ControllerObservation, "currentSummary" | "trajectorySummary" | "evidenceRefs" | "changedPaths">;
    indexMarkdown: string;
    fileDigests: Record<string, string>; briefingRoot: string;
  },
): SteeringContext {
  const historicalCwd = historicalCwdOf(input.taskCase);
  const observation = packed.observation;
  return {
    requestId: `controller-request-${input.runId}-${controllerCalls + 1}`,
    runId: input.runId,
    runState: state,
    phase, task: {
      initialInput: input.taskCase.initialInput,
      baseline: input.taskCase.baseline,
      privacy: input.taskCase.privacy,
      historicalUserTurns: [],
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
      ...(input.maxControllerCalls !== undefined ? { decisionsLimit: input.maxControllerCalls } : {}),
    },
    promptContent: controllerPromptContent({
      phase,
      briefingRoot: packed.briefingRoot,
      indexMarkdown: packed.indexMarkdown,
    }),
    briefingRoot: packed.briefingRoot,
    fileDigests: packed.fileDigests,
    replay: {
      sourceRootKind: input.sourceRootKind,
      isolation: "Writes stay in the isolated replica and never land in the original user directory.",
      requestedModel: input.requestedModel,
      resolvedModel: input.resolvedModel,
      changedPaths: observation.changedPaths,
      workspaceRoot: input.environment.root,
      ...(historicalCwd ? { historicalCwd } : {}),
    },
  };
}
async function persistControllerRequested(input: LoopInput, context: SteeringContext): Promise<void> {
  const snapshot = controllerRequestSnapshot(context);
  await input.store.append({
    type: "controller.requested",
    runId: input.runId,
    operationId: context.requestId,
    payload: {
      schemaVersion: 1,
      toolSetVersion: 1,
      requestId: context.requestId,
      runId: input.runId,
      inputDigest: sha256(JSON.stringify(snapshot)),
      snapshot,
    },
  });
}
function controllerDecisionTools(input: LoopInput, briefingRoot: string, requestId: string, changedPaths: readonly string[] = []) {
  return [
    ...recoveryTools(briefingRoot, {
      allowBinary: input.taskCase.privacy.allowBinary,
      homeRoot: join(input.experimentRoot, ".reprise-controller-home"),
      mounts: { [CONTROLLER_PROJECT_MOUNT]: input.environment.root },
      allowWrite: () => false,
      shellCwd: input.environment.root,
      denyDestructiveOnPrefix: [CONTROLLER_PROJECT_MOUNT],
    }).map((tool) => tool.name !== "read" && tool.name !== "shell_exec" ? tool : { ...tool, onCompleted: async (result: import("../infrastructure/agent/host.js").AgentToolResult) => {
      const details = result.details as { path?: string; available?: boolean; offset?: number; command?: string; cwd?: string; exitCode?: number; stdoutBytes?: number; stderrBytes?: number; truncated?: boolean } | undefined;
      const shell = tool.name === "shell_exec";
      let observation: unknown;
      if (shell) {
        observation = { schemaVersion: 1, command: details?.command, cwd: details?.cwd, exitCode: details?.exitCode, stdoutBytes: details?.stdoutBytes, stderrBytes: details?.stderrBytes, truncated: details?.truncated, content: result.content };
        if (!Value.Check(ControllerShellArtifactSchema, observation)) throw new Error("Controller shell artifact is malformed.");
      } else {
        if (!details?.available || !details.path || !result.content.length) return;
        const turns = input.store.events(input.runId).filter((event) => event.type === "runtime.turn_settled").length;
        const latest = `run/turns/${String(turns).padStart(4, "0")}/`;
        const changed = changedPaths.some((path) => details.path === `${CONTROLLER_PROJECT_MOUNT}/${path.replaceAll("\\", "/")}`);
        if (!turns || !(changed || (details.path.startsWith(latest) && /\/(visible\.txt|events\.jsonl)$/.test(details.path)))) return;
        observation = { path: details.path, offset: details.offset ?? 0, content: result.content, ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}) };
        if (!Value.Check(ControllerReadArtifactSchema, observation)) throw new Error("Controller read artifact is malformed.");
      }
      const bytes = Buffer.from(JSON.stringify(observation));
      const artifactId = `controller-${shell ? "shell" : "read"}-${sha256(bytes).slice(0, 32)}`;
      await input.store.commitArtifact({ artifactId, runId: input.runId, kind: "controller_observation", mediaType: "application/json", bytes });
      const evidenceRefs = [`artifact:${artifactId}`];
      result.details = { ...details, runId: input.runId, evidenceRefs };
      await input.store.append(observationReadRecord({ requestId, runId: input.runId, details: { runId: input.runId, source: shell ? "workspace_shell" : "workspace_read", evidenceRefs }, allowedRefs: new Set(evidenceRefs) }));
    } }),
  ];
}

