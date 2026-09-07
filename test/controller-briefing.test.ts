import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
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
  writeControllerUnderstanding,
  applyControllerUnderstandingDelta,
  readControllerPendingActions,
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
  assert.match(prompt, /INDEX\.md/);
  assert.match(prompt, /history\/initial-input\.txt/);
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

test("writes the Controller task understanding into the Host-owned briefing", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-understanding-"));
  const path = await writeControllerUnderstanding(root, {
    markdown: "用户先要 HTML，后续要求 PPT。",
    sourceMessageIds: ["message-1", "message-350"],
    unresolvedActions: ["新建 PPT"],
  });
  const body = await readFile(path, "utf8");
  assert.match(body, /message-350/);
  assert.match(body, /新建 PPT/);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as { files: { path: string }[] };
  assert.equal(manifest.files.some((file) => file.path === "controller-task-understanding.md"), true);
  await applyControllerUnderstandingDelta(root, { mode: "merge", confirmedFacts: ["用户要求可直接阅读"], acceptanceSignals: ["会检查原始产物"], unresolvedActions: [] });
  const updated = await readFile(path, "utf8");
  assert.match(updated, /用户要求可直接阅读/);
  await applyControllerUnderstandingDelta(root, { mode: "replace", unresolvedActions: ["重新检查"] });
  assert.doesNotMatch(await readFile(path, "utf8"), /新建 PPT/);
  assert.match(await readFile(path, "utf8"), /重新检查/);
});

test('understanding ledger preserves merge semantics, clears replace, and rejects corruption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-ledger-integrity-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeControllerUnderstanding(root, { markdown: 'Deliver slides.', sourceMessageIds: ['m1'], unresolvedActions: ['slides', 'sources', 'slides'] });
  await applyControllerUnderstandingDelta(root, { mode: 'merge', unresolvedActions: [] });
  assert.deepEqual(await readControllerPendingActions(root), ['slides', 'sources']);
  await applyControllerUnderstandingDelta(root, { mode: 'replace', unresolvedActions: [] });
  assert.deepEqual(await readControllerPendingActions(root), []);
  const contract = JSON.parse(await readFile(join(root, 'controller-contract.json'), 'utf8')) as { nodes: unknown[] };
  assert.deepEqual(contract.nodes, []);
  for (const corrupt of ['{', '{"schemaVersion":1,"unresolvedActions":[]}']) {
    await writeFile(join(root, 'controller-understanding.json'), corrupt);
    await assert.rejects(readControllerPendingActions(root));
    await assert.rejects(applyControllerUnderstandingDelta(root, { mode: 'replace', unresolvedActions: [] }));
    assert.equal(await readFile(join(root, 'controller-understanding.json'), 'utf8'), corrupt);
  }
});

test('ledger remains authoritative after a projection write fails and an idempotent retry rebuilds it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-ledger-rebuild-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const bodyPath = await writeControllerUnderstanding(root, { markdown: 'Deliver slides.', sourceMessageIds: ['m1'], unresolvedActions: ['slides'] });
  await rm(bodyPath);
  await mkdir(bodyPath);
  await assert.rejects(applyControllerUnderstandingDelta(root, { mode: 'replace', unresolvedActions: [] }));
  assert.deepEqual(await readControllerPendingActions(root, true), []);
  await rm(bodyPath, { recursive: true });
  await rm(join(root, 'controller-contract.json'));
  await applyControllerUnderstandingDelta(root, { mode: 'merge' });
  assert.match(await readFile(bodyPath, 'utf8'), /## Unresolved actions\n- \(none\)/);
  const contract = JSON.parse(await readFile(join(root, 'controller-contract.json'), 'utf8')) as { nodes: unknown[] };
  assert.deepEqual(contract.nodes, []);
  await rm(join(root, 'controller-understanding.json'));
  await assert.rejects(readControllerPendingActions(root, true), { code: 'ENOENT' });
  assert.equal(await readControllerPendingActions(root), undefined);
});
