import { readTaskCase } from '../products/shared/task-case-reader.js';
import { join, resolve } from "node:path";
import { SAFE_ID } from "../core/identity.js";
import type { EventEnvelope, ExperimentSpec, RunRecord, TaskCase } from "../core/schema.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { LocalWorkspaceProvider } from "../environment/local-workspace-provider.js";
import { replicaWorkspaceLocation } from "./result-paths.js";
import { CliError } from "./cli-error.js";
import { readJsonFile } from "./experiment-history-list.js";
import { attachExperimentComparison } from "./experiment-report.js";
import { finishActivity, registerActivity, activityControlReady, type ExperimentActivity } from "./experiment-activity.js";
import { isPersistedExperimentMetadata, listPersistedRunIds, readRunPreflight, resolvedExperimentRoot } from "./experiment-layout.js";
import type { ExperimentInput, ExperimentResult, ExperimentAgentConfig } from "./experiment.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import type { ComparisonAgentPort } from "../agents/comparison-contract.js";
import type { ControllerPort } from "../agents/controller-agent.js";
import type { RunPolicy } from "../core/schema.js";
import type { HistoricalArtifactExtractFn } from "../products/shared/freeze.js";
import type { ProductRuntime } from "../core/runtime.js";
import { hasRunLifecycle, matchingRunRecord, readCommittedRunEvents } from "./experiment-run-history.js";
import { cleanupOperation, throwFailures, type CleanupFailure } from "./experiment-startup.js";
import { harnessConfigurationScope, type HarnessConfigurationScope } from './harness-configuration.js';
import type { newComparisonAttempt } from './comparison-briefing.js';
import { failComparisonOperation, reserveComparisonOperation } from './comparison-operation.js';
import type { ComparisonOperationFailure, HarnessConfigurationReference } from '../core/schema.js';
import { isRecord } from '../core/json.js';

export async function comparePersistedExperiment(input: {
  readonly dataDir: string;
  readonly experimentId: string;
  readonly runId?: string;
  readonly comparison?: ComparisonAgentPort;
  readonly agentConfig?: ExperimentAgentConfig;
  readonly resolveAgents?: (signal: AbortSignal, scope: HarnessConfigurationScope) => Promise<{ comparison: ComparisonAgentPort; agentConfig: ExperimentAgentConfig }>;
  readonly policy: RunPolicy;
  readonly now: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: EventEnvelope) => void;
  readonly onActivity?: (activity: ExperimentActivity) => void;
  readonly extractHistoricalArtifacts?: HistoricalArtifactExtractFn;
  readonly resolveExtractHistoricalArtifacts?: (productId: string) => HistoricalArtifactExtractFn | undefined;
}): Promise<ExperimentResult> {
  const experimentRoot = resolvedExperimentRoot(input.dataDir, input.experimentId);
  let loaded = await loadFinishedRun(experimentRoot, input.experimentId, input.runId);
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  let unsubscribe: (() => void) | undefined;
  const localAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, localAbort.signal]) : localAbort.signal;
  let comparison: ComparisonAgentPort | undefined;
  let comparisonAttemptId: string | undefined;
  let reserved: ReturnType<typeof newComparisonAttempt> | undefined;
  let effectiveReference: HarnessConfigurationReference | undefined;
  let stage: ComparisonOperationFailure['stage'] = 'activity';
  let activity: ExperimentActivity | undefined;
  let primaryError: { error: unknown } | undefined;
  try {
    await store.acquireWriter();
    loaded = await loadFinishedRun(experimentRoot, input.experimentId, input.runId);
    unsubscribe = input.onEvent ? store.subscribe(input.onEvent) : undefined;
    reserved = await reserveComparisonOperation(store, experimentRoot, loaded.record.attempt.runId);
    comparisonAttemptId = reserved.attemptId;
    activity = registerActivity({
    kind: "compare",
    experimentId: input.experimentId,
    runId: loaded.record.attempt.runId,
    dataDir: input.dataDir,
    cancel: async () => {
      localAbort.abort();
      if (comparison && comparisonAttemptId) await comparison.cancel(comparisonAttemptId);
    },
  });
    input.onActivity?.(activity);
    await activityControlReady(activity);
    stage = 'agents';
    const agents = input.comparison && input.agentConfig
      ? { comparison: input.comparison, agentConfig: input.agentConfig }
      : await resolveCompareAgents(input.resolveAgents, signal, harnessConfigurationScope(store,
        { experimentId: input.experimentId, runId: loaded.record.attempt.runId, operation: 'comparison', comparisonAttemptId: reserved.attemptId },
        reference => { effectiveReference = reference; }));
    comparison = agents.comparison;
    signal.throwIfAborted();
    stage = 'workspace';
    const workspaceLocation = replicaWorkspaceLocation(experimentRoot, loaded.record.attempt.runId,
      loaded.record.manifest?.environment.workspacePath ?? join(experimentRoot, 'environment', 'runs', loaded.record.attempt.runId));
    if (!workspaceLocation) throw new CliError("failed", "Recorded candidate workspace is outside the selected experiment.", input.experimentId);
    const provider = new LocalWorkspaceProvider(workspaceLocation.providerRoot);
    const snapshot = await provider.candidateSnapshot(loaded.record.attempt.runId);
    const extractHistoricalArtifacts = input.extractHistoricalArtifacts
      ?? input.resolveExtractHistoricalArtifacts?.(loaded.taskCase.source.productId);
    const finishInput = {
      signal,
      input: experimentInput({
        ...input,
        comparison: agents.comparison,
        agentConfig: agents.agentConfig,
        ...(extractHistoricalArtifacts ? { extractHistoricalArtifacts } : {}),
      }, loaded, experimentRoot),
      taskCase: loaded.taskCase,
      preflight: loaded.preflight,
      store,
      run: { result: () => ({ record: loaded.record }) },
      controller: { decision: { status: "completed" as const, sessionId: "persisted", value: { type: "done" as const, reason: "no_further_value" as const } }, followupSubmission: false },
      experimentRoot,
      targetEvents: [] as const,
      startedAt: Date.parse(loaded.record.attempt.createdAt) || Date.now(),
      sourceRootKind: "operator_selected" as const,
      workspaceRoot: workspaceLocation.workspaceRoot,
      candidateSnapshotRoot: snapshot.root,
      candidateSnapshotStatus: snapshot.status,
      compare: true as const,
      onComparisonAttempt: (attemptId: string) => { comparisonAttemptId = attemptId; },
      comparisonAttempt: reserved,
    };
    stage = 'comparison';
    return await attachExperimentComparison(finishInput as unknown as Parameters<typeof attachExperimentComparison>[0], loaded.record);
  } catch (error) {
    const failures: CleanupFailure[] = [];
    await cleanupOperation(failures, 'comparison_failure_audit', () => recordComparisonHostFailure({ store, reserved, stage, signal,
      experimentId: input.experimentId, runId: loaded.record.attempt.runId, effectiveReference }, error));
    const combined = failures.length ? new AggregateError([error, ...failures.map(item => item.error)], 'Comparison operation and failure audit failed.', { cause: error }) : error;
    primaryError = { error: combined };
    throw combined;
  } finally {
    unsubscribe?.();
    await closeComparisonResources(store, activity, primaryError);
  }
}

