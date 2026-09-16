import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildComparisonContext } from "../../src/application/comparison.js";
import {
  comparisonAttemptMounts,
  writeComparisonBriefing,
} from "../../src/application/comparison-briefing.js";
import {
  appendSentUserMessage,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
} from "../../src/application/controller-briefing.js";
import { recoveryEvidenceCatalog } from "../../src/products/history/source-refs.js";
import { workspaceTools } from "../../src/infrastructure/recovery-tools.js";
import type { EventEnvelope, RunRecord, TaskCase } from "../../src/core/schema.js";

const timestamp = "2026-09-10T12:00:00.000Z";

function taskCase(): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-tracks",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "做一份 PPT。" },
    transcript: [
      { id: "message-1", role: "user", text: "做一份 PPT。" },
      { id: "message-2", role: "assistant", text: "历史助手已经写了第一版。" },
      { id: "message-3", role: "user", text: "第二页太空了。" },
    ],
    historicalEvents: [{ type: "tool", summary: "historical agent process: npm test" }],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}

function runRecord(): RunRecord {
  return {
    attempt: {
      schemaVersion: 1,
      runId: "run-tracks",
      experimentId: "experiment-tracks",
      caseId: "case-tracks",
      candidate: { candidateId: "candidate-1", productId: "codex", requestedModel: "gpt-5" },
      policy: { wallClockMs: 1000, maxTargetTurns: 4, maxModelCalls: 4, turnTimeoutMs: 1000, maxConsecutiveNoProgress: 1 },
      createdAt: timestamp,
    },
    state: "finished",
    stageReached: "awaiting_controller",
    outcome: {
      task: { status: "incomplete", evidenceRefs: [] },
      termination: { kind: "limit_reached", code: "limit.turns", initiatedBy: "harness" },
      cleanup: { status: "complete", remainingResourceIds: [], evidenceRefs: [] },
    },
    trace: { experimentId: "experiment-tracks", runId: "run-tracks", firstSequence: 1, lastSequence: 4 },
    artifactRefs: [],
    warnings: [],
  };
}

