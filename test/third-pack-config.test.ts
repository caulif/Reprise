import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { listCandidateModels, listProducts, listSourceSessions } from "../src/application/experiment-queries.js";
import { findProductPack, loadAndActivateProductPacks, resetProductPacks } from "../src/products/index.js";
import { packActivity, packRuntime, packSessions } from "../src/products/pack-access.js";
import { CodexIntakeTui } from "../src/tui/intake-app.js";
import { runCli } from "../src/cli/main.js";

const compiledPackDir = dirname(fileURLToPath(new URL("./fixtures/fake-pack/pack.js", import.meta.url)));
const compiledPackHref = pathToFileURL(join(compiledPackDir, "pack.js")).href;

test("third pack loads from package plus plugins.json without host injection", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-third-pack-"));
  t.after(async () => {
    resetProductPacks();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const installed = join(dataDir, "node_modules", "reprise-third-pack");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "reprise-third-pack", type: "module", exports: "./index.js" }));
  await writeFile(join(installed, "index.js"), `export { pack } from ${JSON.stringify(compiledPackHref)};\n`);
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({
    schemaVersion: 1,
    packs: [{ package: "reprise-third-pack" }],
  }));
  const diagnostics = await loadAndActivateProductPacks(dataDir);
  assert.deepEqual(diagnostics, []);
  const pack = findProductPack("fake");
  const sessions = packSessions(pack);
  const discovered = await sessions.discover();
  assert.ok(discovered.items.some((item) => item.sessionId === "fake-session-1"));
  const session = discovered.items[0];
  assert.ok(session);
  const imported = await sessions.import({
    productId: "fake",
    sessionId: session.sessionId,
    sourcePath: session.sourcePath,
  });
  assert.match(imported.initialInput.text, /ping\.txt/);
  const models = await listCandidateModels("fake");
  assert.deepEqual(models.map((item) => item.value), ["fake-model"]);
  const resolved = await packRuntime(pack).validateCandidate({
    productId: "fake",
    requestedModel: "fake-model",
  });
  assert.equal(resolved.resolvedModel, "fake-model");
  const envelope = {
    schemaVersion: 1 as const,
    sequence: 1,
    eventId: "fake-1",
    occurredAt: "2026-09-08T00:00:00.000Z",
    type: "fake.message",
    payload: { text: "Created ping.txt." },
    checksum: "a".repeat(64),
  };
  const activities = packActivity(pack).translate(envelope);
  assert.equal(activities[0]?.activity.kind, "message");
  const facts = packActivity(pack).inspectRunFacts([envelope]);
  assert.equal(facts.finalMessage, "Created ping.txt.");
  const listed = listProducts().products.find((item) => item.productId === "fake");
  assert.deepEqual(listed?.roles, ["source", "candidate"]);
  const page = await listSourceSessions({ productId: "fake", dataDir });
  assert.ok(page.items.some((item) => item.sessionId === "fake-session-1"));
  const output: string[] = [];
  const errors: string[] = [];
  const io = { stdout: (line: string) => { output.push(line); }, stderr: (line: string) => { errors.push(line); } };
  assert.equal(await runCli(["products", "--json", "--data-dir", dataDir], io), 0);
  assert.match(output.join("\n"), /"productId":\s*"fake"/);
  assert.equal(errors.join(""), "");
  let document: Component | undefined;
  const tui = {
    addChild(component: Component) { document = component; },
    addInputListener() { return () => {}; },
    start() {},
    stop() {},
    requestRender() {},
    renderNow() {},
  } as unknown as TUI;
  const app = new CodexIntakeTui({
    dataDir,
    tui,
    privacy: { allowModelText: true, allowBinary: false, redactions: [] },
  });
  await app.start();
  assert.ok(app.productItems().some((item) => item.productId === "fake"));
  await app.loadProductSessions("fake");
  assert.ok(app.sessions.some((item) => item.sessionId === "fake-session-1"));
  assert.match(document?.render(120).join("\n") ?? "", /Fake/);
});
