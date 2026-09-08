import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { SAFE_ID } from "../core/identity.js";
import { RunRecordSchema, TaskCaseSchema, type EventEnvelope, type ExperimentSpec, type RunRecord, type TaskCase } from "../core/schema.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { LocalWorkspaceProvider } from "../environment/local-workspace-provider.js";
import { CliError } from "./cli-error.js";
import { readJsonFile } from "./experiment-history-list.js";
import { attachExperimentComparison } from "./experiment-report.js";
import { finishExperimentActivity, registerActivity, activityControlReady } from "./experiment-activity.js";
import { isPersistedExperimentMetadata, listPersistedRunIds, readRunPreflight, resolvedExperimentRoot } from "./experiment-layout.js";
import type { CodexExperimentInput, CodexExperimentPreflight, CodexExperimentResult, ExperimentAgentConfig } from "./experiment.js";
import type { ComparisonAgentPort } from "../agents/comparison-agent.js";
import type { ControllerPort } from "../agents/controller-agent.js";
import type { RunPolicy } from "../core/schema.js";
import type { RuntimePort } from "../core/runtime.js";

export async function comparePersistedExperiment(input: {
  readonly dataDir: string;
  readonly experimentId: string;
  readonly runId?: string;
  readonly comparison: ComparisonAgentPort;
  readonly agentConfig: ExperimentAgentConfig;
  readonly policy: RunPolicy;
  readonly now: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: EventEnvelope) => void;
}): Promise<CodexExperimentResult> {
  const experimentRoot = resolvedExperimentRoot(input.dataDir, input.experimentId);
  const loaded = await loadFinishedRun(experimentRoot, input.experimentId, input.runId);
  const store = await ExperimentStore.open(experimentRoot, input.experimentId);
  const unsubscribe = input.onEvent ? store.subscribe(input.onEvent) : undefined;
  const localAbort = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, localAbort.signal]) : localAbort.signal;
  const activity = registerActivity({
    kind: "compare",
    experimentId: input.experimentId,
    runId: loaded.record.attempt.runId,
    dataDir: input.dataDir,
    cancel: async () => { localAbort.abort(); },
  });
  try {
    await activityControlReady(activity);
    await store.acquireWriter();
    const provider = new LocalWorkspaceProvider(join(experimentRoot, "environment"));
    const snapshot = await provider.candidateSnapshot(loaded.record.attempt.runId);
    const finishInput = {
      signal,
      input: experimentInput(input, loaded, experimentRoot),
      taskCase: loaded.taskCase,
      preflight: loaded.preflight,
      store,
      run: { result: () => ({ record: loaded.record }) },
      controller: { decision: { status: "completed" as const, sessionId: "persisted", value: { type: "done" as const, reason: "no_further_value" as const } }, followupSubmission: false },
      experimentRoot,
      targetEvents: [] as const,
      startedAt: Date.parse(loaded.record.attempt.createdAt) || Date.now(),
      sourceRootKind: "operator_selected" as const,
      workspaceRoot: join(experimentRoot, "environment", "runs", loaded.record.attempt.runId),
      candidateSnapshotRoot: snapshot.root,
      candidateSnapshotStatus: snapshot.status,
      compare: true as const,
    };
    return await attachExperimentComparison(finishInput as unknown as Parameters<typeof attachExperimentComparison>[0], loaded.record);
  } finally {
    unsubscribe?.();
    await store.close();
    finishExperimentActivity(input.experimentId);
  }
}

async function loadFinishedRun(experimentRoot: string, experimentId: string, requestedRunId?: string) {
  const metadata = await readJsonFile(join(experimentRoot, "experiment.json"));
  if (!isPersistedExperimentMetadata(metadata)) throw new CliError("not_found", `Unknown experiment '${experimentId}'.`, experimentId);
  const runIds = await listPersistedRunIds(experimentRoot, metadata);
  const runId = requestedRunId ?? runIds.at(-1);
  if (!runId || (requestedRunId && !runIds.includes(requestedRunId))) {
    throw new CliError("failed", `Experiment ${experimentId} has no finished run.`, experimentId);
  }
  if (requestedRunId && !SAFE_ID.test(requestedRunId)) throw new CliError("usage", "runId is not a safe identifier.", requestedRunId);
  const recordValue = await readJsonFile(join(experimentRoot, "runs", runId, "record.json"));
  if (!Value.Check(RunRecordSchema, recordValue)) throw new CliError("failed", `Experiment ${experimentId} is not a finished run.`, experimentId);
  const taskCaseValue = await readJsonFile(join(resolve(experimentRoot, "..", ".."), "cases", metadata.spec.taskCaseId, "case.json"));
  if (!Value.Check(TaskCaseSchema, taskCaseValue)) throw new CliError("not_found", `TaskCase ${metadata.spec.taskCaseId} was not found.`, metadata.spec.taskCaseId);
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

function isPreflight(value: unknown): value is CodexExperimentPreflight {
  return typeof value === "object" && value !== null && "sourceBaseline" in value && "resolved" in value;
}

function experimentInput(
  input: { dataDir: string; comparison: ComparisonAgentPort; agentConfig: ExperimentAgentConfig; policy: RunPolicy; now: string; onEvent?: (event: EventEnvelope) => void },
  loaded: { spec: ExperimentSpec; record: RunRecord; taskCase: TaskCase },
  experimentRoot: string,
): CodexExperimentInput {
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
    compare: true,
  };
}

function unusedRuntime(): RuntimePort {
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
