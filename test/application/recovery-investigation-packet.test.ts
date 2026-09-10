import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRecoveryInvestigationPacket,
  INVESTIGATION_PACKET_MAX_PATHS,
} from "../../src/application/recovery/investigation-packet.js";
import type { TaskCase } from "../../src/core/schema.js";

function taskCase(overrides: Partial<TaskCase> = {}): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-packet",
    createdAt: "2026-08-31T00:00:00.000Z",
    productId: "codex",
    source: { productId: "codex", sessionId: "session-1" },
    initialInput: { id: "message-2", role: "user", text: "Write foo.html for the briefing." },
    transcript: [
      { id: "message-1", role: "user", text: "# AGENTS.md\nFollow the repo agents file." },
      { id: "message-2", role: "user", text: "Write foo.html for the briefing." },
      { id: "message-3", role: "assistant", text: "Created foo.html" },
      { id: "message-4", role: "user", text: "Also export slides.pptx" },
    ],
    historicalEvents: [{ type: "file", path: "foo.html" }],
    artifacts: [],
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "a".repeat(64),
    ...overrides,
  } as TaskCase;
}

test("investigation packet includes task paths and later user turns without the full transcript", () => {
  const packet = buildRecoveryInvestigationPacket(taskCase(), {
    git: {
      isRepo: false,
      headState: "unborn",
      dirtyPaths: [],
      untrackedPaths: [],
      statusAvailable: false,
    },
    preimages: [{ path: "notes.md", source: "preimage", hash: "b".repeat(64) }],
    patches: [{ eventIndex: 0, targetPath: "patch.diff", verifiableBase: false }],
  });
  assert.equal(packet.truncated, false);
  assert.ok(packet.candidatePaths.includes("foo.html"));
  assert.equal(packet.candidatePaths[0], "foo.html");
  assert.ok(packet.laterUserTurns.some((turn) => turn.includes("slides.pptx")));
  assert.deepEqual(packet.preimagePaths, ["notes.md"]);
  assert.deepEqual(packet.patchPaths, ["patch.diff"]);
  assert.equal(packet.isRepo, false);
  assert.equal(JSON.stringify(packet).includes("# AGENTS.md"), false);
});

test("investigation packet truncates when path clues exceed the hard cap", () => {
  const events = Array.from({ length: INVESTIGATION_PACKET_MAX_PATHS + 40 }, (_, index) => ({
    type: "file",
    path: `generated/file-${index}.html`,
  }));
  const packet = buildRecoveryInvestigationPacket(taskCase({ historicalEvents: events }), {
    preimages: [],
    patches: [],
  });
  assert.equal(packet.truncated, true);
  assert.ok(packet.candidatePaths.length <= INVESTIGATION_PACKET_MAX_PATHS);
  assert.equal(JSON.stringify(packet).length < 200_000, true);
});
