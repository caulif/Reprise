import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComparisonAgent, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { activityControlReady, finishExperimentActivity, registerActivity } from "../../src/application/experiment-activity.js";
import { AgentHost } from "../../src/infrastructure/agent/host.js";
import { listControlRecords } from "../../src/infrastructure/control-store.js";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";

const here = dirname(fileURLToPath(import.meta.url));

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId: "attempt-1",
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [],
    telemetry: [],
    artifactRefs: [],
    allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: {
      run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
      models: { candidate: "fixture" },
      activity: {},
      limits: { triggered: [] },
      runtime: { productId: "codex" },
      delivery: { changedPaths: [], targetArtifactStatus: "unavailable", verificationStatus: "unavailable" },
      replay: { conditions: [], baselineEvidence: "unavailable", candidateEvidence: "unavailable" },
    },
  };
}

test("compare command releases an unreadable writer.lock and closes the control listener", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-compare-exit-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const experimentId = "experiment-exit";
  const store = await ExperimentStore.open(join(dataDir, "experiments", experimentId), experimentId);
  await store.acquireWriter();
  const lockPath = join(dataDir, "experiments", experimentId, "writer.lock");
  if (process.platform !== "win32") await chmod(lockPath, 0o000);
  const activity = registerActivity({
    kind: "compare",
    experimentId,
    runId: "run-exit",
    dataDir,
    cancel: async () => undefined,
  });
  await activityControlReady(activity);
  const listed = await listControlRecords(dataDir);
  const endpoint = listed[0]?.record.endpoint;
  assert.ok(endpoint);
  const socket = endpoint.kind === "pipe" ? createConnection(endpoint.name) : createConnection(endpoint.path);
  socket.on("error", () => undefined);
  await once(socket, "connect");

  try {
    await store.close();
  } catch {
    // result already produced
  }
  await finishExperimentActivity(experimentId);

  await assert.rejects(stat(lockPath), { code: "ENOENT" });
  assert.equal(socket.destroyed, true);
  assert.deepEqual(await listControlRecords(dataDir), []);
});

test("close still removes a readable writer.lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-compare-exit-ok-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const store = await ExperimentStore.open(root, "experiment-ok");
  await store.acquireWriter();
  await store.close();
  await assert.rejects(stat(join(root, "writer.lock")), { code: "ENOENT" });
});

test("preview_failed closes the comparison session handle before compare returns", async (t) => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => {
    if (!server.listening) resolve();
    else server.close(() => resolve());
  }));
  const comparison = new ComparisonAgent({
    timeoutMs: 0,
    maxRepairAttempts: 0,
    host: new AgentHost({
      createSession: () => ({
        append: async () => "",
        cancel() { server.close(); },
      }),
    }),
  });
  const result = await comparison.compare(context(), [], undefined, undefined, {
    getSubmittedResult: async () => undefined,
    getSubmissionFailure: () => ({
      code: "preview_failed",
      message: "The latest accepted draft was not previewed, digest=68a8bb6bbd4ec963a63fffe2e3592d5ff9af765681514e6feae90c482e3b9b95 revision=2, Call preview_report in the current review turn.",
    }),
    getSubmissionState: () => "digest=68a8bb6bbd4ec963a63fffe2e3592d5ff9af765681514e6feae90c482e3b9b95 revision=2",
  });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.failure.code, "preview_failed");
  assert.equal(server.listening, false);
});

test("the compare process exits after the failure JSON is flushed", async () => {
  const childPath = join(here, "../support/compare-exit-child.js");
  const child = spawn(process.execPath, [childPath], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`compare child stayed alive; stdout=${stdout}`));
    }, 3_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  assert.equal(code, 1);
  assert.match(stdout, /"ok":false/);
  assert.match(stdout, /comparison-failure\.html/);
});
