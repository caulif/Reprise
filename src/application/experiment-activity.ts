import { randomUUID } from "node:crypto";
import { SAFE_ID } from "../core/identity.js";
import { CONTROL_PROTOCOL_VERSION, type ControlResponse } from "../core/control-protocol.js";
import {
  enqueueControlWork,
  publishActivityControl,
  retireActivityControl,
  stopControlHostIfIdle,
} from "./experiment-control-host.js";

export type ActivityKind = "prepare" | "run" | "compare";
export type ActivityStatus = "running" | "cancel_requested" | "finished";

export type ExperimentActivity = {
  readonly operationId: string;
  readonly kind: ActivityKind;
  readonly experimentId: string;
  readonly runId: string;
  readonly dataDir?: string;
  status: ActivityStatus;
  cancel: () => Promise<void>;
};

export type CancelLookup =
  | { readonly status: "invalid"; readonly id: string }
  | { readonly status: "unknown"; readonly id: string; readonly parsed: ParsedActivityId }
  | { readonly status: "already_finished"; readonly activity: ExperimentActivity }
  | { readonly status: "cancel_requested"; readonly activity: ExperimentActivity }
  | { readonly status: "accepted"; readonly activity: ExperimentActivity }
  | { readonly status: "unreachable"; readonly id: string; readonly parsed: ParsedActivityId }
  | { readonly status: "auth_failed"; readonly id: string }
  | { readonly status: "timeout"; readonly id: string };

export type ParsedActivityId = {
  readonly id: string;
  readonly kind: "operation" | "experiment" | "run" | "ambiguous";
};

const activities = new Map<string, ExperimentActivity>();
const publishes = new WeakMap<ExperimentActivity, Promise<void>>();

export function parseActivityId(id: string): ParsedActivityId {
  if (!SAFE_ID.test(id)) return { id, kind: "ambiguous" };
  if (id.startsWith("op-prepare-") || id.startsWith("op-run-") || id.startsWith("op-compare-")) {
    return { id, kind: "operation" };
  }
  if (id.startsWith("experiment-") || (id.startsWith("recovery-") && !id.startsWith("recovery-run-"))) {
    return { id, kind: "experiment" };
  }
  if (id.startsWith("run-") || id.startsWith("recovery-run-")) return { id, kind: "run" };
  return { id, kind: "ambiguous" };
}

export function registerActivity(input: {
  kind: ActivityKind;
  experimentId: string;
  runId: string;
  cancel: () => Promise<void>;
  dataDir?: string;
}): ExperimentActivity {
  finishExperimentActivity(input.experimentId);
  const activity: ExperimentActivity = {
    operationId: `op-${input.kind}-${randomUUID()}`,
    kind: input.kind,
    experimentId: input.experimentId,
    runId: input.runId,
    status: "running",
    cancel: input.cancel,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  };
  activities.set(activity.operationId, activity);
  if (input.dataDir) {
    const dataDir = input.dataDir;
    publishes.set(activity, enqueueControlWork(() => publishActivityControl(activity, dataDir, handleOwnerControlCancel)));
  }
  return activity;
}

export function activityControlReady(activity: ExperimentActivity): Promise<void> {
  return publishes.get(activity) ?? Promise.resolve();
}

export function finishExperimentActivity(experimentId: string): void {
  for (const activity of activities.values()) {
    if (activity.experimentId !== experimentId || activity.status === "finished") continue;
    activity.status = "finished";
    const dataDir = activity.dataDir;
    if (!dataDir) continue;
    publishes.set(activity, enqueueControlWork(async () => {
      await retireActivityControl(activity, dataDir, listRunningActivities().some((item) => item.experimentId === experimentId));
      await stopControlHostIfIdle(listRunningActivities().length);
    }));
  }
}

function listRunningActivities(): readonly ExperimentActivity[] {
  return [...activities.values()].filter((item) => item.status !== "finished");
}

function findActivity(id: string, kind: ParsedActivityId["kind"]): ExperimentActivity | undefined {
  const exact = activities.get(id);
  if (exact) return exact;
  const running = listRunningActivities();
  if (kind === "experiment" || kind === "ambiguous") {
    const matches = running.filter((item) => item.experimentId === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (kind === "run") {
    const matches = running.filter((item) => item.runId === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

export async function requestInProcessCancel(id: string): Promise<CancelLookup> {
  if (!SAFE_ID.test(id)) return { status: "invalid", id };
  const parsed = parseActivityId(id);
  const activity = findActivity(id, parsed.kind);
  if (!activity) return { status: "unknown", id, parsed };
  if (activity.status === "finished") return { status: "already_finished", activity };
  activity.status = "cancel_requested";
  await activity.cancel();
  return { status: "cancel_requested", activity };
}

async function handleOwnerControlCancel(operationId: string): Promise<ControlResponse> {
  const activity = activities.get(operationId);
  if (!activity) return { protocolVersion: CONTROL_PROTOCOL_VERSION, status: "unknown_operation", operationId };
  if (activity.status === "finished") {
    return { protocolVersion: CONTROL_PROTOCOL_VERSION, status: "already_finished", operationId, knownState: "finished" };
  }
  if (activity.status !== "cancel_requested") {
    activity.status = "cancel_requested";
    void activity.cancel();
  }
  return { protocolVersion: CONTROL_PROTOCOL_VERSION, status: "accepted", operationId, knownState: "cancel_requested" };
}

export function formatCancelResult(result: CancelLookup): string {
  if (result.status === "invalid") return `invalid id (not a safe identifier): ${result.id}`;
  if (result.status === "unknown") {
    return `unknown ${result.parsed.kind} ${result.id}; owner is not this process (lock untouched)`;
  }
  if (result.status === "unreachable") {
    return `unreachable ${result.parsed.kind} ${result.id}; lock untouched; pid not killed`;
  }
  if (result.status === "auth_failed") return `auth failed for ${result.id}; lock untouched`;
  if (result.status === "timeout") return `timeout waiting for owner ${result.id}; lock untouched`;
  const { activity } = result;
  return [
    `status: ${result.status}`,
    `kind: ${activity.kind}`,
    `operationId: ${activity.operationId}`,
    `experimentId: ${activity.experimentId}`,
    `runId: ${activity.runId}`,
  ].join("\n");
}
