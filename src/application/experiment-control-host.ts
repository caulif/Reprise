import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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

const hosts = new Map<string, OwnerHost>();
let chain = Promise.resolve();

export function liveDataDirKey(dataDir: string): string {
  try {
    return realpathSync(dataDir);
  } catch {
    return dataDir;
  }
}

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

export async function stopControlHostIfIdle(runningCount: number, dataDir?: string): Promise<void> {
  if (runningCount > 0) return;
  if (dataDir) {
    const key = liveDataDirKey(dataDir);
    const closing = hosts.get(key);
    if (!closing) return;
    hosts.delete(key);
    await closing.close();
    await removeOwnerIpc(controlIpcDir(closing.dataDir, closing.ownerInstanceId));
    return;
  }
  const closing = [...hosts.values()];
  hosts.clear();
  for (const item of closing) {
    await item.close();
    await removeOwnerIpc(controlIpcDir(item.dataDir, item.ownerInstanceId));
  }
}

async function ensureHost(
  dataDir: string,
  onCancel: (operationId: string) => Promise<ControlResponse>,
): Promise<OwnerHost> {
  const key = liveDataDirKey(dataDir);
  const existing = hosts.get(key);
  if (existing) return existing;
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
  const created = { ownerInstanceId, dataDir: key, endpoint, close: listener.close };
  hosts.set(key, created);
  return created;
}
