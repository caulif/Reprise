import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controllerDecisionTools,
  controllerProjectWriteAllowed,
  controllerReadEvidenceSource,
  createControllerToolBindings,
} from "../../src/application/controller-tools.js";
import type { ExperimentStore } from "../../src/infrastructure/store/experiment-store.js";

test("controllerProjectWriteAllowed only allows files under project/", () => {
  assert.equal(controllerProjectWriteAllowed("project/a.txt"), true);
  assert.equal(controllerProjectWriteAllowed("project"), false);
  assert.equal(controllerProjectWriteAllowed("INDEX.md"), false);
  assert.equal(controllerProjectWriteAllowed("history/user-inputs/a.txt"), false);
  assert.equal(controllerProjectWriteAllowed("project-evil/a.txt"), false);
});

test("opening history reads are briefing_read; changedPaths updates without recapturing opening empty list", () => {
  const bindings = createControllerToolBindings();
  assert.equal(controllerReadEvidenceSource("history/user-inputs/INDEX.tsv", bindings), "briefing_read");
  assert.equal(controllerReadEvidenceSource("project/out/report.pdf", bindings), undefined);
  bindings.phase = "steering";
  bindings.settledTurnCount = 1;
  bindings.changedPaths = ["out/report.pdf"];
  assert.equal(controllerReadEvidenceSource("project/out/report.pdf", bindings), "workspace_read");
  assert.equal(controllerReadEvidenceSource("run/turns/0001/visible.txt", bindings), "workspace_read");
  assert.equal(controllerReadEvidenceSource("project/secret.bin", bindings), undefined);
});

test("Controller write tools mutate project and reject briefing", async () => {
  const root = await mkdtemp(join(tmpdir(), "reprise-controller-tools-"));
  const briefingRoot = join(root, "briefing");
  const replicaRoot = join(root, "replica");
  await mkdir(join(briefingRoot, "run"), { recursive: true });
  await mkdir(replicaRoot, { recursive: true });
  await writeFile(join(briefingRoot, "INDEX.md"), "index\n");
  const events: unknown[] = [];
  const store = {
    commitArtifact: async () => undefined,
    append: async (event: unknown) => {
      events.push(event);
      return event;
    },
  } as unknown as ExperimentStore;
  const bindings = createControllerToolBindings();
  bindings.requestId = "controller-request-run-1-1";
  const tools = controllerDecisionTools(
    {
      store,
      runId: "run-1",
      experimentRoot: root,
      environment: { root: replicaRoot },
      taskCase: { privacy: { allowBinary: false } },
    },
    briefingRoot,
    bindings,
  );
  assert.equal(tools.some((tool) => tool.name === "shell_exec"), false);
  const write = tools.find((tool) => tool.name === "write");
  assert.ok(write);
  const signal = new AbortController().signal;
  await assert.rejects(() => write.execute({ path: "INDEX.md", content: "no" }, signal), /write_denied/);
  const written = await write.execute({ path: "project/note.txt", content: "user edit" }, signal);
  assert.match(written.content, /Wrote/);
  assert.equal(
    events.some((event) => (event as { type?: string }).type === "controller.workspace_write"),
    true,
  );
});
