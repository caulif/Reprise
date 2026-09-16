import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countTargetModelCalls,
  isExcludedProgressPath,
  nextNoProgressStreak,
  shouldStopForTargetModelCalls,
  TARGET_MODEL_CALL_EVENT_TYPES,
  workspaceProgressFingerprint,
} from "../../src/application/candidate-run-safety.js";

test("target model-call types are the ADR list and Host settlement is not among them", () => {
  assert.deepEqual([...TARGET_MODEL_CALL_EVENT_TYPES], ["runtime.turn_started", "runtime.usage_reported"]);
  assert.equal(TARGET_MODEL_CALL_EVENT_TYPES.includes("runtime.turn_settled" as never), false);
  assert.equal(TARGET_MODEL_CALL_EVENT_TYPES.includes("runtime.delivery_observed" as never), false);
});

test("countTargetModelCalls prefers turn_started and does not double-count usage_reported", () => {
  const mixed = countTargetModelCalls([
    { type: "runtime.session_started" },
    { type: "runtime.turn_started" },
    { type: "runtime.usage_reported" },
    { type: "runtime.turn_started" },
    { type: "runtime.turn_settled" },
  ]);
  assert.deepEqual(mixed, { countable: true, count: 2, countedType: "runtime.turn_started" });
  assert.equal(shouldStopForTargetModelCalls(mixedEvents(2), 2), true);
  assert.equal(shouldStopForTargetModelCalls(mixedEvents(1), 2), false);
});

test("countTargetModelCalls falls back to usage_reported when turn_started is absent", () => {
  const usage = countTargetModelCalls([
    { type: "runtime.usage_reported" },
    { type: "runtime.visible_output" },
    { type: "runtime.usage_reported" },
  ]);
  assert.deepEqual(usage, { countable: true, count: 2, countedType: "runtime.usage_reported" });
  assert.equal(shouldStopForTargetModelCalls(usageEvents(2), 2), true);
});

test("a Runtime journal with no model-call events is not truncated", () => {
  const events = [
    { type: "runtime.session_started" },
    { type: "runtime.delivery_observed" },
    { type: "runtime.turn_settled" },
    { type: "runtime.visible_output" },
  ];
  assert.deepEqual(countTargetModelCalls(events), { countable: false, count: 0, countedType: undefined });
  assert.equal(shouldStopForTargetModelCalls(events, 1), false);
});

test("progress fingerprint excludes .reprise and is stable until a non-reprise file changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-progress-fp-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "README.md"), "alpha\n");
  await mkdir(join(root, ".reprise", "recovery-work"), { recursive: true });
  await writeFile(join(root, ".reprise", "recovery-work", "scratch.txt"), "scratch-1");
  const first = await workspaceProgressFingerprint(root);
  await writeFile(join(root, ".reprise", "recovery-work", "scratch.txt"), "scratch-2");
  assert.equal(await workspaceProgressFingerprint(root), first);
  await writeFile(join(root, "README.md"), "beta\n");
  const changed = await workspaceProgressFingerprint(root);
  assert.notEqual(changed, first);
  assert.equal(isExcludedProgressPath(".reprise"), true);
  assert.equal(isExcludedProgressPath(".reprise/recovery-work/scratch.txt"), true);
  assert.equal(isExcludedProgressPath("README.md"), false);
});

test("in-tree symlink content is hashed; out-of-tree symlink is omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-progress-link-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "target.txt"), "inside\n");
  await symlink("target.txt", join(root, "link.txt"));
  const withLink = await workspaceProgressFingerprint(root);
  await writeFile(join(root, "target.txt"), "inside-changed\n");
  assert.notEqual(await workspaceProgressFingerprint(root), withLink);
});

test("no-progress streak increments on identical digests and resets on change", () => {
  assert.equal(nextNoProgressStreak(undefined, "aaa", 0), 0);
  assert.equal(nextNoProgressStreak("aaa", "aaa", 0), 1);
  assert.equal(nextNoProgressStreak("aaa", "aaa", 1), 2);
  assert.equal(nextNoProgressStreak("aaa", "bbb", 2), 0);
  assert.equal(nextNoProgressStreak("bbb", "bbb", 0), 1);
});

function mixedEvents(started: number): { type: string }[] {
  return [
    { type: "runtime.turn_started" },
    { type: "runtime.usage_reported" },
    ...Array.from({ length: started - 1 }, () => ({ type: "runtime.turn_started" })),
  ];
}

function usageEvents(count: number): { type: string }[] {
  return Array.from({ length: count }, () => ({ type: "runtime.usage_reported" }));
}
