import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ControllerReadArtifactSchema, ControllerShellArtifactSchema } from "../core/schema.js";
import type {
  ComparisonAgentPort,
  ComparisonResult,
} from "../agents/comparison-agent.js";
import {
  type ControllerDecision,
  type ControllerPort,
  type SteeringContext,
} from "../agents/controller-agent.js";
import { rewindIsolatedWorkspaceToStart } from "./session-start-workspace.js";
import { CandidateRun } from "./candidate-run.js";
import {
  appendSentUserMessage,
  assertBriefingOutsideReplica,
  CONTROLLER_PROJECT_MOUNT,
  controllerBriefingRoot,
  readControllerPendingActions,
  controllerPromptContent,
  controllerRequestSnapshot,
  applyControllerUnderstandingDelta,
  writeControllerUnderstanding,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
} from "./controller-briefing.js";
import { controllerReadEvidenceOnRequest, observationReadRecord } from "./controller-request.js";
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
import { recoveryTools } from "../infrastructure/recovery-tools.js";
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
import { assertIds, assertPaths, experimentAgentAuditSink, invocationFact, persistTaskCase } from "./experiment-helpers.js";
import {
  captureWorkspaceScope,
  inspectRun,
  unstartedControllerObservation,
  type ControllerObservation,
} from "./experiment-inspection.js";
import {
  preflightFromBaseline,
  resolveVerifiedCandidate,
} from "./experiment-preflight.js";
import { finishExperiment, attachExperimentComparison } from "./experiment-report.js";
export { controllerRequestSnapshot } from "./controller-briefing.js";
export type { SourceRootKind };
export { preflightCodexExperiment } from "./experiment-preflight.js";
export { recoverCodexExperiment, classifyRecoveryFailureStage } from "./experiment-recovery.js";
export type { RecoveryAttempt, RecoveryAttemptMode, RecoveryAttemptInput } from "./experiment-recovery.js";
export type ExperimentAgentConfig = {
  providerId: string;
  requestedModel: string;
  budget: { callTimeoutMs: number; maxStructuredRepairAttempts: number; maxCalls?: number };
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
  /** When true, Comparison runs before this handle's result settles. Default is skip. */
  compare?: boolean;
  /** Hold the isolated workspace until runComparison or skipComparison. */
  deferComparison?: boolean;
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
  candidateFinished: Promise<CodexExperimentResult>;
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
  waitForComparison(partial: CodexExperimentResult): Promise<boolean>;
};
/**
 * The publishing-level Codex experiment path. It has one CandidateRun state
 * machine and leaves all reviewable facts under a fresh experiment directory.
 */
