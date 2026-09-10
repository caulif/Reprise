import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathContainedBy } from "../core/paths.js";
import type { RunInspection } from "./comparison.js";
import { Value } from "@sinclair/typebox/value";
import { UserVisibleTurnSchema, type EventEnvelope, type RunRecord, type UserVisibleTurn } from "../core/schema.js";
import type { TurnSettlement } from "../core/runtime.js";
import {
  LocalWorkspaceProvider,
  type PreparedEnvironmentRef,
} from "../environment/local-workspace-provider.js";
import type { ExperimentStore } from "../infrastructure/store/experiment-store.js";
import { findProductPack } from "../products/index.js";
import { packProjection } from "../products/pack-access.js";
import { hostReplayConditions, type ReplayLang, type SourceRootKind } from "./replay-conditions.js";
import { recordValue, strings, collectedTokenFacts, totalTokenCount } from "./experiment-helpers.js";

export type ControllerObservation = RunInspection & {
  evidenceRefs: string[];
  currentSummary: string;
  trajectorySummary: string;
  settlementStatus?: string;
  /** Visible assistant text from the latest settled turn only; empty when that turn has none. */
  turnVisibleText?: string;
  /** User-visible confirmation or approval request from the latest settled turn. */
  turnPrompt?: string;
  userView?: UserVisibleTurn;
};

export type WorkspaceInspection = {
  runId: string;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
};

