import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExperimentWorkflow } from "../../src/application/experiment-workflow.js";
import { readLocalHistory } from "../../src/application/experiment-history-list.js";
import { comparePersistedExperiment } from "../../src/application/experiment-compare-persisted.js";
import { createProductLookup } from "../../src/products/index.js";
import { codexProductPack } from "../../src/products/packs/codex/pack.js";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";
import { readCommittedRunEvents } from "../../src/application/experiment-run-history.js";
import { eventEnvelopeChecksum } from "../../src/core/identity.js";
import { input, VerifiedRuntime } from "../codex-experiment-support.js";
import { startExperiment } from "../../src/application/experiment.js";
import { renderHistoryDetail } from "../../src/tui/pages/history.js";
import { createTheme } from "../../src/tui/theme.js";

test("a conflicting admitted task shows its own startup failure and preserves the fixed metadata identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-history-case-conflict-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const first = await startExperiment(base).result;
  const taskCase = { ...base.taskCase, caseId: "case-conflicting", initialInput: { ...base.taskCase.initialInput, text: "Conflicting task B" } };
  await assert.rejects(startExperiment({ ...base, caseId: taskCase.caseId, taskCase, runId: "run-conflicting" }).result, /metadata does not match/);
  const history = await readLocalHistory(base.dataDir);
  const item = history.experiments[0]!;
  assert.equal(item.runId, "run-conflicting");
  assert.equal(item.taskCaseId, taskCase.caseId);
  assert.equal(item.metadataTaskCaseId, base.caseId);
  assert.equal(item.formatError, "metadata_case_mismatch");
  assert.equal(item.outcome, "failed");
  assert.equal(item.startupFailureStage, "checkpoint");
  assert.match(item.startupFailure!, /metadata does not match/);
  assert.equal(item.reportPath, undefined);
  assert.notEqual(item.taskTitle, base.taskCase.initialInput.text);
  const page = renderHistoryDetail(createTheme(120, false), 120, item, "zh").join("\n");
  assert.match(page, /运行任务与实验元数据不一致/);
  assert.match(page, /启动阶段\s+checkpoint/);
  assert.ok(page.includes(`实验元数据任务 ID`));
  assert.ok(page.includes(base.caseId));
  assert.match(page, /metadata does not match/);
  const metadata = JSON.parse(await readFile(join(first.experimentRoot, "experiment.json"), "utf8")) as { spec: { taskCaseId: string } };
  assert.equal(metadata.spec.taskCaseId, base.caseId);
});

for (const cancelled of [false, true]) {
  test(`History shows ${cancelled ? "cancelled" : "failed"} startup even before experiment metadata exists`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "reprise-history-startup-"));
    t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const base = input(root, new VerifiedRuntime());
    await mkdir(base.sourceRoot, { recursive: true });
    const abort = new AbortController();
    const workflow = createExperimentWorkflow({ dataDir: base.dataDir, runtime: base.runtime,
      lookup: createProductLookup([codexProductPack]), now: () => base.now,
      agents: async (signal) => {
        if (cancelled) { abort.abort({ source: "user" }); signal?.throwIfAborted(); }
        throw new Error("fixture agent initialization failed");
      },
    });
    await assert.rejects(workflow.start({ taskCase: base.taskCase, candidate: base.candidate, sourceRoot: base.sourceRoot,
      experimentId: base.experimentId, runId: base.runId, onEvent: () => {}, signal: abort.signal,
    }));
    const path = join(base.dataDir, "experiments", base.experimentId);
    await assert.rejects(readFile(join(path, "experiment.json")), (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT");
    const item = (await readLocalHistory(base.dataDir)).experiments[0]!;
    assert.equal(item.taskCaseId, base.caseId);
    assert.equal(item.runId, base.runId);
    assert.equal(item.startedAt, base.now);
    assert.equal(item.outcome, cancelled ? "cancelled" : "failed");
    assert.equal(item.startupFailureStage, "agents");
    assert.equal(item.formatError, "missing_metadata");
    assert.equal(item.reportPath, undefined);
    const compare = { dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy, now: base.now,
      comparison: base.comparison, agentConfig: base.agentConfig };
    await assert.rejects(comparePersistedExperiment(compare), /Unknown experiment/);
    if (!cancelled) assert.equal(item.startupFailure, "fixture agent initialization failed");
    const page = renderHistoryDetail(createTheme(120, false), 120, item, "zh").join("\n");
    assert.match(page, /启动阶段\s+agents/);
    assert.match(page, /诊断/);
    if (!cancelled) assert.match(page, /fixture agent initialization failed/);
    const { events } = await readCommittedRunEvents(path);
    const committed = events.find((event) => event.type === "run.startup_failed")!;
    const mismatch = events.map((event) => {
      if (event.sequence !== committed.sequence) return event;
      const { checksum: _checksum, ...body } = event;
      body.payload = { ...(body.payload as object), caseId: "other-case" };
      return { ...body, checksum: eventEnvelopeChecksum(body) };
    });
    await writeFile(join(path, "events.jsonl"), mismatch.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const invalid = (await readLocalHistory(base.dataDir)).experiments[0]!;
    assert.equal(invalid.outcome, "interrupted");
    assert.equal(invalid.startupFailureStage, undefined);
  });
}

test("an uncommitted startup failure file cannot retire an admitted attempt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-history-orphan-startup-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const base = input(root, new VerifiedRuntime());
  const path = join(base.dataDir, "experiments", base.experimentId);
  const store = await ExperimentStore.open(path, base.experimentId);
  await store.acquireWriter();
  await store.commitAttempt({ schemaVersion: 1, experimentId: base.experimentId, runId: base.runId, caseId: base.caseId,
    candidate: base.candidate, policy: base.policy, createdAt: base.now });
  await store.close();
  await writeFile(join(path, "runs", base.runId, "startup-failure.json"), JSON.stringify({ schemaVersion: 1,
    experimentId: base.experimentId, runId: base.runId, caseId: base.caseId, stage: "agents", status: "failed",
    error: { name: "Error", message: "uncommitted" }, cleanupErrors: [], recordedAt: base.now }));
  const item = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(item.outcome, "interrupted");
  assert.equal(item.startupFailure, undefined);
});

test("startup failure beside an earlier completed run remains selected without inheriting its completion or report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-history-later-startup-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await startExperiment({ ...base, runId: "run-z-finished" }).result;
  const workflow = createExperimentWorkflow({ dataDir: base.dataDir, runtime: base.runtime,
    lookup: createProductLookup([codexProductPack]), now: () => base.now,
    agents: async () => { throw new Error("fixture later startup failed"); },
  });
  await assert.rejects(workflow.start({ taskCase: base.taskCase, candidate: base.candidate, sourceRoot: base.sourceRoot,
    experimentId: base.experimentId, runId: "run-a-failed", onEvent: () => {},
  }), /fixture later startup failed/);
  const item = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(item.runId, "run-a-failed");
  assert.equal(item.outcome, "failed");
  assert.equal(item.startupFailureStage, "agents");
  assert.equal(item.reportPath, undefined);
  assert.equal(item.comparisonStatus, undefined);
  const request = { dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy, now: base.now,
    comparison: base.comparison, agentConfig: base.agentConfig };
  assert.equal((await comparePersistedExperiment(request)).record.attempt.runId, "run-z-finished");
  await assert.rejects(comparePersistedExperiment({ ...request, runId: "run-a-failed" }), /no finished run/);
});