async function recordComparisonHostFailure(input: {
  store: ExperimentStore; reserved: ReturnType<typeof newComparisonAttempt> | undefined; experimentId: string; runId: string;
  stage: ComparisonOperationFailure['stage']; signal: AbortSignal; effectiveReference: HarnessConfigurationReference | undefined;
}, error: unknown): Promise<void> {
  const { store, reserved, experimentId, runId, stage, signal, effectiveReference } = input;
  if (!reserved || store.events(runId).some(event => event.type === 'comparison.completed'
    && isRecord(event.payload) && event.payload.attemptId === reserved.attemptId)) return;
  await failComparisonOperation(store, reserved.attemptRoot, { experimentId, runId, attemptId: reserved.attemptId,
    stage, status: signal.aborted ? 'cancelled' : 'failed', ...(effectiveReference ? { effectiveReference } : {}) }, error);
}

async function closeComparisonResources(store: ExperimentStore, activity: ExperimentActivity | undefined, primary?: { error: unknown }): Promise<void> {
  const failures: CleanupFailure[] = [];
  if (activity) await cleanupOperation(failures, "activity", () => finishActivity(activity));
  await cleanupOperation(failures, "store_close", () => store.close());
  if (failures.length) throwFailures([...(primary ? [primary.error] : []), ...failures.map(item => item.error)], "Persisted comparison cleanup failed.");
}

async function resolveCompareAgents(
  resolveAgents: ((signal: AbortSignal, scope: HarnessConfigurationScope) => Promise<{ comparison: ComparisonAgentPort; agentConfig: ExperimentAgentConfig }>) | undefined,
  signal: AbortSignal,
  scope: HarnessConfigurationScope,
): Promise<{ comparison: ComparisonAgentPort; agentConfig: ExperimentAgentConfig }> {
  if (!resolveAgents) throw new Error("Persisted comparison requires injected comparison agents.");
  return resolveAgents(signal, scope);
}

