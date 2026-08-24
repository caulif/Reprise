import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexGlobalState } from "../src/products/codex/global-state.js";
import { readCodexCatalog } from "../src/products/codex/catalog.js";
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


test("Codex SQLite catalog uses only supported columns and keeps catalog-only rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-sqlite-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions");
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, preview TEXT, has_user_event INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "11111111-2222-4333-8444-555555555555", null, 1_750_000_000, 1_750_000_001, "C:\\demo", "Indexed task", "Preview", 1,
  );
  db.close();
  await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { demo: { id: "demo", name: "Demo", rootPaths: ["C:\\demo"] } },
    "project-order": ["demo"],
  }));
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot: sessions });
  assert.equal(catalog.diagnostics.length, 0);
  assert.equal(catalog.sessions.length, 1);
  assert.equal(catalog.sessions[0]?.sourceKind, "catalog-only");
  assert.equal(catalog.sessions[0]?.availability, "catalog-only");
  assert.equal(catalog.projects[0]?.order, 0);
});

test("Codex catalog degrades a database with no threads table", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-sqlite-bad-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE unrelated (value TEXT)");
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot: join(root, "sessions") });
  assert.equal(catalog.sessions.length, 0);
  assert.equal(catalog.diagnostics.some((diagnostic) => diagnostic.code === "catalog-schema-unsupported"), true);
});


test("projectless provenance overrides a transcript cwd during grouping", () => {
  const projects = groupSessionsByProject([{
    productId: "codex", sessionId: "projectless-thread", sourcePath: "/tmp/session.jsonl", cwd: "C:\\demo",
    sourceKind: "projectless", summary: "Outside project", signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  }]);
  assert.equal(projects[0]?.key, "projectless");
  assert.equal(projects[0]?.label, "Projectless sessions");
});