function envelope(sequence: number, type: string, payload: unknown): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${sequence}`,
    occurredAt: timestamp,
    type,
    payload,
    checksum: "c".repeat(64),
  };
}

test("Comparison Agent can read both tracks from a new attempt root via INDEX mounts", async (t) => {
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-comparison-tracks-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const runId = "run-tracks";
  const briefingRoot = join(experimentRoot, "runs", runId, "controller-briefing");
  const replicaRoot = join(experimentRoot, "environment", "runs", runId);
  const snapshotRoot = join(experimentRoot, "environment", "snapshots", runId);
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-1");
  await mkdir(replicaRoot, { recursive: true });
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(join(snapshotRoot, "workspace-file.txt"), "candidate workspace snapshot\n");
  const caseValue = taskCase();
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: caseValue,
    sourceRootKind: "historical_start",
  });
  await appendSentUserMessage(briefingRoot, { id: "controller-1", text: "做一份 PPT。" });
  await appendSentUserMessage(briefingRoot, { id: "controller-2", text: "请补第二页。" });
  const turnEvents = [
    envelope(1, "runtime.session_started", { sessionId: "sess-1", evidenceRefs: [] }),
    envelope(2, "runtime.turn_settled", { sessionId: "sess-1", turnId: "turn-1", evidenceRefs: [] }),
  ];
  await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 1,
    visibleText: "候选第一轮可见回复",
    events: turnEvents,
    changedPaths: ["workspace-file.txt"],
    allowModelText: true,
    userView: {
      schemaVersion: 1,
      turnIndex: 1,
      status: "completed",
      observedAt: timestamp,
      assistantText: "候选第一轮可见回复",
    },
  });
  await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 2,
    visibleText: "候选第二轮可见回复",
    events: [
      envelope(3, "runtime.turn_settled", { sessionId: "sess-1", turnId: "turn-2", evidenceRefs: [] }),
    ],
    changedPaths: ["workspace-file.txt"],
    allowModelText: true,
    userView: {
      schemaVersion: 1,
      turnIndex: 2,
      status: "completed",
      observedAt: timestamp,
      assistantText: "候选第二轮可见回复",
    },
  });
  const events: EventEnvelope[] = [
    envelope(1, "runtime.session_started", { sessionId: "sess-1", evidenceRefs: [] }),
    envelope(2, "controller.decision", { status: "completed", value: { type: "send", message: "做一份 PPT。" } }),
    envelope(3, "runtime.tool_finished", { sessionId: "sess-1", callId: "call-1", evidenceRefs: [] }),
    envelope(4, "runtime.turn_settled", { sessionId: "sess-1", turnId: "turn-1", evidenceRefs: [] }),
    envelope(5, "controller.decision", { status: "completed", value: { type: "send", message: "请补第二页。" } }),
    envelope(6, "runtime.visible_output", { sessionId: "sess-1", evidenceRefs: [] }),
    envelope(7, "runtime.turn_settled", { sessionId: "sess-1", turnId: "turn-2", evidenceRefs: [] }),
  ];
  const record = runRecord();
  const context = buildComparisonContext(caseValue, [record], [{
    runId,
    changedPaths: ["workspace-file.txt"],
    runtimeGeneratedPaths: [],
    commands: ["npm test"],
    rejectedApprovals: 0,
    turns: 2,
  }]);
  assert.equal(context.candidates.some((candidate) => "summary" in candidate), false);
  assert.equal(context.telemetry.some((row) => "summary" in row), false);
  await writeComparisonBriefing({
    attemptRoot,
    experimentRoot,
    workspaceRoot: snapshotRoot,
    taskCase: caseValue,
    record,
    context,
    events,
    artifacts: [],
    snapshotStatus: "complete",
  });
  await writeFile(join(attemptRoot, "evidence", "artifact-tracks"), "artifact body\n");
  const mounts = comparisonAttemptMounts({
    experimentRoot,
    runId,
    attemptRoot,
    candidateSnapshotStatus: "complete",
    candidateSnapshotRoot: snapshotRoot,
  });
  const tools = workspaceTools(attemptRoot, {
    mounts,
    denyDestructiveOnPrefix: ["candidate", "evidence", "history", "turns", "run", "observations"],
  });
  const reader = tools.find((tool) => tool.name === "read");
  assert.ok(reader);
  const signal = new AbortController().signal;
  const read = async (path: string) => {
    const result = await reader.execute({ path }, signal);
    return result.content;
  };
  const index = await read("INDEX.md");
  assert.match(index, /history\//);
  assert.match(index, /candidate\//);
  const briefingIndex = await read("briefing/INDEX.md");
  assert.match(briefingIndex, /turns\//);
  assert.match(briefingIndex, /run\/sent-user-messages\.jsonl/);
  assert.match(briefingIndex, /briefing\/candidate\/process-index\.tsv/);
  assert.match(await read("turns/0001/user-view.md"), /候选第一轮可见回复/);
  assert.match(await read("turns/0002/user-view.md"), /候选第二轮可见回复/);
  assert.match(await read("run/sent-user-messages.jsonl"), /请补第二页/);
  const userInputs = await read("observations/user-inputs/INDEX.tsv");
  assert.match(userInputs, /historical_user/);
  assert.match(userInputs, /\tcontroller\t/);
  assert.match(await read("observations/user-inputs/message-1.txt"), /做一份 PPT/);
  assert.match(await read(`observations/user-inputs/controller-send-${events[1]!.eventId}.txt`), /做一份 PPT/);
  assert.match(await read(`observations/user-inputs/controller-send-${events[4]!.eventId}.txt`), /请补第二页/);
  assert.match(await read("briefing/candidate/process-index.tsv"), /runtime\.tool_finished/);
  assert.match(await read("briefing/candidate/process-index.tsv"), /runtime\.turn_settled/);
  assert.match(await read("history/outline.tsv"), /message-2/);
  assert.match(await read("history/transcript/message-2.txt"), /历史助手已经写了第一版/);
  assert.match(await read("history/user-inputs/INDEX.tsv"), /message-3/);
  const toolEvent = await read(`observations/events/run/${events[2]!.eventId}.json`);
  assert.match(toolEvent, /runtime\.tool_finished/);
  const historical = recoveryEvidenceCatalog(caseValue).find((entry) => entry.source === "historical_events");
  assert.ok(historical);
  const historicalStem = historical.ref.replace(/^event:/, "").replace(/[^A-Za-z0-9._-]/g, "_");
  assert.match(await read(`observations/events/historical/${historicalStem}.json`), /historical agent process/);
  assert.match(await read("observations/transcript/message-2.json"), /历史助手已经写了第一版/);
  assert.match(await read("evidence/artifact-tracks"), /artifact body/);
  assert.match(await read("candidate/workspace-file.txt"), /candidate workspace snapshot/);
  assert.match(await read("briefing/candidate/SNAPSHOT.txt"), /snapshotStatus=complete/);
  assert.match(await read("briefing/candidate/git-sink-refs.txt"), /status\t/);
  assert.match(await read("briefing/candidate/git-sink-manifest.json"), /schemaVersion/);
});

test("comparison links stay bounded and drop workspace internals", async (t) => {
  const { MAX_COMPARISON_LINKS } = await import("../../src/application/comparison-briefing.js");
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-comparison-links-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const runId = "run-tracks";
  const snapshotRoot = join(experimentRoot, "environment", "snapshots", runId);
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-bound");
  await mkdir(join(snapshotRoot, ".git", "objects"), { recursive: true });
  await mkdir(join(snapshotRoot, "src"), { recursive: true });
  await writeFile(join(snapshotRoot, ".git", "objects", "abc"), "blob\n");
  const delivery: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    const rel = `src/file-${String(index).padStart(3, "0")}.txt`;
    delivery.push(rel);
    await writeFile(join(snapshotRoot, ...rel.split("/")), `body ${index}\n`);
  }
  const internals = [
    ...Array.from({ length: 400 }, (_, index) => `.git/objects/${index}`),
    ...Array.from({ length: 167 }, (_, index) => `pkg/.git/objects/${index}`),
  ];
  const artifacts = Array.from({ length: 70 }, (_, index) => ({
    artifactId: `artifact${String(index).padStart(3, "0")}`,
    schemaVersion: 1,
    kind: "host_trace",
    byteLength: 4,
    contentHash: "a".repeat(64),
    createdAt: timestamp,
    owner: { experimentId: "experiment-tracks", runId },
    sourceEventId: "event-1",
    path: `artifacts/artifact${index}`,
  }));
  const caseValue = taskCase();
  const record = runRecord();
  const context = buildComparisonContext(caseValue, [record], [{
    runId,
    changedPaths: [...internals, ...delivery],
    runtimeGeneratedPaths: [],
    commands: [],
    rejectedApprovals: 0,
    turns: 0,
  }]);
  const briefing = await writeComparisonBriefing({
    attemptRoot,
    experimentRoot,
    workspaceRoot: snapshotRoot,
    taskCase: caseValue,
    record,
    context,
    events: [],
    artifacts,
    snapshotStatus: "complete",
  });
  assert.equal(briefing.links.length <= MAX_COMPARISON_LINKS, true);
  assert.equal(briefing.links.some((link) => link.inspectPath.includes(".git/")), false);
  assert.equal(briefing.links.some((link) => link.path?.startsWith("src/")), true);
  const facts = JSON.parse(await readFile(join(attemptRoot, "briefing", "facts", "context.json"), "utf8")) as {
    reportFacts: { delivery: { changedPaths: string[]; changedPathsIndexed: number; changedPathsOmitted: number } };
  };
  assert.equal(facts.reportFacts.delivery.changedPaths.length <= MAX_COMPARISON_LINKS, true);
  assert.equal(facts.reportFacts.delivery.changedPaths.every((path) => path.startsWith("src/")), true);
  assert.equal(facts.reportFacts.delivery.changedPathsIndexed > 0, true);
  assert.equal(facts.reportFacts.delivery.changedPathsOmitted > 0, true);
  const index = await readFile(join(attemptRoot, "briefing", "INDEX.md"), "utf8");
  assert.match(index, /links-diagnostics\.json/);
  assert.match(index, /changedPathsOmitted=/);
});

test("sealed historical images enter baseline media without a double extension", async (t) => {
  const { comparisonMediaFileName } = await import("../../src/application/comparison-media.js");
  assert.equal(comparisonMediaFileName("candidate--montage.png", ".png"), "candidate--montage.png");
  assert.equal(comparisonMediaFileName("page-1", ".png"), "page-1.png");
  const experimentRoot = await mkdtemp(join(tmpdir(), "reprise-comparison-media-"));
  t.after(() => rm(experimentRoot, { recursive: true, force: true }));
  const runId = "run-tracks";
  const snapshotRoot = join(experimentRoot, "environment", "snapshots", runId);
  const attemptRoot = join(experimentRoot, "comparison-attempts", "attempt-media");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await mkdir(join(experimentRoot, "environment", "baselines"), { recursive: true });
  await mkdir(join(experimentRoot, "runs", runId, "controller-briefing", "history", "transcript"), { recursive: true });
  await mkdir(snapshotRoot, { recursive: true });
  await writeFile(join(experimentRoot, "environment", "baselines", "slide-1.png"), png);
  await writeFile(
    join(experimentRoot, "runs", runId, "controller-briefing", "history", "transcript", "message-2.txt"),
    "预览在 slide-1.png\n",
  );
  const caseValue = taskCase();
  caseValue.baseline.finalMessage = "已导出 slide-1.png";
  const record = runRecord();
  const context = buildComparisonContext(caseValue, [record], [{
    runId, changedPaths: [], runtimeGeneratedPaths: [], commands: [], rejectedApprovals: 0, turns: 0,
  }]);
  const briefing = await writeComparisonBriefing({
    attemptRoot,
    experimentRoot,
    workspaceRoot: snapshotRoot,
    taskCase: caseValue,
    record,
    context,
    events: [],
    artifacts: [],
    snapshotStatus: "complete",
  });
  const baseline = briefing.media.filter((item) => item.side === "baseline");
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0]?.available, true);
  assert.equal(baseline[0]?.reportHref, "media/history-media-slide-1.png");
  assert.doesNotMatch(baseline[0]?.reportHref ?? "", /\.png\.png$/);
});

