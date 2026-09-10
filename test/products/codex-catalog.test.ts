import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexGlobalState } from "../../src/products/packs/codex/global-state.js";
import { readCodexCatalog } from "../../src/products/packs/codex/catalog.js";
import { groupSessionsByProject } from "../../src/tui/pages/intake.js";
import { classifyCodexProject } from "../../src/products/packs/codex/project-attribution.js";
import { catalogProjectKey, isUnknownProjectKey, sessionGroupingKey, sessionProjectKey } from "../../src/products/shared/session-project.js";

test("Codex project attribution prefers assignment and keeps unknown projects", () => {
  const projectsById = new Map([["reprise", { id: "reprise", rootPaths: ["C:\\Users\\demo\\Reprise"] }]]);
  const assigned = classifyCodexProject({
    threadId: "t1",
    assignment: "reprise",
    sqliteProjectId: "other",
    cwd: "C:\\Users\\demo\\Reprise\\src",
    projectless: new Set(),
    projectsById,
  });
  assert.equal(assigned.evidence, "assignment");
  assert.equal(assigned.classification, "project");
  assert.equal(assigned.projectRoot, "C:\\Users\\demo\\Reprise");
  const unknown = classifyCodexProject({
    threadId: "t2",
    assignment: "missing",
    projectless: new Set(),
    projectsById,
  });
  assert.equal(unknown.classification, "unknown");
  assert.equal(unknown.evidence, "assignment");
  const outside = classifyCodexProject({
    threadId: "t3",
    projectless: new Set(["t3"]),
    cwd: "C:\\Users\\demo\\Reprise",
    projectsById,
  });
  assert.equal(outside.classification, "projectless");
  const key = catalogProjectKey("codex", "C:\\Users\\demo\\Reprise", "reprise");
  assert.equal(key, sessionProjectKey("codex", "c:/users/demo/reprise"));
  assert.equal(sessionGroupingKey({
    productId: "codex", sessionId: "rollout", cwd: "C:\\Users\\demo\\Reprise\\src", availability: "unindexed",
  }, new Map([["c:/users/demo/reprise", key]])), key);
});

test("Codex global state reader validates malformed state and preserves projectless ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-global-state-"));
  const diagnostics: import("../../src/products/contract.js").DiscoveryDiagnostic[] = [];
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

test("Codex catalog keeps thread rows when the database has no rollout_path column", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-catalog-no-rollout-column-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, cwd TEXT, title TEXT, has_user_event INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)").run(
    "22222222-3333-4444-8555-666666666666", "C:\\outside", "Desktop-only thread", 1,
  );
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot: join(root, "sessions") });
  assert.equal(catalog.sessions.length, 1);
  assert.equal(catalog.sessions[0]?.availability, "catalog-only");
  assert.equal(catalog.sessions[0]?.sourceKind, "catalog-only");
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


test("Codex catalog reports unavailable sources and project conflicts", async (t) => {
  const missingRoot = await mkdtemp(join(tmpdir(), "reprise-codex-catalog-missing-"));
  t.after(async () => rm(missingRoot, { recursive: true, force: true }));
  const missing = await readCodexCatalog({ codexHome: missingRoot });
  assert.equal(missing.diagnostics.some((diagnostic) => diagnostic.code === "catalog-unavailable"), true);

  const root = await mkdtemp(join(tmpdir(), "reprise-codex-catalog-conflict-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, project_id TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)").run(
    "11111111-2222-4333-8444-555555555555", null, 1_750_000_000, 1_750_000_001, "C:\\other", "database-project",
  );
  db.close();
  await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
    "local-projects": {
      assigned: { id: "assigned", name: "Assigned", rootPaths: ["C:\\assigned"] },
      database: { id: "database-project", name: "Database", rootPaths: ["C:\\database"] },
    },
    "thread-project-assignments": { "11111111-2222-4333-8444-555555555555": { projectId: "assigned" } },
  }));
  const conflict = await readCodexCatalog({ codexHome: root });
  assert.equal(conflict.sessions[0]?.cwd, "C:\\assigned");
  assert.equal(conflict.diagnostics.some((diagnostic) => diagnostic.code === "conflicting-project-source"), true);
});

test("projectless provenance overrides a transcript cwd during grouping", () => {
  const projects = groupSessionsByProject([{
    productId: "codex", sessionId: "projectless-thread", sourcePath: "/tmp/session.jsonl", cwd: "C:\\demo",
    sourceKind: "projectless", summary: "Outside project", signals: { userMessages: 1, assistantMessages: 1, toolCalls: 0, completedTurns: 1 },
  }]);
  assert.equal(projects[0]?.key, "projectless");
  assert.equal(projects[0]?.label, "Projectless sessions");
});

