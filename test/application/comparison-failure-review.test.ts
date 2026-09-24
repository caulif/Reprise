import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startExperiment } from "../../src/application/experiment.js";
import { input, patientPolicy, VerifiedRuntime } from "../codex-experiment-support.js";

test("a failed reviewed draft is not promoted into diagnostics or over the previous report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-failed-draft-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, "README.md"), "source fixture");
  const experimentRoot = join(base.dataDir, "experiments", base.experimentId);
  await mkdir(experimentRoot, { recursive: true });
  const oldReport = "<!doctype html><p>Previously published result</p>";
  await writeFile(join(experimentRoot, "report.html"), oldReport);
  let attemptId = "";
  const result = await startExperiment({ ...base, policy: patientPolicy, comparison: {
    ...base.comparison,
    compare: async (context, tools, audit, signal, options) => {
      attemptId = context.attemptId;
      const drafted = await base.comparison.compare(context, tools, audit, signal, options);
      assert.equal(drafted.status, "completed", JSON.stringify(drafted));
      return { status: "failed", failure: { code: "agent_failure", message: "Fixture failure after review", attempts: 1 } };
    },
  } }).result;
  assert.equal(result.record.outcome.termination.kind, "completed");
  assert.equal(result.comparison.result.status, "failed");
  const body = await readFile(join(experimentRoot, "comparison-attempts", attemptId, "work", "report", "body.html"), "utf8");
  assert.match(body, /Evidence-based narrative/);
  const diagnostic = await readFile(result.reportPath, "utf8");
  assert.match(diagnostic, /报告未发布/);
  assert.doesNotMatch(diagnostic, /Evidence-based narrative/);
  assert.notEqual(result.reportPath, join(experimentRoot, "report.html"));
  assert.equal(await readFile(join(experimentRoot, "report.html"), "utf8"), oldReport);
});