async function loadFinishedRun(experimentRoot: string, experimentId: string, requestedRunId?: string) {
  const metadata = await readJsonFile(join(experimentRoot, "experiment.json"));
  if (!isPersistedExperimentMetadata(metadata)) throw new CliError("not_found", `Unknown experiment '${experimentId}'.`, experimentId);
  const runIds = await listPersistedRunIds(experimentRoot, metadata);
  if (requestedRunId && !SAFE_ID.test(requestedRunId)) throw new CliError("usage", "runId is not a safe identifier.", requestedRunId);
  const selected = await selectFinishedRecord(experimentRoot, experimentId, metadata.spec.taskCaseId, requestedRunId ? [requestedRunId] : [...runIds].reverse(), Boolean(requestedRunId));
  const runId = selected?.attempt.runId;
  if (!runId || (requestedRunId && !runIds.includes(requestedRunId))) {
    throw new CliError("failed", `Experiment ${experimentId} has no finished run.`, experimentId);
  }
  const recordValue = selected;
  const taskCaseValue = await readTaskCase(join(resolve(experimentRoot, "..", ".."), "cases", metadata.spec.taskCaseId, "case.json"), { expectedCaseId: metadata.spec.taskCaseId, requireComplete: true });
  const preflightValue = await readRunPreflight(experimentRoot, runId);
  return {
    spec: metadata.spec,
    record: recordValue,
    taskCase: taskCaseValue,
    preflight: isPreflight(preflightValue) ? preflightValue : {
      sourceBaseline: "available",
      resolved: {
        productId: recordValue.attempt.candidate.productId,
        executable: "persisted",
        requestedModel: recordValue.attempt.candidate.requestedModel,
        resolvedModel: recordValue.manifest?.resolvedModel.resolved ?? recordValue.attempt.candidate.requestedModel,
      },
      limitations: [],
      comparisonClass: "observational",
    },
  };
}

async function selectFinishedRecord(root: string, experimentId: string, caseId: string, runIds: readonly string[], explicit: boolean): Promise<RunRecord | undefined> {
  const { events } = await readCommittedRunEvents(root);
  const records: RunRecord[] = [];
  for (const runId of runIds) {
    const value = await readJsonFile(join(root, "runs", runId, "record.json"));
    if (!matchingRunRecord(value, experimentId, runId, caseId, events)) continue;
    if (hasRunLifecycle(events, runId) || explicit) return value;
    records.push(value);
  }
  if (records.length < 2) return records[0];
  const times = records.map((record) => Date.parse(record.attempt.createdAt));
  const newest = Math.max(...times);
  if (times.some((time) => !Number.isFinite(time)) || times.filter((time) => time === newest).length !== 1) {
    throw new CliError("usage", "Legacy run order is unknown; specify runId explicitly.", experimentId);
  }
  return records[times.indexOf(newest)];
}

function isPreflight(value: unknown): value is ExperimentPreflight {
  return typeof value === "object" && value !== null && "sourceBaseline" in value && "resolved" in value;
}

function experimentInput(
  input: {
    dataDir: string;
    comparison: ComparisonAgentPort;
    agentConfig: ExperimentAgentConfig;
    policy: RunPolicy;
    now: string;
    onEvent?: (event: EventEnvelope) => void;
    extractHistoricalArtifacts?: HistoricalArtifactExtractFn;
  },
  loaded: { spec: ExperimentSpec; record: RunRecord; taskCase: TaskCase },
  experimentRoot: string,
): ExperimentInput {
  const candidate = loaded.record.attempt.candidate;
  const controller: ControllerPort = { decide: async () => ({ status: "cancelled" }) };
  return {
    dataDir: resolve(input.dataDir),
    caseId: loaded.taskCase.caseId,
    experimentId: loaded.spec.experimentId,
    runId: loaded.record.attempt.runId,
    sourceRoot: experimentRoot,
    taskCase: loaded.taskCase,
    candidate,
    policy: input.policy,
    agentConfig: input.agentConfig,
    runtime: unusedRuntime(),
    controller,
    comparison: input.comparison,
    now: input.now,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.extractHistoricalArtifacts
      ? { extractHistoricalArtifacts: input.extractHistoricalArtifacts }
      : {}),
    compare: true,
  };
}

function unusedRuntime(): ProductRuntime {
  const fail = async () => {
    throw new Error("Persisted comparison does not load a candidate Runtime.");
  };
  return {
    id: "persisted-comparison",
    inspectAvailable: fail,
    inspectAvailability: fail,
    resolve: fail,
    validateCandidate: fail,
    listCatalog: fail,
    recoveryCapabilities: () => ({
      sessionHistory: "unavailable",
      localArtifacts: false,
      workspaceHistory: false,
      externalSideEffects: "unobserved",
    }),
    createRunner: fail,
  };
}
