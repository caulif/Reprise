import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRun } from "../../src/application/controller-queries.js";
import { writeOpeningBriefing, writeSettledTurnBriefing } from "../../src/application/controller-briefing.js";
import { claudeCodeProductPack } from "../../src/products/packs/claude-code/pack.js";
import { codexProductPack } from "../../src/products/packs/codex/pack.js";
import { fakeProductPack } from "../fixtures/fake-pack/pack.js";
import { joinPublicAssistantSurface, projectUserVisibleTurn } from "../../src/products/contract.js";
import type { EventEnvelope, RunRecord, TaskCase } from "../../src/core/schema.js";
import type { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";

const NARRATION = "short narration";
const ESSAY = "long public essay body that must remain on the user surface";
const CLOSING = "three tasks are closed";

function envelope(type: string, payload: unknown, sequence: number): EventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    eventId: `event-${sequence}`,
    occurredAt: "2026-09-10T00:00:00.000Z",
    type,
    runId: "run-1",
    payload,
    checksum: "a".repeat(64),
  };
}

test("joinPublicAssistantSurface concatenates trimmed public texts", () => {
  const surface = joinPublicAssistantSurface([NARRATION, ESSAY, CLOSING]);
  assert.equal(surface, `${NARRATION}\n\n${ESSAY}\n\n${CLOSING}`);
  assert.notEqual(surface, CLOSING);
});

test("Claude projection keeps every public text on the turn surface and last-only as finalMessage", () => {
  const events = [
    envelope("runtime.visible_output", {
      message: { content: [{ type: "text", text: NARRATION }, { type: "thinking", thinking: "hidden" }] },
    }, 1),
    envelope("runtime.visible_output", {
      message: { content: [{ type: "text", text: ESSAY }, { type: "tool_use", name: "Bash", input: { command: "echo" } }] },
    }, 2),
    envelope("runtime.visible_output", {
      message: { content: [{ type: "text", text: CLOSING }] },
    }, 3),
    envelope("runtime.turn_settled", { status: "completed", turnId: "t1" }, 4),
  ];
  const facts = claudeCodeProductPack.projection.inspectRunFacts(events);
  assert.deepEqual(facts.assistantTexts, [NARRATION, ESSAY, CLOSING]);
  assert.equal(facts.finalMessage, CLOSING);
  const view = claudeCodeProductPack.projection.projectTurn({
    turnIndex: 1,
    settlement: { turnId: "t1", status: "completed", observedAt: "2026-09-10T00:00:00.000Z", confidence: "native", rawRefs: [] },
    events,
    allowModelText: true,
  });
  assert.equal(view.assistantText, `${NARRATION}\n\n${ESSAY}\n\n${CLOSING}`);
  assert.doesNotMatch(view.assistantText ?? "", /hidden/);
  assert.notEqual(view.assistantText, CLOSING);
});

test("Codex and fake projections join ordered agent messages", () => {
  const codexEvents = [
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: NARRATION } }, 1),
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: ESSAY } }, 2),
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: CLOSING } }, 3),
  ];
  const codexFacts = codexProductPack.projection.inspectRunFacts(codexEvents);
  assert.equal(codexFacts.finalMessage, CLOSING);
  assert.equal(joinPublicAssistantSurface(codexFacts.assistantTexts), `${NARRATION}\n\n${ESSAY}\n\n${CLOSING}`);
  const fakeFacts = fakeProductPack.projection.inspectRunFacts([
    envelope("runtime.visible_output", { text: NARRATION }, 1),
    envelope("runtime.visible_output", { text: CLOSING }, 2),
  ]);
  assert.equal(fakeFacts.finalMessage, CLOSING);
  assert.equal(joinPublicAssistantSurface(fakeFacts.assistantTexts), `${NARRATION}\n\n${CLOSING}`);
});

test("projectUserVisibleTurn does not treat last-only as the completed surface", () => {
  const view = projectUserVisibleTurn({
    turnIndex: 1,
    settlement: { status: "completed", observedAt: "2026-09-10T00:00:00.000Z" },
    facts: { assistantTexts: [NARRATION, CLOSING], finalMessage: CLOSING, commands: [], rejectedApprovals: 0, evidenceEvents: [] },
    allowModelText: true,
  });
  assert.notEqual(view.assistantText, CLOSING);
  assert.match(view.assistantText ?? "", new RegExp(NARRATION));
});

test("Controller turnVisibleText and briefing files keep the joined surface", async () => {
  const events = [
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: NARRATION } }, 1),
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: ESSAY } }, 2),
    envelope("runtime.visible_output", { item: { type: "agentMessage", text: CLOSING } }, 3),
    envelope("runtime.turn_settled", { status: "completed", turnId: "t1" }, 4),
  ];
  const observation = await inspectRun(
    { events: () => events } as unknown as ExperimentStore,
    { attempt: { runId: "run-1" }, artifactRefs: [] } as unknown as RunRecord,
    true,
    "codex",
  );
  assert.equal(observation.finalMessage, CLOSING);
  assert.equal(observation.turnVisibleText, `${NARRATION}\n\n${ESSAY}\n\n${CLOSING}`);
  assert.notEqual(observation.turnVisibleText, CLOSING);
  const root = await mkdtemp(join(tmpdir(), "reprise-surface-briefing-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(replicaRoot, { recursive: true });
  const task: TaskCase = {
    schemaVersion: 1,
    caseId: "case-1",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-1", role: "user", text: "task" },
    transcript: [{ id: "message-1", role: "user", text: "task" }],
    historicalEvents: [],
    baseline: { status: "available", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: { packVersion: "test", importedAt: "2026-09-10T00:00:00.000Z", sourceHash: "a".repeat(64) },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
  };
  await writeOpeningBriefing({ briefingRoot, replicaRoot, taskCase: task, sourceRootKind: "historical_start" });
  await writeSettledTurnBriefing({
    briefingRoot,
    turnIndex: 1,
    visibleText: observation.turnVisibleText ?? "",
    events,
    changedPaths: [],
    allowModelText: true,
    surface: "completed",
    ...(observation.userView ? { userView: observation.userView } : {}),
  });
  const userView = await readFile(join(briefingRoot, "run/turns/0001/user-view.md"), "utf8");
  const visible = await readFile(join(briefingRoot, "run/turns/0001/visible.txt"), "utf8");
  assert.match(userView, new RegExp(NARRATION));
  assert.match(userView, new RegExp(ESSAY));
  assert.match(visible, new RegExp(NARRATION));
  assert.notEqual(visible.trim(), CLOSING);
});
