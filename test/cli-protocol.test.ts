import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_EXIT } from "../src/core/cli-protocol.js";
import { eventEnvelopeChecksum } from "../src/core/identity.js";
import { readExperimentEvents } from "../src/application/experiment-event-read.js";
import { assertExclusiveRunInputs } from "../src/application/experiment-operations.js";
import { CliError } from "../src/application/cli-error.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli/main.js", import.meta.url));

async function spawnCli(args: readonly string[], dataDir?: string) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...(dataDir ? { REPRISE_DATA_DIR: dataDir } : {}) },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

test("exclusive run inputs reject mixed source and scenario", () => {
  assert.throws(() => assertExclusiveRunInputs({ sourceRoot: "a", taskCasePath: "b" }, "scene-1"), CliError);
  assert.throws(() => assertExclusiveRunInputs({}), CliError);
  assert.doesNotThrow(() => assertExclusiveRunInputs({ sourceRoot: "a", taskCasePath: "b" }));
});

test("real CLI subprocess query uses JSON stdout and empty stderr", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-products-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const spawned = await spawnCli(["products", "--json", "--data-dir", dataDir], dataDir);
  assert.equal(spawned.code, CLI_EXIT.ok);
  assert.equal(spawned.stderr.trim(), "");
  const body = JSON.parse(spawned.stdout.trim()) as { schemaVersion: number; ok: boolean; command: string };
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.ok, true);
  assert.equal(body.command, "products");
});

