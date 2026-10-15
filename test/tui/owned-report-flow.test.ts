import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExperiment } from "../../src/application/experiment.js";
import { comparePersistedExperiment } from "../../src/application/experiment-compare-persisted.js";
import { readLocalHistory } from "../../src/application/experiment-history-list.js";
import { historyExperimentFromResult } from "../../src/application/history-result-facts.js";
import { sealComparisonReport } from "../../src/application/comparison-report-ownership.js";
import { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";
import { deriveResultPresentationFromHistory } from "../../src/tui/display-state.js";
import { assertExperimentReportPath, openExperimentReport } from "../../src/tui/open-report.js";
import { historyDetailPointerAction, renderHistoryDetailWithHits } from "../../src/tui/pages/history.js";
import { createTheme } from "../../src/tui/theme.js";
import { input, VerifiedRuntime } from "../codex-experiment-support.js";

test("live and reopened attempt-owned success and failure reports retain report clicks and opener paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-owned-ui-"));
  t.after(async () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  const first = await startExperiment(base).result;
  const failed = await comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy, now: base.now, agentConfig: base.agentConfig,
    comparison: { compare: async () => ({ status: "cancelled" }), cancel: async () => {} },
  });
  for (const [result, kind] of [[first, "report"], [failed, "diagnostic"]] as const) {
    const live = historyExperimentFromResult(result, { experimentRoot: result.experimentRoot, taskCaseId: base.caseId });
    assert.equal(deriveResultPresentationFromHistory(live, "en").reportKind, kind);
    const displayed = result === failed ? (await readLocalHistory(base.dataDir)).experiments[0]! : live;
    assert.equal(displayed.reportPath, result.reportPath);
    const rendered = renderHistoryDetailWithHits(createTheme(180, false), 180, displayed, "en");
    let reportClick = false;
    for (const [row, hits] of rendered.rowHits) for (const hit of hits) if (hit.path === result.reportPath) {
      assert.deepEqual(historyDetailPointerAction(rendered.lines, row, hit.x0, displayed, rendered.rowHits), { action: "open-report", reportPath: result.reportPath });
      reportClick = true;
    }
    assert.equal(reportClick, true);
    const child = Object.assign(new EventEmitter(), { unref() {} });
    let invokedPath: string | undefined;
    await openExperimentReport(result.experimentRoot, result.reportPath, (_command, args) => {
      invokedPath = args.at(-1);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    assert.equal(invokedPath, result.reportPath);
    assert.throws(() => assertExperimentReportPath(result.experimentRoot, join(result.experimentRoot, "artifacts", result.reportPath.split(/[\\/]/).pop()!)), /selected experiment/);
  }
  const sourceArtifact = join(root, "delivery.html");
  assert.deepEqual(historyDetailPointerAction(["source"], 0, 1, undefined, new Map([[0, [{ x0: 0, x1: 6, path: sourceArtifact }]]])), { action: "open-local" });
  const unknownArtifact = join(first.experimentRoot, "report-unknown.html");
  const current = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.deepEqual(historyDetailPointerAction(["source"], 0, 1, current, new Map([[0, [{ x0: 0, x1: 6, path: unknownArtifact }]]])), { action: "open-local" });
  assert.equal(first.comparison.result.status, "completed");
  if (first.comparison.result.status !== "completed") throw new Error("Fixture comparison did not finish.");
  const attemptId = "manual-attempt";
  const attemptRoot = join(first.experimentRoot, "comparison-attempts", attemptId);
  await mkdir(attemptRoot);
  const record = await sealComparisonReport({ experimentRoot: first.experimentRoot, attemptRoot,
    owner: { experimentId: base.experimentId, runId: base.runId, attemptId }, comparison: first.comparison.result, reportPath: first.reportPath });
  const store = await ExperimentStore.open(first.experimentRoot, base.experimentId);
  await store.acquireWriter();
  const { comparison, ...reportOwner } = record;
  await store.append({ type: "comparison.started", runId: base.runId, payload: { attemptId } });
  await store.append({ type: "comparison.completed", runId: base.runId, payload: { attemptId, ...comparison } });
  const genericPath = join(first.experimentRoot, record.report.path);
  await store.append({ type: "report.created", runId: base.runId, payload: { path: genericPath, attemptId, reportOwner } });
  await store.close();
  const generic = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(generic.reportPath, genericPath);
  assert.equal(generic.reportAttemptUnconfirmed, undefined);
  const genericRendered = renderHistoryDetailWithHits(createTheme(180, false), 180, generic, "en");
  const hit = [...genericRendered.rowHits].flatMap(([row, hits]) => hits.filter(item => item.path === genericPath).map(item => ({ row, ...item })))[0]!;
  assert.deepEqual(historyDetailPointerAction(genericRendered.lines, hit.row, hit.x0, generic, genericRendered.rowHits), { action: "open-report", reportPath: genericPath });
  let opened: string | undefined;
  const child = Object.assign(new EventEmitter(), { unref() {} });
  await openExperimentReport(first.experimentRoot, genericPath, (_command, args) => {
    opened = args.at(-1); queueMicrotask(() => child.emit("spawn")); return child;
  });
  assert.equal(opened, genericPath);
});
