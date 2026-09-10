import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBriefingOutsideReplica,
  controllerPromptContent,
  controllerViewSurface,
  outlineRows,
  renderIndexMarkdown,
  renderOutlineTsv,
  writeOpeningBriefing,
  writeSettledTurnBriefing,
  stageSettledTurnBriefing,
} from "../../src/application/controller-briefing.js";
import type { TaskCase } from "../../src/core/schema.js";

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

test("view surface maps settlement without leaking Host diagnostics", () => {
  assert.equal(controllerViewSurface("waiting_input", "ok?", true), "waiting");
  assert.equal(controllerViewSurface("failed", "error", true), "failed");
  assert.equal(controllerViewSurface("aborted", "stop", true), "aborted");
  assert.equal(controllerViewSurface("completed", "", true), "empty");
  assert.equal(controllerViewSurface("completed", "done", false), "unavailable");
});

test("INDEX lists transcript directory and project mount prefix", () => {
  assert.match(renderIndexMarkdown(undefined), /history\/transcript\/\{id\}\.txt/);
  assert.match(renderIndexMarkdown("run/turns/0001"), /project\//);
  assert.match(renderIndexMarkdown("run/turns/0001"), /run\/turns\/0001/);
  assert.match(renderIndexMarkdown(undefined), /imported-inputs/);
  assert.match(renderIndexMarkdown(undefined), /current-user-view\.md/);
  assert.doesNotMatch(renderIndexMarkdown(undefined), /view\.txt/);
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
  const userIndex = await readFile(join(briefingRoot, "history", "user-inputs", "INDEX.tsv"), "utf8");
  assert.match(userIndex, /^turn_id\torder\trole\tsource\tpath\tattachments\trelated\n/);
  assert.match(userIndex, /message-1\t1\tuser\thistorical_user\thistory\/user-inputs\/message-1\.txt/);
  assert.match(userIndex, /message-3\t2\tuser\thistorical_user/);
  assert.doesNotMatch(userIndex, new RegExp(marker));
  const firstUser = await readFile(join(briefingRoot, "history", "user-inputs", "message-1.txt"), "utf8");
  assert.match(firstUser, /PPT HTML/);
  const laterUser = await readFile(join(briefingRoot, "history", "user-inputs", "message-3.txt"), "utf8");
  assert.match(laterUser, new RegExp(marker));
  const view = await readFile(join(briefingRoot, "current-user-view.md"), "utf8");
  assert.match(view, /status=empty/);
  assert.match(view, /# Assistant\n\(empty\)/);
  assert.match(indexOnDisk, /current-user-view\.md/);
  assert.doesNotMatch(indexOnDisk, /view\.txt/);
  const permissions = await readFile(join(briefingRoot, "permissions.txt"), "utf8");
  assert.match(permissions, /controller\.writes=denied/);
  assert.match(permissions, /candidate\.writes=unconfirmed/);
  assert.match(permissions, /candidate\.source=unconfirmed/);
  assert.match(permissions, /privacy\.allowModelText=1/);
  assert.doesNotMatch(permissions, /^writes=denied$/m);
  assert.match(indexOnDisk, /Historical agent discoveries/);
  assert.match(indexOnDisk, /Current candidate facts/);
  assert.match(prompt, /INDEX\.md/);
  assert.match(prompt, /history\/initial-input\.txt/);
  assert.match(prompt, /第一条自然用户消息/);
  assert.doesNotMatch(indexOnDisk, /controller-understanding/);
  assert.doesNotMatch(prompt, /understandingDelta/);
  assert.doesNotMatch(prompt, new RegExp(marker));
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
  assert.notEqual(first.fileDigests["current-user-view.md"], second.fileDigests["current-user-view.md"]);
  assert.match(await readFile(join(briefingRoot, "current-user-view.md"), "utf8"), /second pass html/);
  assert.match(await readFile(join(briefingRoot, "current-user-view.md"), "utf8"), /status=completed/);
  assert.match(await readFile(join(briefingRoot, "current-user-view.md"), "utf8"), /# Prompt\n\(none\)/);
  assert.equal(existsSync(join(briefingRoot, "view.txt")), false);
  assert.match(await readFile(join(briefingRoot, "run/turns/0001/event-index.tsv"), "utf8"), /sequence\ttype\tevent_id\tmodel_visible/);
  assert.match(await readFile(join(briefingRoot, "run/turns/0001/user-view.md"), "utf8"), /status=completed/);
  assert.match(await readFile(join(briefingRoot, "current-user-view.md"), "utf8"), /second pass html/);
});

test("staging a settled turn does not replace the previous live Controller view", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-interrupt-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: taskCase("第二页太空了。"),
    sourceRootKind: "historical_start",
  });
  const openingView = await readFile(join(briefingRoot, "current-user-view.md"), "utf8");
  const openingThisTurn = await readFile(join(briefingRoot, "THIS-TURN.txt"), "utf8");
  await stageSettledTurnBriefing({
    briefingRoot,
    turnIndex: 1,
    visibleText: "partial html",
    events: [],
    changedPaths: ["out.html"],
    allowModelText: true,
  });
  assert.equal(await readFile(join(briefingRoot, "current-user-view.md"), "utf8"), openingView);
  assert.equal(await readFile(join(briefingRoot, "THIS-TURN.txt"), "utf8"), openingThisTurn);
  assert.match(await readFile(join(briefingRoot, "run/turns/0001/user-view.md"), "utf8"), /partial html/);
});

test("permissions.txt keeps Controller tools read-only when the historical candidate had full access", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-perm-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  const historical = taskCase("第二页太空了。");
  historical.taskContext = { sandbox: "danger-full-access", approvalPolicy: "on-request" };
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: historical,
    sourceRootKind: "historical_start",
  });
  const permissions = await readFile(join(briefingRoot, "permissions.txt"), "utf8");
  assert.match(permissions, /controller\.writes=denied/);
  assert.match(permissions, /candidate\.source=historical_session/);
  assert.match(permissions, /candidate\.sandbox=danger-full-access/);
  assert.match(permissions, /candidate\.writes=allowed/);
  assert.match(permissions, /candidate\.approvalPolicy=on-request/);
});

test("settled view snapshot includes the turn prompt without previous-turn assistant text", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-briefing-prompt-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  await writeOpeningBriefing({
    briefingRoot,
    replicaRoot,
    taskCase: taskCase("第二页太空了。"),
    sourceRootKind: "historical_start",
  });
  await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 2,
    visibleText: "",
    events: [],
    changedPaths: [],
    allowModelText: true,
    surface: "waiting",
    prompt: "Allow the candidate to run git push?",
  });
  const view = await readFile(join(briefingRoot, "current-user-view.md"), "utf8");
  assert.match(view, /status=waiting/);
  assert.match(view, /# Assistant\n\(empty\)/);
  assert.match(view, /Allow the candidate to run git push\?/);
  assert.doesNotMatch(view, /first pass html/);
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
  const { recoveryTools } = await import("../../src/infrastructure/recovery-tools.js");
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