test("Codex assignment wins over empty sqlite project_id and uses the shared project key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-assignment-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, cwd TEXT, project_id TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run("11111111-2222-4333-8444-555555555555", "C:\\demo", null);
  db.close();
  await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
    "local-projects": { reprise: { id: "reprise", name: "reprise开发", rootPaths: ["C:\\Users\\demo\\Reprise"] } },
    "thread-project-assignments": { "11111111-2222-4333-8444-555555555555": { projectId: "reprise" } },
  }));
  const catalog = await readCodexCatalog({ codexHome: root });
  assert.equal(catalog.sessions[0]?.cwd, "C:\\Users\\demo\\Reprise");
  assert.equal(catalog.sessions[0]?.sourceKind, "catalog-only");
  const grouped = groupSessionsByProject(catalog.sessions, [{
    key: catalogProjectKey("codex", "C:\\Users\\demo\\Reprise", "reprise"),
    label: "reprise开发",
    path: "C:\\Users\\demo\\Reprise",
  }]);
  assert.equal(grouped[0]?.label, "reprise开发");
  assert.equal(grouped[0]?.key, catalogProjectKey("codex", "C:\\Users\\demo\\Reprise", "reprise"));
});

test("Codex assignment to an unknown project keeps the session as unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-unknown-project-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, cwd TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("11111111-2222-4333-8444-555555555555", "C:\\demo");
  db.close();
  await writeFile(join(root, ".codex-global-state.json"), JSON.stringify({
    "thread-project-assignments": { "11111111-2222-4333-8444-555555555555": { projectId: "missing" } },
  }));
  const catalog = await readCodexCatalog({ codexHome: root });
  assert.equal(catalog.sessions.length, 1);
  assert.equal(catalog.sessions[0]?.sourceKind, "unknown");
  const grouped = groupSessionsByProject(catalog.sessions);
  const unknown = grouped.find((project) => isUnknownProjectKey(project.key));
  assert.equal(unknown?.label, "Unknown project");
  assert.equal(unknown?.sessions.length, 1);
});



test("Codex catalog degrades corrupt and unsupported SQLite schemas without throwing", async (t) => {
  const corruptRoot = await mkdtemp(join(tmpdir(), "reprise-codex-sqlite-corrupt-"));
  t.after(async () => rm(corruptRoot, { recursive: true, force: true }));
  await writeFile(join(corruptRoot, "state_5.sqlite"), "not a sqlite database");
  const corrupt = await readCodexCatalog({ codexHome: corruptRoot });
  assert.equal(corrupt.sessions.length, 0);
  assert.equal(corrupt.diagnostics.some((diagnostic) => diagnostic.code === "catalog-read-error"), true);

  const unsupportedRoot = await mkdtemp(join(tmpdir(), "reprise-codex-sqlite-columns-"));
  t.after(async () => rm(unsupportedRoot, { recursive: true, force: true }));
  const db = new DatabaseSync(join(unsupportedRoot, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (title TEXT)");
  db.close();
  const unsupported = await readCodexCatalog({ codexHome: unsupportedRoot });
  assert.equal(unsupported.sessions.length, 0);
  assert.equal(unsupported.diagnostics.some((diagnostic) => diagnostic.code === "catalog-schema-unsupported"), true);
});

test("Codex catalog keeps unsafe rollout paths visible as catalog-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-rollout-paths-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot);
  const outside = join(root, "outside.jsonl");
  await writeFile(outside, "{}\n");
  await mkdir(join(sessionsRoot, "rollout-directory"));
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("relative", "../outside.jsonl");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("absolute", outside);
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("directory", "rollout-directory");
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot });
  assert.equal(catalog.sessions.length, 3);
  assert.equal(catalog.sessions.every((session) => session.availability === "catalog-only"), true);
  assert.equal(catalog.diagnostics.filter((diagnostic) => diagnostic.code === "source-missing").length, 3);
});

test("Codex catalog accepts Windows extended rollout paths that stay inside sessions root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-codex-extended-path-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sessionsRoot = join(root, "sessions");
  await mkdir(sessionsRoot);
  const file = join(sessionsRoot, "rollout-extended.jsonl");
  await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555" } })}\n`);
  const stored = process.platform === "win32" ? `\\\\?\\${file}` : file;
  const db = new DatabaseSync(join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("11111111-2222-4333-8444-555555555555", stored);
  db.close();
  const catalog = await readCodexCatalog({ codexHome: root, sessionsRoot });
  assert.equal(catalog.sessions[0]?.availability, "indexed");
  assert.equal(catalog.sessions[0]?.evidenceLevel, "transcript");
  assert.equal(catalog.diagnostics.some((diagnostic) => diagnostic.code === "source-missing"), false);
  assert.ok(catalog.sessions[0]?.sourcePath && !catalog.sessions[0].sourcePath.includes(".catalog"));
});

