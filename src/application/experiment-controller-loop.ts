import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { ControllerReadArtifactSchema, ControllerShellArtifactSchema } from "../core/schema.js";
import { type ControllerDecision, type ControllerPort, type SteeringContext } from "../agents/controller-agent.js";
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
import { sha256 } from "../core/identity.js";
import type { RunPolicy, TaskCase } from "../core/schema.js";
import type { PreparedEnvironmentRef } from "../environment/local-workspace-provider.js";
import { recoveryTools } from "../infrastructure/recovery-tools.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { historicalCwdOf, type SourceRootKind } from "./replay-conditions.js";
import { experimentAgentAuditSink, invocationFact } from "./experiment-helpers.js";
import {
  eventsForLatestSettledTurn,
  inspectRun,
  persistUserVisibleTurn,
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