export function startCodexExperiment(
  input: CodexExperimentInput,
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
  let resolveCandidate: ((result: CodexExperimentResult) => void) | undefined;
  const deferredCandidate = input.deferComparison
    ? new Promise<CodexExperimentResult>((resolve) => {
        resolveCandidate = resolve;
      })
    : undefined;
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
  });
  return {
    result,
    candidateFinished: deferredCandidate ?? result,
    async runComparison(): Promise<void> {
      decideComparison?.(true);
    },
    async skipComparison(): Promise<void> {
      decideComparison?.(false);
    },
    async cancel(): Promise<void> {
      cancelRequested = true;
      abort.abort();
      decideComparison?.(false);
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
  control: ExperimentControl;
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
    compare: false as const,
  };
  const partial = await finishExperiment(finishInput);
  if (!(await control.waitForComparison(partial))) return partial;
  return attachExperimentComparison({ ...finishInput, compare: true }, partial.record);
}
async function executeExperiment(
  input: CodexExperimentInput,
  control: ExperimentControl,
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
  const understandingFailure = await prepareControllerUnderstanding(input);
  if (understandingFailure) {
    const state = await abortOpening(input, understandingFailure);
    return finalizeControllerLoop(state, [understandingFailure], 0, false);
  }
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
}
async function prepareControllerUnderstanding(input: LoopInput): Promise<StructuredAgentResult<ControllerDecision> | undefined> {
  if (!input.controller.understand) return;
  const briefingRoot = controllerBriefingRoot(input.experimentRoot, input.runId);
  assertBriefingOutsideReplica(briefingRoot, input.environment.root);
  const packed = await packControllerBriefing(input, "opening", briefingRoot);
  const context = steeringContextFrom(input, "created", 0, "opening", packed);
  const understanding = await input.controller.understand(context, controllerDecisionTools(input, briefingRoot, context.requestId), experimentAgentAuditSink(input.store, input.runId));
  await input.store.append({ type: "controller.understanding", runId: input.runId, operationId: `${context.requestId}-understanding`, payload: invocationFact(understanding) });
  if (understanding.status !== "completed") return understanding;
  await writeControllerUnderstanding(briefingRoot, understanding.value);
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
  if (decision.value.understandingDelta) {
    await applyControllerUnderstandingDelta(
      controllerBriefingRoot(input.experimentRoot, input.runId),
      decision.value.understandingDelta,
    );
    await input.store.append({
      type: "controller.understanding_updated",
      runId: input.runId,
      operationId: `controller-understanding-${calls}`,
      payload: { turnIndex: calls, mode: decision.value.understandingDelta.mode, path: "controller-understanding.json" },
    });
  }
  if (decision.value.type === "done") {
    const pending = await readControllerPendingActions(controllerBriefingRoot(input.experimentRoot, input.runId), typeof input.controller.understand === 'function');
    const requestId = `controller-request-${input.runId}-${calls}`;
    const events = input.store.events(input.runId);
    const evidenceRefs = events.filter((event) => controllerReadEvidenceOnRequest([event], input.runId, requestId)).map((event) => `event:${event.eventId}`);
    const readEvidence = evidenceRefs.length > 0;
    const lastSubmission = events.filter((event) => event.type === "input.submitted").at(-1)?.sequence ?? 0;
    const rejects = events.filter((event) => event.sequence > lastSubmission && event.type === "controller.done_rejected");
    if (decision.value.reason === "satisfied" && pending !== undefined && (pending.length > 0 || !readEvidence)) {
      const firstReject = rejects[0];
      const exhausted = rejects.length >= 2 || (firstReject !== undefined && Date.now() - Date.parse(firstReject.occurredAt) >= 180_000);
      const payload = { requestId, reason: pending.length ? "unresolved_actions" : "evidence_required", unresolvedActions: pending, decision: decision.value, evidenceRefs, correctionAttempts: rejects.length, exhausted };
      await input.store.append({ type: exhausted ? "controller.completion_diagnostic" : "controller.done_rejected", runId: input.runId, operationId: `controller-completion-${calls}`, payload });
      return { state: exhausted ? await input.run.stopByHarness("stalled.controller_completion_guard") : state, controllerCalls: calls, followupSubmission: false, stop: exhausted };
    }
    await input.store.append({
      type: "controller.completion_diagnostic",
      runId: input.runId,
      operationId: `controller-diagnostic-${calls}`,
      payload: { requestId, decision: decision.value, unresolvedActions: pending ?? [], evidenceRefs, correctionAttempts: rejects.length, accepted: true, reads: evidenceRefs.length, evidenceStatus: readEvidence ? "read" : "not_read", advisory: true },
    });
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
  const base = steeringContextFrom(input, state, controllerCalls, phase, packed);
  const events = input.store.events(input.runId);
  const lastSubmission = events.filter((event) => event.type === "input.submitted").at(-1)?.sequence ?? 0;
  const rejections = events.filter((event) => event.type === "controller.done_rejected" && event.sequence > lastSubmission);
  const feedback = rejections.at(-1);
  const context = feedback ? { ...base, budget: { ...base.budget, callTimeoutMs: Math.max(1, 180_000 - (Date.now() - Date.parse(rejections[0]!.occurredAt))) }, promptContent: `${base.promptContent}\n\n# Host completion feedback\n${JSON.stringify(feedback.payload)}\nReconcile the ledger using replace and inspect current results. This is not a new candidate task. Return a corrected decision.` } : base;
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
  const written = await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: Math.max(1, inspection.turns),
    visibleText: inspection.finalMessage ?? "",
    events: eventsForLatestTurn(input.store.events(input.runId)),
    changedPaths: inspection.changedPaths,
    allowModelText: input.taskCase.privacy.allowModelText,
  });
  return { observation: inspection, ...written, briefingRoot };
}
function eventsForLatestTurn(events: readonly EventEnvelope[]): EventEnvelope[] {
  const settled = events.filter((event) => event.type === "runtime.turn_settled");
  const last = settled.at(-1);
  const previous = settled.at(-2);
  const start = previous?.sequence ?? 0;
  const end = last?.sequence ?? Number.POSITIVE_INFINITY;
  return events.filter((event) => event.sequence > start && event.sequence <= end);
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
    }).map((tool) => tool.name !== "read" && tool.name !== "shell_exec" ? tool : { ...tool, onCompleted: async (result: import("../infrastructure/pi-agent-host.js").AgentToolResult) => {
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

