import { type ControllerDecision, type ControllerPort, type SteeringContext } from "../agents/controller-agent.js";
import {
  appendSentUserMessage,
  assertBriefingOutsideReplica,
  controllerBriefingRoot,
  controllerPromptContent,
  controllerRequestSnapshot,
  controllerViewSurface,
  historicalRequirementRefs,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
} from "./controller-briefing.js";
import { controllerDecisionTools, createControllerToolBindings, type ControllerToolBindings } from "./controller-tools.js";
import { sha256 } from "../core/identity.js";
import type { RunPolicy, TaskCase } from "../core/schema.js";
import type { PreparedEnvironmentRef } from "../environment/local-workspace-provider.js";
import type { AgentToolDefinition, StructuredAgentResult } from "../infrastructure/agent/host.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { historicalCwdOf, type SourceRootKind } from "./replay-conditions.js";
import { experimentAgentAuditSink, invocationFact } from "./experiment-helpers.js";
import {
  eventsForLatestSettledTurn,
  inspectRun,
  persistUserVisibleTurn,
  recentToolErrorsFromEvents,
  unstartedControllerObservation,
  type ControllerObservation,
} from "./controller-queries.js";
import { CandidateRun } from "./candidate-run.js";

export async function runControllerLoop(input: {
  run: CandidateRun;
  controller: ControllerPort;
  store: ExperimentStore;
  runId: string;
  taskCase: TaskCase;
  policy: RunPolicy;
  controllerModel: string;
  environment: PreparedEnvironmentRef;
  workspaceProvider: import("../environment/local-workspace-provider.js").LocalWorkspaceProvider;
  sourceRootKind: SourceRootKind;
  requestedModel: string;
  resolvedModel: string;
  candidateProductId: string;
  experimentRoot: string;
  dataDir?: string;
  maxControllerCalls?: number;
}): Promise<{
  decision: StructuredAgentResult<ControllerDecision>;
  followupSubmission: boolean;
}> {
  const decisions: StructuredAgentResult<ControllerDecision>[] = [];
  const startedAt = Date.now();
  const briefingRoot = controllerBriefingRoot(input.experimentRoot, input.runId);
  const bindings = createControllerToolBindings();
  const historicalCwd = historicalCwdOf(input.taskCase);
  const tools = controllerDecisionTools(
    historicalCwd ? { ...input, sourceRoot: historicalCwd } : input,
    briefingRoot,
    bindings,
  );
  await input.store.append({
    type: "controller.started",
    runId: input.runId,
    operationId: "controller-started",
    payload: { model: input.controllerModel },
  });
  try {
    const opened = await deliverOpening(input, decisions, tools, bindings);
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
      const steered = await deliverSteering(input, state, decisions, controllerCalls, tools, bindings);
      state = steered.state;
      controllerCalls = steered.controllerCalls;
      followupSubmission = steered.followupSubmission || followupSubmission;
      if (steered.stop) break;
    }
    return finalizeControllerLoop(state, decisions, controllerCalls, followupSubmission);
  } finally {
    await input.controller.release?.(input.runId);
  }
}

type LoopInput = Parameters<typeof runControllerLoop>[0];

async function deliverOpening(
  input: LoopInput,
  decisions: StructuredAgentResult<ControllerDecision>[],
  tools: readonly AgentToolDefinition[],
  bindings: ControllerToolBindings,
): Promise<
  | { finished: true; result: ReturnType<typeof finalizeControllerLoop> }
  | { finished: false; state: SteeringContext["runState"]; controllerCalls: number }
> {
  const opening = await requestControllerDecision(input, "created", 0, "opening", tools, bindings);
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
  tools: readonly AgentToolDefinition[],
  bindings: ControllerToolBindings,
): Promise<{
  state: SteeringContext["runState"];
  controllerCalls: number;
  followupSubmission: boolean;
  stop: boolean;
}> {
  const decision = await requestControllerDecision(input, state, controllerCalls, "steering", tools, bindings);
  const calls = controllerCalls + 1;
  decisions.push(decision);
  await persistControllerDecision(input, calls, decision);
  if (decision.status !== "completed") {
    const next = decision.status === "failed"
      ? await input.run.failController({ code: decision.failure.code, message: decision.failure.message })
      : await input.run.cancel();
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
  tools: readonly AgentToolDefinition[],
  bindings: ControllerToolBindings,
) {
  const briefingRoot = controllerBriefingRoot(input.experimentRoot, input.runId);
  assertBriefingOutsideReplica(briefingRoot, input.environment.root);
  const packed = await packControllerBriefing(input, phase, briefingRoot);
  const context = steeringContextFrom(input, state, controllerCalls, phase, packed);
  bindings.requestId = context.requestId;
  bindings.phase = phase;
  bindings.changedPaths = packed.observation.changedPaths;
  bindings.settledTurnCount = input.store.events(input.runId).filter((event) => event.type === "runtime.turn_settled").length;
  await persistControllerRequested(input, context);
  return input.controller.decide(context, tools, experimentAgentAuditSink(input.store, input.runId));
}

async function packControllerBriefing(
  input: LoopInput,
  phase: "opening" | "steering",
  briefingRoot: string,
): Promise<{
    observation: Pick<ControllerObservation, "currentSummary" | "trajectorySummary" | "evidenceRefs" | "changedPaths"> & Partial<Pick<ControllerObservation, "runtimeGeneratedPaths" | "settlementStatus">>;
  indexMarkdown: string;
  fileDigests: Record<string, string>;
  briefingRoot: string;
  turnRelative?: string;
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
      ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    },
  );
  const turnText = inspection.turnVisibleText ?? "";
  const written = await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: Math.max(1, inspection.turns),
    visibleText: turnText,
    events: eventsForLatestSettledTurn(input.store.events(input.runId)),
    changedPaths: inspection.changedPaths,
    surface: controllerViewSurface(inspection.settlementStatus, turnText),
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
    observation: Pick<ControllerObservation, "currentSummary" | "trajectorySummary" | "evidenceRefs" | "changedPaths"> & Partial<Pick<ControllerObservation, "runtimeGeneratedPaths" | "settlementStatus">>;
    indexMarkdown: string;
    fileDigests: Record<string, string>; briefingRoot: string;
    turnRelative?: string;
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
      ...(packed.turnRelative ? { latestTurnRelative: packed.turnRelative } : {}),
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
    hostFacts: {
      changedPaths: observation.changedPaths,
      requestId: `controller-request-${input.runId}-${controllerCalls + 1}`,
      runId: input.runId,
      phase,
      recentToolErrors: recentToolErrorsFromEvents(input.store.events(input.runId)),
      historicalRequirementRefs: historicalRequirementRefs(input.taskCase),
      ...("runtimeGeneratedPaths" in observation ? { runtimeGeneratedPaths: observation.runtimeGeneratedPaths } : {}),
      ...("settlementStatus" in observation && observation.settlementStatus ? { settlementStatus: observation.settlementStatus } : {}),
    },
  };
}

async function persistControllerRequested(input: LoopInput, context: SteeringContext): Promise<void> {
  const snapshot = controllerRequestSnapshot(context, input.controller.systemPromptDigest);
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

