import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoveryEvidenceCatalog } from "../src/infrastructure/recovery-tools.js";
import { recoveryTools } from "../src/infrastructure/recovery-tools.js";
import { OBSERVATIONS_MOUNT, writeFrozenObservationTree } from "../src/application/observation-files.js";
import type { EventEnvelope, TaskCase } from "../src/core/schema.js";

function taskCase(overrides: Partial<TaskCase> = {}): TaskCase {
  return {
    schemaVersion: 1,
    caseId: "case-obs",
    source: { productId: "codex", sessionId: "session" },
    initialInput: { id: "message-1", role: "user", text: "task" },
    transcript: [
      { id: "message-1", role: "user", text: "task" },
      { id: "message-2", role: "assistant", text: "assistant secret" },
    ],
    historicalEvents: [{ kind: "tool", output: "observed", text: "event secret" }],
    baseline: { status: "unavailable", artifactRefs: [], evidenceRefs: [] },
    sourceRuntimeEvidence: { productId: "codex", artifactRefs: [] },
    provenance: {
      packVersion: "test",
      importedAt: "2026-08-14T00:00:00.000Z",
      sourceHash: "a".repeat(64),
    },
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
    contentHash: "b".repeat(64),
    ...overrides,
  };
}

test("frozen observation files carry Host refs and truncate oversized bodies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-observations-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const huge = taskCase({
    historicalEvents: [{ kind: "tool", output: "x".repeat(40_000) }],
  });
  const written = await writeFrozenObservationTree({
    root,
    taskCase: huge,
    playbookText: "# playbook\n",
    runEvents: [{
      schemaVersion: 1,
      sequence: 1,
      eventId: "evt-1",
      occurredAt: "2026-09-07T00:00:00.000Z",
      type: "test.event",
      payload: { text: "run secret" },
      checksum: "e".repeat(64),
    } satisfies EventEnvelope],
  });
  assert.ok(written.fileCount > 3);
  const index = await readFile(join(root, "INDEX.md"), "utf8");
  assert.match(index, /Frozen observations/);
  const catalog = recoveryEvidenceCatalog(huge);
  const history = JSON.parse(await readFile(join(root, "historical-events", `${catalog[2]!.ref.replace(/^event:/, "")}.json`), "utf8")) as {
    ref: string;
    truncated: boolean;
    observation: { excerpt?: string };
  };
  assert.equal(history.ref, catalog[2]?.ref);
  assert.equal(history.truncated, true);
  assert.ok((history.observation.excerpt?.length ?? 0) <= 8_000);
  const workspace = await mkdtemp(join(tmpdir(), "reprise-obs-ws-"));
  t.after(() => rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const tools = recoveryTools(workspace, { mounts: { [OBSERVATIONS_MOUNT]: root } });
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(read);
  const listed = await tools.find((tool) => tool.name === "ls")!.execute({ path: "observations" }, new AbortController().signal);
  assert.match(listed.content, /INDEX.md/);
  const page = await read.execute({ path: "observations/INDEX.md" }, new AbortController().signal);
  assert.match(page.content, /Host-owned copies/);
});

test("observation files redact assistant and nested text when model text is disallowed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-observations-redact-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const frozen = taskCase({ privacy: { allowModelText: false, allowBinary: false, redactions: [] } });
  await writeFrozenObservationTree({
    root,
    taskCase: frozen,
    runEvents: [{
      schemaVersion: 1,
      sequence: 1,
      eventId: "evt-2",
      occurredAt: "2026-09-07T00:00:00.000Z",
      type: "codex.item_completed",
      payload: { item: { type: "agentMessage", text: "event secret" }, nested: [{ text: "nested secret" }], keep: "visible" },
      checksum: "f".repeat(64),
    }],
  });
  const catalog = recoveryEvidenceCatalog(frozen);
  const assistant = JSON.parse(await readFile(join(root, "transcript", `${catalog[1]!.ref.replace(/^event:/, "")}.json`), "utf8")) as {
    observation: { text: string };
  };
  assert.equal(assistant.observation.text, "[REDACTED]");
  const run = JSON.parse(await readFile(join(root, "run-events", "evt-2.json"), "utf8")) as {
    observation: { payload: { item: { text: string }; nested: { text: string }[]; keep: string } };
  };
  assert.equal(run.observation.payload.item.text, "[REDACTED]");
  assert.equal(run.observation.payload.nested[0]?.text, "[REDACTED]");
  assert.equal(run.observation.payload.keep, "visible");
});
