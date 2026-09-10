import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contaminationWarnings,
  detectContamination,
} from "../../src/environment/contamination.js";
import type { TaskCase } from "../../src/core/schema.js";
const exec = promisify(execFile);
const now = "2026-08-11T12:00:00.000Z";
function task(commit: string): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "contamination-case",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message", role: "user", text: "task" },
    transcript: [{ id: "message", role: "user", text: "task" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    taskContext: { historicalCommit: commit },
    provenance: {
      packVersion: "test",
      importedAt: now,
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}
test("contamination detects same, ancestor, diverged and missing git histories", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-contamination-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "test@example.invalid"]);
    await git(root, ["config", "user.name", "Test"]);
    await writeFile(join(root, "file.txt"), "one");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "one"]);
    const first = (await git(root, ["rev-parse", "HEAD"])).trim();
    assert.equal(
      (await detectContamination(root, task(first))).git?.relation,
      "same",
    );
    await writeFile(join(root, "file.txt"), "two");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "two"]);
    const second = (await git(root, ["rev-parse", "HEAD"])).trim();
    assert.equal(
      (await detectContamination(root, task(first))).git?.relation,
      "ancestor",
    );
    await git(root, ["checkout", "-b", "diverged", first]);
    await writeFile(join(root, "file.txt"), "alternate");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "alternate"]);
    assert.equal(
      (await detectContamination(root, task(second))).git?.relation,
      "diverged",
    );
    assert.equal(
      (await detectContamination(root, task("f".repeat(40)))).git?.relation,
      "missing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contamination detects newer source timestamps and historical artifacts with matching warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-contamination-evidence-"));
  try {
    const artifactId = "historical-baseline.json";
    await writeFile(join(root, artifactId), "{}");
    const taskCase: TaskCase = {
      ...task(""),
      historicalEvents: [{ timestamp: "2020-01-01T00:00:00.000Z" }],
      baseline: {
        ...task("").baseline,
        artifactRefs: [{ artifactId, caseId: "contamination-case" }],
      },
    };
    const signals = await detectContamination(root, taskCase);
    assert.equal(signals.timeline?.sessionEndedAt, "2020-01-01T00:00:00.000Z");
    assert.deepEqual(signals.baselineArtifactsPresent, [artifactId]);
    assert.deepEqual(contaminationWarnings(signals), [
      "The selected directory was modified after the historical session ended; it may contain the completed task result.",
      `Historical baseline artifacts are present in the selected directory: ${artifactId}.`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