test("real CLI subprocess unknown events ID uses stderr and exit 3", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-spawn-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const spawned = await spawnCli(["events", "--experiment", "no-such-experiment", "--data-dir", dataDir], dataDir);
  assert.equal(spawned.code, CLI_EXIT.not_found);
  assert.match(spawned.stderr, /Unknown experiment/);
  const body = JSON.parse(spawned.stdout.trim()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test("event continuation reads from sequence", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-events-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const experimentRoot = join(dataDir, "experiments", "exp-page");
  await mkdir(experimentRoot, { recursive: true });
  const event = (sequence: number) => {
    const body = {
      schemaVersion: 1, sequence, eventId: `evt-${sequence}`, occurredAt: "2026-09-08T00:00:00.000Z",
      type: "run.attempt_created", payload: {},
    };
    return JSON.stringify({ ...body, checksum: eventEnvelopeChecksum(body) });
  };
  await writeFile(join(experimentRoot, "events.jsonl"), `${event(1)}\n${event(2)}\n${event(3)}\n`);
  const page = await readExperimentEvents({ dataDir, experimentId: "exp-page", fromSequence: 2, limit: 1 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.sequence, 2);
  assert.equal(page.nextSequence, 3);
});

test("history pagination uses stable experiment IDs", async (t) => {
  const { listHistoryPage } = await import("../src/application/experiment-queries.js");
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-page-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual((await listHistoryPage({ dataDir, limit: 1 })).items, []);
});

test("event reader rejects path escape, checksum mismatch, and keeps committed prefix on incomplete tail", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-events-guard-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const experimentRoot = join(dataDir, "experiments", "exp-guard");
  await mkdir(experimentRoot, { recursive: true });
  const body = {
    schemaVersion: 1, sequence: 1, eventId: "evt-1", occurredAt: "2026-09-08T00:00:00.000Z",
    type: "run.attempt_created", payload: { text: "ok" },
  };
  const committed = { ...body, checksum: eventEnvelopeChecksum(body) };
  await writeFile(join(experimentRoot, "events.jsonl"), `${JSON.stringify(committed)}\n`);
  await mkdir(join(dataDir, "outside"), { recursive: true });
  await writeFile(join(dataDir, "outside", "events.jsonl"), `${JSON.stringify(committed)}\n`);
  await assert.rejects(readExperimentEvents({ dataDir, experimentId: "../outside" }), CliError);
  await writeFile(join(experimentRoot, "events.jsonl"), `${JSON.stringify({ ...committed, payload: { text: "tampered" } })}\n`);
  await assert.rejects(readExperimentEvents({ dataDir, experimentId: "exp-guard" }), /checksum/i);
  await writeFile(join(experimentRoot, "events.jsonl"), `${JSON.stringify(committed)}\n{"incomplete":`);
  const prefix = await readExperimentEvents({ dataDir, experimentId: "exp-guard" });
  assert.equal(prefix.events.length, 1);
  assert.equal(prefix.diagnosticCode, "incomplete_tail");
});

test("headless run exits failed when the record failed and does not defer comparison", async (t) => {
  const { runHeadlessCommand } = await import("../src/cli/headless.js");
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-fail-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const task = {
    schemaVersion: 1, caseId: "case-probe", source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "msg-1", role: "user", text: "Synthetic task" },
    transcript: [{ id: "msg-1", role: "user", text: "Synthetic task" }],
    historicalEvents: [], baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "1", importedAt: "2026-09-08T00:00:00Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  };
  const taskPath = join(dataDir, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const outputs: Array<Record<string, unknown>> = [];
  const result = { record: { state: "failed", attempt: { experimentId: "experiment-probe", runId: "run-probe" }, outcome: { termination: { kind: "failed" } } }, comparison: { result: { status: "skipped" } } };
  let deferred = false;
  const workflow = {
    recover: async () => ({
      experimentId: "experiment-probe",
      baseline: {
        mode: "canonical",
        fingerprint: { digest: "a", resources: [], capturedAt: "2026-09-08T00:00:00.000Z" },
        match: "recovered",
        readiness: { runnable: "isolated" },
      },
      recovery: { status: "completed", sessionId: "s", value: { status: "recovered", reportPath: "recovery.md", unresolved: [], evidenceRefs: [] } },
      accept: async () => ({}),
      staging: { recoveryId: "r", caseId: "case-probe", sourceRoot: dataDir, root: dataDir },
    }),
    start: async (request: { deferComparison?: boolean }) => {
      deferred = request.deferComparison === true;
      return { result: Promise.resolve(result) };
    },
  };
  const code = await runHeadlessCommand("run", ["--data-dir", dataDir, "--task-case", taskPath, "--source-root", dataDir, "--jsonl"], {
    stdout: (line) => outputs.push(JSON.parse(line) as Record<string, unknown>),
    stderr: () => {},
  }, { workflow: workflow as never });
  assert.equal(deferred, false);
  assert.equal(code, CLI_EXIT.failed);
  assert.equal(outputs.at(-1)?.ok, false);
});

test("headless run timeout aborts the handle cancel path", async (t) => {
  const { runHeadlessCommand } = await import("../src/cli/headless.js");
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-cli-timeout-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const task = {
    schemaVersion: 1, caseId: "case-timeout", source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "msg-1", role: "user", text: "Synthetic task" },
    transcript: [{ id: "msg-1", role: "user", text: "Synthetic task" }],
    historicalEvents: [], baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "1", importedAt: "2026-09-08T00:00:00Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] }, contentHash: "b".repeat(64),
  };
  const taskPath = join(dataDir, "task.json");
  await writeFile(taskPath, JSON.stringify(task));
  let cancelled = false;
  const workflow = {
    recover: async () => ({
      experimentId: "experiment-timeout",
      baseline: {
        mode: "canonical",
        fingerprint: { digest: "a", resources: [], capturedAt: "2026-09-08T00:00:00.000Z" },
        match: "recovered",
        readiness: { runnable: "isolated" },
      },
      recovery: { status: "completed", sessionId: "s", value: { status: "recovered", reportPath: "recovery.md", unresolved: [], evidenceRefs: [] } },
      accept: async () => ({}),
      staging: { recoveryId: "r", caseId: "case-timeout", sourceRoot: dataDir, root: dataDir },
    }),
    start: async () => {
      let settle: (value: unknown) => void = () => {};
      const result = new Promise((resolve) => { settle = resolve; });
      return {
        activity: { operationId: "op-run-timeout", experimentId: "experiment-timeout", runId: "run-timeout" },
        cancel: async () => {
          cancelled = true;
          settle({ record: { state: "cancelled", attempt: { experimentId: "experiment-timeout", runId: "run-timeout" }, outcome: { termination: { kind: "cancelled" } } }, comparison: { result: { status: "skipped" } } });
        },
        result,
      };
    },
  };
  const code = await runHeadlessCommand("run", ["--data-dir", dataDir, "--task-case", taskPath, "--source-root", dataDir, "--timeout-ms", "20", "--json"], {
    stdout: () => {},
    stderr: () => {},
  }, { workflow: workflow as never });
  assert.equal(cancelled, true);
  assert.equal(code, CLI_EXIT.cancelled);
});

