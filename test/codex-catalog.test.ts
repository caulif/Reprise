import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexGlobalState } from "../src/products/codex/global-state.js";
import { groupSessionsByProject } from "../src/tui/pages/intake.js";

test("Codex global state reader validates malformed state and preserves projectless ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-global-state-"));
  const diagnostics: import("../src/products/contract.js").DiscoveryDiagnostic[] = [];
  await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { p1: { id: "p1", name: "Demo", rootPaths: ["C:\\demo"] } },
    "projectless-thread-ids": ["thread-1"],
    "thread-project-assignments": { "thread-2": { projectKind: "local", projectId: "p1" } },
  }));
  const state = await readCodexGlobalState(root, diagnostics);
  assert.equal(state.projects[0]?.name, "Demo");
  assert.equal(state.projectless.has("thread-1"), true);
  assert.equal(state.assignments["thread-2"], "p1");
  await writeFile(join(root, ".codex-global-state.json"), "[]");
  const broken = await readCodexGlobalState(root, diagnostics);
  assert.equal(broken.projects.length, 0);
  assert.equal(diagnostics.at(-1)?.code, "global-state-unavailable");
  await rm(root, { recursive: true, force: true });
});

test("TUI project grouping keeps catalog-only projects visible and does not paginate sessions", () => {
  const sessions = Array.from({ length: 151 }, (_, index) => ({
    productId: "codex", sessionId: `session-${index}`, sourcePath: `/tmp/${index}.jsonl`, cwd: "C:\\demo",
    summary: `task-${index}`, startedAt: "2026-01-01T00:00:00.000Z", signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  }));
  const projects = groupSessionsByProject(sessions, [{ key: "codex\u0000c:/demo", label: "Demo", path: "C:\\demo" }, { key: "empty", label: "Empty" }]);
  assert.equal(projects.find((project) => project.key === "empty")?.sessions.length, 0);
  assert.equal(projects.reduce((total, project) => total + project.sessions.length, 0), 151);
});