/** Deterministically condenses persisted Target facts; no model inference is involved. */
export async function inspectRun(
  store: ExperimentStore,
  record: RunRecord | undefined,
  allowModelText: boolean,
  productId: string,
  workspace?: WorkspaceInspection,
  replay?: {
    sourceRootKind: SourceRootKind;
    requestedModel: string;
    resolvedModel?: string;
    lang?: ReplayLang;
  },
): Promise<ControllerObservation> {
  const runId = record?.attempt.runId ?? workspace?.runId;
  if (!runId)
    throw new Error("Run inspection requires a RunRecord or active workspace.");
  const events = store.events(runId);
  const translator = packProjection(findProductPack(productId));
  const facts = translator.inspectRunFacts(events);
  const finalMessage = facts.finalMessage;
  const commands = [...facts.commands];
  const settled = events.filter(
    (event) => event.type === "runtime.turn_settled",
  );
  const turnEvents = eventsForLatestSettledTurn(events);
  const turnFacts = translator.inspectRunFacts(turnEvents);
  const latestSettlement = settled.at(-1);
  const userView = projectLatestUserView(translator, settled.length, latestSettlement, turnEvents, allowModelText);
  const turnVisibleText = allowModelText ? turnFacts.finalMessage : undefined;
  const turnPrompt = allowModelText ? userVisiblePrompt(userView) : undefined;
  const rejectedApprovals = facts.rejectedApprovals;
  const workspaceFacts = record
    ? await readWorkspaceScope(store, record)
    : await inspectWorkspace(workspace);
  const wallClockMs = elapsedWallClock(events, settled);
  const tokenCount = totalTokenCount(events);
  const tokenUsage = collectedTokenFacts(events);
  const replayConditions = replay
    ? hostReplayConditions({
        sourceRootKind: replay.sourceRootKind,
        requestedModel: replay.requestedModel,
        ...(replay.resolvedModel ? { resolvedModel: replay.resolvedModel } : {}),
        ...(record ? { record } : {}),
        events,
        settledTurns: settled.length,
        changedPaths: workspaceFacts.changedPaths,
        ...(replay.lang ? { lang: replay.lang } : {}),
      })
    : undefined;
  const inspection: RunInspection = {
    runId,
    ...(allowModelText && finalMessage ? { finalMessage } : {}),
    commands,
    rejectedApprovals,
    turns: settled.length,
    ...(wallClockMs === undefined ? {} : { wallClockMs }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...workspaceFacts,
    ...(replayConditions?.length ? { replayConditions } : {}),
  };
  const evidenceRefs = facts.evidenceEvents
    .map((event) => `event:${event.eventId}`);
  const settlementStatus = latestSettlement
    ? recordValue(latestSettlement.payload).status
    : undefined;
  const status =
    typeof settlementStatus === "string" ? settlementStatus : "unknown";
  const currentSummary = [
    `Latest target settlement: ${status}.`,
    `Observed commands: ${commands.length}; changed paths: ${inspection.changedPaths.length}; rejected approvals: ${rejectedApprovals}.`,
    `Workspace evidence: ${inspection.workspaceEvidenceStatus ?? "unavailable"}.`,
    allowModelText && turnVisibleText
      ? "Visible assistant text was recorded; inspect THIS-TURN and project files rather than treating this summary as completion."
      : "No model text is available to the Controller.",
  ].join(" ");
  const trajectorySummary = `Settled turns: ${inspection.turns}; commands: ${commands.length}; changed paths: ${inspection.changedPaths.length}; runtime-generated paths: ${inspection.runtimeGeneratedPaths.length}.`;
  return {
    ...inspection,
    evidenceRefs,
    currentSummary,
    trajectorySummary,
    settlementStatus: status,
    ...(turnVisibleText ? { turnVisibleText } : {}),
    ...(turnPrompt ? { turnPrompt } : {}),
    ...(userView ? { userView } : {}),
  };
}

/** Inclusive sequence window from the previous settlement (exclusive) through the latest `runtime.turn_settled`. */
export function eventsForLatestSettledTurn(events: readonly EventEnvelope[]): EventEnvelope[] {
  const settled = events.filter((event) => event.type === "runtime.turn_settled");
  const last = settled.at(-1);
  if (!last) return [];
  const previous = settled.at(-2);
  const start = previous?.sequence ?? 0;
  return events.filter((event) => event.sequence > start && event.sequence <= last.sequence);
}

function projectLatestUserView(
  translator: ReturnType<typeof packProjection>,
  turnIndex: number,
  latestSettlement: EventEnvelope | undefined,
  turnEvents: readonly EventEnvelope[],
  allowModelText: boolean,
): UserVisibleTurn | undefined {
  if (!latestSettlement || turnIndex < 1) return undefined;
  const payload = recordValue(latestSettlement.payload);
  const settlement: TurnSettlement = {
    turnId: typeof payload.turnId === "string" ? payload.turnId : "unknown",
    status: payload.status === "completed" || payload.status === "failed" || payload.status === "waiting_input" || payload.status === "aborted"
      ? payload.status
      : "failed",
    confidence: payload.confidence === "native" || payload.confidence === "composite" || payload.confidence === "heuristic"
      ? payload.confidence
      : "heuristic",
    observedAt: typeof payload.observedAt === "string" ? payload.observedAt : latestSettlement.occurredAt,
    rawRefs: Array.isArray(payload.rawRefs) ? payload.rawRefs : [],
  };
  try {
    return translator.projectTurn({
      turnIndex,
      settlement,
      events: turnEvents,
      allowModelText,
    });
  } catch {
    return { turnIndex, status: "unavailable", observedAt: settlement.observedAt };
  }
}

export async function persistUserVisibleTurn(
  store: ExperimentStore,
  runId: string,
  userView: UserVisibleTurn | undefined,
): Promise<void> {
  if (!userView) return;
  if (!Value.Check(UserVisibleTurnSchema, userView)) {
    throw new Error("UserVisibleTurn failed schema check.");
  }
  await store.append({
    type: "candidate.user_view_persisted",
    runId,
    payload: userView,
  });
}

function userVisiblePrompt(userView: UserVisibleTurn | undefined): string | undefined {
  const prompt = userView?.prompt?.trim();
  return prompt || undefined;
}

export function unstartedControllerObservation(): Pick<
  ControllerObservation,
  "currentSummary" | "trajectorySummary" | "evidenceRefs" | "changedPaths"
> {
  return {
    currentSummary:
      "Candidate turn has not started. Settlement: none. No model text is available to the Controller. Observed commands: 0; changed paths: 0; rejected approvals: 0.",
    trajectorySummary:
      "Settled turns: 0; commands: 0; changed paths: 0; runtime-generated paths: 0.",
    evidenceRefs: [],
    changedPaths: [],
  };
}

async function inspectWorkspace(
  workspace: WorkspaceInspection | undefined,
): Promise<Pick<RunInspection, "changedPaths" | "runtimeGeneratedPaths" | "workspaceEvidenceStatus">> {
  if (!workspace) return { changedPaths: [], runtimeGeneratedPaths: [], workspaceEvidenceStatus: "not_collected" as const };
  const after = await workspace.workspaceProvider.fingerprint(
    workspace.environment,
  );
  const paths = changedPathsBetween(
    workspace.environment.beforeFingerprint,
    after,
  );
  return {
    changedPaths: paths.filter((path) => !path.startsWith("node_modules/")),
    runtimeGeneratedPaths: paths.filter((path) =>
      path.startsWith("node_modules/"),
    ),
    workspaceEvidenceStatus: "available" as const,
  };
}

async function readWorkspaceScope(
  store: ExperimentStore,
  record: RunRecord,
): Promise<Pick<RunInspection, "changedPaths" | "runtimeGeneratedPaths" | "workspaceEvidenceStatus">> {
  const ref = record.artifactRefs.find(
    (item) => item.artifactId === "candidate-workspace-scope.json",
  );
  if (!ref) return { changedPaths: [], runtimeGeneratedPaths: [], workspaceEvidenceStatus: "not_collected" as const };
  try {
    const scope = recordValue(
      JSON.parse(Buffer.from(await store.readArtifact(ref)).toString("utf8")),
    );
    return {
      changedPaths: strings(scope.changedPaths),
      runtimeGeneratedPaths: strings(scope.runtimeGeneratedPaths),
      workspaceEvidenceStatus: "available" as const,
    };
  } catch {
    return { changedPaths: [], runtimeGeneratedPaths: [], workspaceEvidenceStatus: "unavailable" as const };
  }
}

function elapsedWallClock(
  events: readonly EventEnvelope[],
  settled: readonly EventEnvelope[],
): number | undefined {
  const start = events.find(
    (event) =>
      event.type === "input.submitted" || event.type === "run.state_changed",
  );
  const end = settled.at(-1);
  if (!start || !end) return undefined;
  const startedAt = Date.parse(start.occurredAt);
  const endedAt = Date.parse(end.occurredAt);
  return Number.isFinite(startedAt) &&
    Number.isFinite(endedAt) &&
    endedAt >= startedAt
    ? endedAt - startedAt
    : undefined;
}

/** Captures bounded, immutable evidence before CandidateRun releases its workspace. */
export async function captureWorkspaceScope(input: {
  store: ExperimentStore;
  environment: PreparedEnvironmentRef;
  workspaceProvider: LocalWorkspaceProvider;
  experimentId: string;
  runId: string;
}): Promise<RunRecord["artifactRefs"]> {
  const after = await input.workspaceProvider.fingerprint(input.environment);
  const snapshot = await input.workspaceProvider.sealCandidateSnapshot(input.environment);
  const allChangedPaths = changedPathsBetween(
    input.environment.beforeFingerprint,
    after,
  );
  const runtimeGeneratedPaths = allChangedPaths.filter((path) =>
    path.startsWith("node_modules/"),
  );
  const changedPaths = allChangedPaths.filter(
    (path) => !path.startsWith("node_modules/"),
  );
  const before = fingerprintEntries(input.environment.beforeFingerprint);
  const current = fingerprintEntries(after);
  const snapshots = await Promise.all(
    changedPaths
      .slice(0, 16)
      .map((path) => textSnapshot(input.environment.root, path)),
  );
  const artifactId = "candidate-workspace-scope.json";
  await input.store.commitArtifact({
    artifactId,
    runId: input.runId,
    kind: "candidate_workspace_scope",
    mediaType: "application/json",
    bytes: Buffer.from(
      JSON.stringify(
        {
          snapshotStatus: snapshot.status,
          snapshotRoot: snapshot.root,
          baselineFingerprint: input.environment.beforeFingerprint.digest,
          candidateFingerprint: after.digest,
          changedPaths,
          runtimeGeneratedPaths,
          changes: changedPaths.map((path) => ({
            path,
            before: before.get(path),
            after: current.get(path),
          })),
          textSnapshots: snapshots.filter(
            (snapshot): snapshot is NonNullable<typeof snapshot> =>
              snapshot !== undefined,
          ),
        },
        null,
        2,
      ),
      "utf8",
    ),
  });
  return [{ artifactId, experimentId: input.experimentId, runId: input.runId }];
}

function fingerprintEntries(
  fingerprint: PreparedEnvironmentRef["beforeFingerprint"],
): Map<string, unknown> {
  return new Map(
    fingerprint.resources.map((entry) => [
      entry.path.replaceAll("\\", "/"),
      entry,
    ]),
  );
}

async function textSnapshot(
  root: string,
  path: string,
): Promise<{ path: string; content: string; truncated: boolean } | undefined> {
  const fullPath = resolve(root, path);
  if (!pathContainedBy(resolve(root), fullPath)) return undefined;
  try {
    if (!(await lstat(fullPath)).isFile()) return undefined;
    const bytes = await readFile(fullPath);
    if (bytes.includes(0)) return undefined;
    const slice = bytes.subarray(0, 32_768);
    return {
      path: path.replaceAll("\\", "/"),
      content: slice.toString("utf8"),
      truncated: bytes.byteLength > slice.byteLength,
    };
  } catch {
    return undefined;
  }
}

function changedPathsBetween(
  before: PreparedEnvironmentRef["beforeFingerprint"],
  after: PreparedEnvironmentRef["beforeFingerprint"],
): string[] {
  const entries = (fingerprint: PreparedEnvironmentRef["beforeFingerprint"]) =>
    new Map(
      fingerprint.resources
        .filter((entry) => entry.kind === "file")
        .map((entry) => [
          entry.path.replaceAll("\\", "/"),
          JSON.stringify(entry),
        ]),
    );
  const initial = entries(before);
  const current = entries(after);
  return [...new Set([...initial.keys(), ...current.keys()])]
    .filter((path) => initial.get(path) !== current.get(path))
    .sort();
}
