import { chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import {
  ControlFinishedSchema,
  ControlRecordSchema,
  type ControlFinished,
  type ControlRecord,
} from "../core/control-protocol.js";

function controlRecordPath(experimentRoot: string): string {
  return join(experimentRoot, "control.json");
}

function controlTokenPath(ipcDir: string): string {
  return join(ipcDir, "token");
}

function controlFinishedPath(experimentRoot: string, operationId: string): string {
  return join(experimentRoot, "control-ops", `${operationId}.json`);
}

export function experimentRootFor(dataDir: string, experimentId: string): string {
  return join(dataDir, "experiments", experimentId);
}

export async function writeControlToken(ipcDir: string, token: string): Promise<void> {
  await mkdir(ipcDir, { recursive: true });
  const path = controlTokenPath(ipcDir);
  await writeAtomic(path, `${token}\n`);
  await chmod(path, 0o600).catch(() => undefined);
  await chmod(ipcDir, 0o700).catch(() => undefined);
}

export async function readControlToken(ipcDir: string): Promise<string | undefined> {
  try {
    const raw = (await readFile(controlTokenPath(ipcDir), "utf8")).trim();
    return raw.length >= 32 ? raw : undefined;
  } catch (error: unknown) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

export async function writeControlRecord(experimentRoot: string, record: ControlRecord): Promise<void> {
  if (!Value.Check(ControlRecordSchema, record)) throw new Error("Invalid control record.");
  await writeAtomic(controlRecordPath(experimentRoot), `${JSON.stringify(record)}\n`);
}

async function readControlRecord(experimentRoot: string): Promise<ControlRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(controlRecordPath(experimentRoot), "utf8"));
    return Value.Check(ControlRecordSchema, value) ? value : undefined;
  } catch (error: unknown) {
    if (isEnoent(error)) return undefined;
    return undefined;
  }
}

export async function deleteControlRecord(experimentRoot: string): Promise<void> {
  await rm(controlRecordPath(experimentRoot), { force: true });
}

export async function writeControlFinished(experimentRoot: string, finished: ControlFinished): Promise<void> {
  if (!Value.Check(ControlFinishedSchema, finished)) throw new Error("Invalid finished control op.");
  await writeAtomic(controlFinishedPath(experimentRoot, finished.operationId), `${JSON.stringify(finished)}\n`);
}

export async function readControlFinished(experimentRoot: string, operationId: string): Promise<ControlFinished | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(controlFinishedPath(experimentRoot, operationId), "utf8"));
    return Value.Check(ControlFinishedSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function listExperimentRoots(dataDir: string): Promise<readonly string[]> {
  const directory = join(dataDir, "experiments");
  try {
    const names = await readdir(directory);
    return names.map((name) => join(directory, name));
  } catch (error: unknown) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function listControlRecords(dataDir: string): Promise<readonly { record: ControlRecord; experimentRoot: string }[]> {
  const found: { record: ControlRecord; experimentRoot: string }[] = [];
  for (const experimentRoot of await listExperimentRoots(dataDir)) {
    const record = await readControlRecord(experimentRoot);
    if (record) found.push({ record, experimentRoot });
  }
  return found;
}

export async function removeOwnerIpc(ipcDir: string): Promise<void> {
  await rm(ipcDir, { recursive: true, force: true });
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
