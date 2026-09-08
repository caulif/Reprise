import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBriefingOutsideReplica,
  controllerPromptContent,
  outlineRows,
  renderIndexMarkdown,
  renderOutlineTsv,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
} from "../src/application/controller-briefing.js";
import type { TaskCase } from "../src/core/schema.js";

const timestamp = "2026-09-03T00:00:00.000Z";

function taskCase(textAfter: string): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-1",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "做一份 PPT HTML。" },
    transcript: [
      { id: "message-1", role: "user", text: "做一份 PPT HTML。" },
      { id: "message-2", role: "assistant", text: "已生成第一版。" },
      { id: "message-3", role: "user", text: textAfter },
    ],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: timestamp, sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
}

test("outline marks user lines after the first non-empty assistant text", () => {
  const rows = outlineRows(taskCase("第二页太空了。").transcript);
  assert.equal(rows[0]?.afterFirstDeliverable, false);
  assert.equal(rows[1]?.afterFirstDeliverable, false);
  assert.equal(rows[2]?.afterFirstDeliverable, true);
  assert.match(renderOutlineTsv(rows), /\t1\n$/);
});

test("INDEX lists transcript directory and project mount prefix", () => {
  assert.match(renderIndexMarkdown(undefined), /history\/transcript\/\{id\}\.txt/);
  assert.match(renderIndexMarkdown("run/turns/0001"), /project\//);
  assert.match(renderIndexMarkdown("run/turns/0001"), /run\/turns\/0001/);
  assert.match(renderIndexMarkdown(undefined), /imported-inputs/);
});

test("opening briefing lives outside the replica and opening prompt omits later user text", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  const marker = "MARKER_AFTER_DELIVERABLE";
  const written = await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: taskCase(marker),
    sourceRootKind: "historical_start",
  });
  const indexOnDisk = await readFile(join(briefingRoot, "INDEX.md"), "utf8");
  assert.equal(indexOnDisk, written.indexMarkdown);
  assert.doesNotMatch(indexOnDisk, new RegExp(marker));
  const prompt = controllerPromptContent({
    phase: "opening",
    briefingRoot,
    indexMarkdown: written.indexMarkdown,
  });
  assert.match(indexOnDisk, /historical user requirements/);
  assert.match(indexOnDisk, /historical agent discoveries/);
  assert.match(indexOnDisk, /current candidate facts/);
  assert.match(prompt, /INDEX\.md/);
  assert.match(prompt, /history\/initial-input\.txt/);
  assert.match(prompt, /first Invocation/);
  assert.doesNotMatch(indexOnDisk, /controller-understanding/);
  assert.doesNotMatch(prompt, /understandingDelta/);
  assert.doesNotMatch(prompt, new RegExp(marker));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(join(replicaRoot, "INDEX.md")), false);
  await assert.rejects(
    () => writeOpeningBriefing({
      briefingRoot: join(replicaRoot, "controller-briefing"),
      replicaRoot,
      taskCase: taskCase(marker),
      sourceRootKind: "historical_start",
    }),
    /must not be written inside the isolated replica/,
  );
  const manifest = JSON.parse(await readFile(join(briefingRoot, "manifest.json"), "utf8")) as { files: { path: string; bytes: number; digest: string }[] };
  const initial = manifest.files.find((file) => file.path === "history/initial-input.txt");
  assert.ok(initial);
  assert.equal(initial.bytes > 0, true);
  assert.match(initial.digest, /^[a-f0-9]{64}$/);
});

test("assertBriefingOutsideReplica rejects a briefing nested in the replica", () => {
  assert.throws(
    () => assertBriefingOutsideReplica(join("C:", "work", "replica", "briefing"), join("C:", "work", "replica")),
    /must not be written inside the isolated replica/,
  );
  assert.doesNotThrow(() =>
    assertBriefingOutsideReplica(join("C:", "work", "replica2", "briefing"), join("C:", "work", "replica")),
  );
});

test("settled-turn digest changes when visible.txt changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-digest-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: taskCase("第二页太空了。"),
    sourceRootKind: "historical_start",
  });
  const first = await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 1,
    visibleText: "first pass html",
    events: [],
    changedPaths: ["out.html"],
    allowModelText: true,
  });
  const second = await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 1,
    visibleText: "second pass html",
    events: [],
    changedPaths: ["out.html"],
    allowModelText: true,
  });
  assert.notEqual(first.fileDigests["run/turns/0001/visible.txt"], second.fileDigests["run/turns/0001/visible.txt"]);
  assert.match(await readFile(join(briefingRoot, "run/turns/0001/event-index.tsv"), "utf8"), /sequence\ttype\tevent_id\tmodel_visible/);
});

test("Controller tools read briefing history and deny writes under project/", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-tools-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: taskCase("第二页太空了。"),
    sourceRootKind: "historical_start",
  });
  const { recoveryTools } = await import("../src/infrastructure/recovery-tools.js");
  const tools = recoveryTools(briefingRoot, {
    allowWrite: () => false,
    mounts: { project: replicaRoot },
  });
  assert.equal(tools.some((tool) => tool.name === "read_observation"), false);
  const read = tools.find((tool) => tool.name === "read");
  const write = tools.find((tool) => tool.name === "write");
  assert.ok(read);
  assert.ok(write);
  const signal = new AbortController().signal;
  const history = await read.execute({ path: "history/initial-input.txt" }, signal);
  assert.match(history.content, /PPT HTML/);
  await assert.rejects(
    () => write.execute({ path: "project/injected.txt", content: "no" }, signal),
    /write_denied/,
  );
});

