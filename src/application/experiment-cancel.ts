import { randomUUID } from "node:crypto";
import {
  CONTROL_CLIENT_TIMEOUT_MS,
  type ControlRecord,
  type ControlResponse,
} from "../core/control-protocol.js";
import { controlIpcDir, sendControlRequest } from "../infrastructure/control-endpoint.js";
import {
  listControlRecords,
  listExperimentRoots,
  readControlFinished,
  readControlToken,
} from "../infrastructure/control-store.js";
import {
  formatCancelResult,
  requestInProcessCancel,
  type CancelLookup,
  type ExperimentActivity,
  type ParsedActivityId,
} from "./experiment-activity.js";

export { formatCancelResult };

export async function requestCancel(id: string, dataDir?: string): Promise<CancelLookup> {
  const local = await requestInProcessCancel(id);
  if (local.status !== "unknown") return local;
  if (!dataDir) return local;
  return requestRemoteCancel(id, dataDir, local.parsed);
}

async function requestRemoteCancel(id: string, dataDir: string, parsed: ParsedActivityId): Promise<CancelLookup> {
  const listed = await listControlRecords(dataDir);
  const matches = listed.filter((item) => recordMatches(item.record, id, parsed));
  if (matches.length === 1) return sendToOwner(id, dataDir, parsed, matches[0]!.record);
  if (parsed.kind === "operation") {
    for (const experimentRoot of await listExperimentRoots(dataDir)) {
      const prior = await readControlFinished(experimentRoot, id);
      if (prior) return alreadyFinishedFrom(prior);
    }
  }
  return { status: "unknown", id, parsed };
}

function recordMatches(record: ControlRecord, id: string, parsed: ParsedActivityId): boolean {
  if (parsed.kind === "operation") return record.operationId === id;
  if (parsed.kind === "run") return record.runId === id;
  return record.experimentId === id;
}

async function sendToOwner(
  id: string,
  dataDir: string,
  parsed: ParsedActivityId,
  record: ControlRecord,
): Promise<CancelLookup> {
  const token = await readControlToken(controlIpcDir(dataDir, record.ownerInstanceId));
  if (!token) return { status: "unreachable", id, parsed };
  const response = await sendControlRequest(record.endpoint, {
    protocolVersion: 1,
    command: "cancel",
    token,
    ownerInstanceId: record.ownerInstanceId,
    operationId: record.operationId,
    requestId: `cancel-${randomUUID()}`,
  }, CONTROL_CLIENT_TIMEOUT_MS);
  if (!("protocolVersion" in response)) return { status: response.status, id, parsed };
  return lookupFromResponse(id, parsed, record, response);
}

function lookupFromResponse(
  id: string,
  parsed: ParsedActivityId,
  record: ControlRecord,
  response: ControlResponse,
): CancelLookup {
  const activity = activityFromRecord(record);
  if (response.status === "auth_failed") return { status: "auth_failed", id };
  if (response.status === "already_finished") return { status: "already_finished", activity };
  if (response.status === "accepted") return { status: "accepted", activity };
  if (response.status === "unknown_operation") return { status: "unknown", id, parsed };
  return { status: "unreachable", id, parsed };
}

function activityFromRecord(record: ControlRecord): ExperimentActivity {
  return {
    operationId: record.operationId,
    kind: record.kind,
    experimentId: record.experimentId,
    runId: record.runId,
    status: "cancel_requested",
    cancel: async () => undefined,
  };
}

function alreadyFinishedFrom(finished: {
  operationId: string;
  kind: ControlRecord["kind"];
  experimentId: string;
  runId: string;
}): CancelLookup {
  return {
    status: "already_finished",
    activity: {
      operationId: finished.operationId,
      kind: finished.kind,
      experimentId: finished.experimentId,
      runId: finished.runId,
      status: "finished",
      cancel: async () => undefined,
    },
  };
}
