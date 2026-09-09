import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHistoryPage, listProducts } from "../src/application/experiment-queries.js";
import {
  assembleProductPacks,
  loadAndActivateProductPacks,
  productPacks,
  resetProductPacks,
} from "../src/products/index.js";
import { packRoles } from "../src/products/pack-access.js";
import { claudeCodeProductPack } from "../src/products/claude-code/pack.js";
import { codexProductPack } from "../src/products/codex/pack.js";

const builtins = [codexProductPack, claudeCodeProductPack];

test("registry keeps builtins when extras fail and history still reads", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-pack-hist-"));
  t.after(async () => {
    resetProductPacks();
    await rm(dataDir, { recursive: true, force: true });
  });
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({
    schemaVersion: 1,
    packs: [{ module: "./missing-pack.js" }],
  }));
  const assembled = await assembleProductPacks(dataDir, builtins);
  assert.deepEqual(assembled.packs.map((pack) => pack.manifest.productId), ["codex", "claude-code"]);
  assert.equal(assembled.diagnostics[0]?.code, "load_failed");
  await loadAndActivateProductPacks(dataDir);
  const history = await listHistoryPage({ dataDir });
  assert.deepEqual(history.items, []);
  assert.equal(listProducts().diagnostics[0]?.code, "load_failed");
});

test("duplicate productId keeps the first pack and records a diagnostic", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-pack-dup-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "dup.js"), packModule({ productId: "codex", capabilities: ["import"], sessions: true }));
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({ schemaVersion: 1, packs: [{ module: "./dup.js" }] }));
  const assembled = await assembleProductPacks(dataDir, builtins);
  assert.equal(assembled.packs.filter((pack) => pack.manifest.productId === "codex").length, 1);
  assert.equal(assembled.packs[0], codexProductPack);
  assert.equal(assembled.diagnostics.some((item) => item.code === "duplicate_product_id"), true);
});

test("incompatible apiMajor, invalid export, and raw TypeScript are rejected", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-pack-bad-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "major.js"), packModule({ productId: "major-x", apiMajor: 1, capabilities: ["import"], sessions: true }));
  await writeFile(join(dataDir, "empty.js"), "export const nope = true;\n");
  await writeFile(join(dataDir, "raw.ts"), packModule({ productId: "raw-ts", capabilities: ["import"], sessions: true }));
  await writeFile(join(dataDir, "mismatch.js"), packModule({ productId: "mismatch", capabilities: ["import"] }));
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({
    schemaVersion: 1,
    packs: [{ module: "./major.js" }, { module: "./empty.js" }, { module: "./raw.ts" }, { module: "./mismatch.js" }],
  }));
  const codes = (await assembleProductPacks(dataDir, builtins)).diagnostics.map((item) => item.code);
  assert.deepEqual(codes, ["incompatible_api_major", "invalid_export", "raw_typescript", "capability_mismatch"]);
});

test("import-only and runtime-only packs register with matching roles", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-pack-cap-"));
  t.after(async () => {
    resetProductPacks();
    await rm(dataDir, { recursive: true, force: true });
  });
  await writeFile(join(dataDir, "import-only.js"), packModule({ productId: "import-only", capabilities: ["import"], sessions: true }));
  await writeFile(join(dataDir, "runtime-only.js"), packModule({ productId: "runtime-only", capabilities: ["runtime"], runtime: true }));
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({
    schemaVersion: 1,
    packs: [{ module: "./import-only.js" }, { module: "./runtime-only.js" }],
  }));
  await loadAndActivateProductPacks(dataDir);
  t.after(() => resetProductPacks());
  const listed = listProducts().products;
  assert.deepEqual(listed.find((item) => item.productId === "import-only")?.roles, ["source"]);
  assert.deepEqual(listed.find((item) => item.productId === "runtime-only")?.roles, ["candidate"]);
  const extra = productPacks.find((pack) => pack.manifest.productId === "import-only");
  assert.ok(extra);
  assert.deepEqual(packRoles(extra), ["source"]);
});

test("installed package specifier resolves from the data directory", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "reprise-pack-pkg-"));
  t.after(async () => rm(dataDir, { recursive: true, force: true }));
  const pkg = join(dataDir, "node_modules", "reprise-fixture-pack");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "reprise-fixture-pack", type: "module", exports: "./index.js" }));
  await writeFile(join(pkg, "index.js"), packModule({ productId: "fixture-pkg", capabilities: ["import"], sessions: true }));
  await writeFile(join(dataDir, "plugins.json"), JSON.stringify({ schemaVersion: 1, packs: [{ package: "reprise-fixture-pack" }] }));
  const assembled = await assembleProductPacks(dataDir, builtins);
  assert.ok(assembled.packs.some((pack) => pack.manifest.productId === "fixture-pkg"));
});

test("product lookups from different assemblies do not share extras", async () => {
  const { createProductLookup } = await import("../src/products/index.js");
  const left = createProductLookup([codexProductPack]);
  const right = createProductLookup([claudeCodeProductPack]);
  assert.equal(left.find("codex").manifest.productId, "codex");
  assert.throws(() => left.find("claude-code"));
  assert.throws(() => right.find("codex"));
  assert.equal(right.find("claude-code").manifest.productId, "claude-code");
});

function packModule(input: {
  productId: string;
  capabilities: readonly string[];
  apiMajor?: number;
  sessions?: boolean;
  runtime?: boolean;
}): string {
  const sessions = input.sessions
    ? `history: { defaultRoot: "C:/reprise-fixture", discover: async () => ({ items: [], scanned: 0, skipped: 0, diagnostics: [] }), inspect: async () => { throw new Error("unused"); }, import: async () => { throw new Error("unused"); } },`
    : "";
  const runtime = input.runtime
    ? `runtime: { listCatalog: async () => [], inspectAvailability: async () => [], validateCandidate: async () => ({}), createRunner: async () => { throw new Error("unused"); } }, projection: { inspectRunFacts: () => ({ commands: [], rejectedApprovals: [] }), translate: () => [], projectTurn: () => ({ turnIndex: 1, status: "empty", observedAt: "2026-09-09T00:00:00.000Z" }) }, defaultCandidate: () => ({ candidateId: "x", productId: ${JSON.stringify(input.productId)}, requestedModel: "x" }),`
    : "";
  return `export const pack = {
    manifest: { productId: ${JSON.stringify(input.productId)}, displayName: ${JSON.stringify(input.productId)}, packVersion: "0.0.1", schemaVersion: 1, apiMajor: ${input.apiMajor ?? 2}, capabilities: ${JSON.stringify(input.capabilities)} },
    ${sessions}
    ${runtime}
  };
`;
}
