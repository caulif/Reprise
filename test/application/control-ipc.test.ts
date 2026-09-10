import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activityControlReady,
  finishExperimentActivity,
  registerActivity,
} from "../../src/application/experiment-activity.js";
import { requestCancel } from "../../src/application/experiment-cancel.js";
import { sendControlRequest, controlIpcDir } from "../../src/infrastructure/control-endpoint.js";
import { listControlRecords, writeControlFinished, experimentRootFor } from "../../src/infrastructure/control-store.js";
import { runCli } from "../../src/cli/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "../../../src");
const childPath = join(here, "../support", "control-owner-child.js");

test("control endpoint is a local pipe or unix socket, never a TCP port", () => {
  const source = readFileSync(join(repoSrc, "infrastructure/control-endpoint.ts"), "utf8");
  assert.match(source, /kind === "pipe"/);
  assert.match(source, /kind === "unix"/);
  assert.doesNotMatch(source, /listen\(\s*\d+/);
  assert.doesNotMatch(source, /createServer\(\s*\{[^}]*port/);
});

test("two processes cancel prepare, run, and compare without touching writer.lock", async (t) => {
  for (const kind of ["prepare", "run", "compare"] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), `reprise-ipc-${kind}-`));
    t.after(async () => rm(dataDir, { recursive: true, force: true }));
    const experimentId = `experiment-${kind}`;
    const lockPath = join(dataDir, "experiments", experimentId, "writer.lock");
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "owner-lock\n");
    const child = spawn(process.execPath, [childPath, dataDir, kind, experimentId, `run-${kind}`], { stdio: ["ignore", "pipe", "pipe"] });
    const line = await readChildLine(child);
    const ready = JSON.parse(line) as { operationId: string };
    assert.equal(JSON.stringify(ready).includes("token"), false);
    const listed = await listControlRecords(dataDir);
    assert.equal(listed.length, 1, `expected control record under ${dataDir}`);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(["cancel", ready.operationId, "--data-dir", dataDir], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });
    assert.equal(code, 0, `${stdout.join("\n")}\n${stderr.join("\n")}`);
    assert.equal(await readFile(lockPath, "utf8"), "owner-lock\n");
    const exit = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${kind} owner did not exit`)), 10_000);
      child.once("exit", (value) => {
        clearTimeout(timer);
        resolve(value ?? 1);
      });
    });
    assert.equal(exit, 0);
  }
});

test("stale operationId does not cancel the next run", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-ipc-stale-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const cancelled: string[] = [];
  const prepare = registerActivity({
    kind: "prepare",
    experimentId: "experiment-stale",
    runId: "run-stale",
    dataDir,
    cancel: async () => { cancelled.push("prepare"); },
  });
  await activityControlReady(prepare);
  finishExperimentActivity("experiment-stale");
  await activityControlReady(prepare);
  const run = registerActivity({
    kind: "run",
    experimentId: "experiment-stale",
    runId: "run-stale",
    dataDir,
    cancel: async () => { cancelled.push("run"); },
  });
  await activityControlReady(run);
  const stale = await requestCancel(prepare.operationId, dataDir);
  assert.equal(stale.status, "already_finished");
  assert.deepEqual(cancelled, []);
  finishExperimentActivity("experiment-stale");
  await activityControlReady(run);
});

test("wrong token does not cancel; finished ops stay finished for a second process view", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-ipc-auth-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const cancelled: string[] = [];
  const activity = registerActivity({
    kind: "run",
    experimentId: "experiment-auth",
    runId: "run-auth",
    dataDir,
    cancel: async () => { cancelled.push("run"); },
  });
  await activityControlReady(activity);
  const listed = await listControlRecords(dataDir);
  assert.equal(listed.length, 1);
  const record = listed[0]!.record;
  if (process.platform !== "win32") {
    const mode = (await stat(join(controlIpcDir(dataDir, record.ownerInstanceId), "token"))).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const denied = await sendControlRequest(record.endpoint, {
    protocolVersion: 1,
    command: "cancel",
    token: "0".repeat(64),
    ownerInstanceId: record.ownerInstanceId,
    operationId: record.operationId,
    requestId: "req-bad",
  });
  assert.equal("protocolVersion" in denied && denied.status, "auth_failed");
  assert.deepEqual(cancelled, []);
  finishExperimentActivity("experiment-auth");
  await activityControlReady(activity);
});

test("finished-operation marker is already_finished without a live owner", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-ipc-finished-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const operationId = "op-prepare-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await writeControlFinished(experimentRootFor(dataDir, "experiment-gone"), {
    schemaVersion: 1,
    operationId,
    experimentId: "experiment-gone",
    runId: "run-gone",
    kind: "prepare",
    finishedAt: "2026-09-08T00:00:00.000Z",
  });
  const result = await requestCancel(operationId, dataDir);
  assert.equal(result.status, "already_finished");
});

test("unreachable control record does not delete the lock or kill a pid", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-ipc-dead-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const experimentId = "experiment-dead";
  const root = experimentRootFor(dataDir, experimentId);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, "writer.lock");
  await writeFile(lockPath, "keep\n");
  await writeFile(join(root, "control.json"), `${JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    ownerInstanceId: "own-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    pid: 1,
    operationId: "op-run-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    experimentId,
    runId: "run-dead",
    kind: "run",
    endpoint: process.platform === "win32"
      ? { kind: "pipe", name: "\\\\.\\pipe\\reprise-missing-owner" }
      : { kind: "unix", path: join(root, "no-sock") },
    startedAt: "2026-09-08T00:00:00.000Z",
  })}\n`);
  await mkdir(join(dataDir, "ipc", "own-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), { recursive: true });
  await writeFile(join(dataDir, "ipc", "own-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "token"), `${"ab".repeat(32)}\n`);
  const result = await requestCancel("experiment-dead", dataDir);
  assert.ok(result.status === "unreachable" || result.status === "timeout");
  assert.equal(await readFile(lockPath, "utf8"), "keep\n");
});

test("cancel client source never kills pids or unlinks writer.lock", async () => {
  const source = await readFile(join(repoSrc, "application/experiment-cancel.ts"), "utf8");
  assert.doesNotMatch(source, /taskkill|writer\.lock|process\.kill/);
});

async function readChildLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("child ready timeout")), 8_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        resolve(buffer.slice(0, newline));
      }
    });
    child.once("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`child exited ${code}: ${buffer}`));
      }
    });
  });
}
