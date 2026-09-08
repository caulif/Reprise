import { randomBytes, randomUUID } from "node:crypto";
import { CONTROL_PROTOCOL_VERSION, type ControlResponse } from "../core/control-protocol.js";
import { controlEndpointFor, controlIpcDir, listenControlEndpoint } from "../infrastructure/control-endpoint.js";
import {
  deleteControlRecord,
  experimentRootFor,
  removeOwnerIpc,
  writeControlFinished,
  writeControlRecord,
  writeControlToken,
} from "../infrastructure/control-store.js";
import type { ExperimentActivity } from "./experiment-activity.js";

type OwnerHost = {
  readonly ownerInstanceId: string;
  readonly dataDir: string;
  readonly endpoint: ReturnType<typeof controlEndpointFor>;
  close: () => Promise<void>;
};

let host: OwnerHost | undefined;
let chain = Promise.resolve();

export function enqueueControlWork(work: () => Promise<void>): Promise<void> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

export async function publishActivityControl(
  activity: ExperimentActivity,
  dataDir: string,
  onCancel: (operationId: string) => Promise<ControlResponse>,
): Promise<void> {
  const owner = await ensureHost(dataDir, onCancel);
  const experimentRoot = experimentRootFor(dataDir, activity.experimentId);
  await writeControlRecord(experimentRoot, {
    schemaVersion: 1,
    protocolVersion: CONTROL_PROTOCOL_VERSION,
    ownerInstanceId: owner.ownerInstanceId,
    pid: process.pid,
    operationId: activity.operationId,
    experimentId: activity.experimentId,
    runId: activity.runId,
    kind: activity.kind,
    endpoint: owner.endpoint,
    startedAt: new Date().toISOString(),
  });
}

export async function retireActivityControl(activity: ExperimentActivity, dataDir: string, stillRunning: boolean): Promise<void> {
  const experimentRoot = experimentRootFor(dataDir, activity.experimentId);
  await writeControlFinished(experimentRoot, {
    schemaVersion: 1,
    operationId: activity.operationId,
    experimentId: activity.experimentId,
    runId: activity.runId,
    kind: activity.kind,
    finishedAt: new Date().toISOString(),
  });
  if (stillRunning) return;
  await deleteControlRecord(experimentRoot);
}

export async function stopControlHostIfIdle(runningCount: number): Promise<void> {
  if (runningCount > 0 || !host) return;
  const closing = host;
  host = undefined;
  await closing.close();
  await removeOwnerIpc(controlIpcDir(closing.dataDir, closing.ownerInstanceId));
}

async function ensureHost(
  dataDir: string,
  onCancel: (operationId: string) => Promise<ControlResponse>,
): Promise<OwnerHost> {
  if (host && host.dataDir === dataDir) return host;
  if (host) await stopControlHostIfIdle(0);
  const ownerInstanceId = `own-${randomUUID()}`;
  const token = randomBytes(32).toString("hex");
  const ipcDir = controlIpcDir(dataDir, ownerInstanceId);
  await writeControlToken(ipcDir, token);
  const endpoint = controlEndpointFor(ownerInstanceId, ipcDir);
  const listener = await listenControlEndpoint({
    ipcDir,
    endpoint,
    onRequest: async (request) => {
      if (request.token !== token || request.ownerInstanceId !== ownerInstanceId) {
        return { protocolVersion: CONTROL_PROTOCOL_VERSION, status: "auth_failed", operationId: request.operationId };
      }
      return onCancel(request.operationId);
    },
  });
  host = { ownerInstanceId, dataDir, endpoint, close: listener.close };
  return host;
}
