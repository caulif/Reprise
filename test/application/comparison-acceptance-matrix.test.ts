/**
 * B9 acceptance matrix (handoff §12.2).
 * OWNED rows pin owning suites already on main. B4-dependent rows stay PENDING
 * (no t.skip greenwash). Do not treat this file alone as §12.4 complete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

type MatrixStatus = "owned" | "partial" | "pending_b4";

type MatrixCase = {
  id: string;
  title: string;
  depends: readonly string[];
  mustProve: string;
  status: MatrixStatus;
  /** Suite paths relative to repo root that prove the owned/partial slice. */
  owningSuites: readonly string[];
};

const ROOT = join(process.cwd());

/** Rows whose mustProve still needs B4 render/preview/network. */
export const PENDING_B4_IDS = new Set<string>(["V1", "V2", "V4", "P2", "S1"]);

export const COMPARISON_ACCEPTANCE_MATRIX: readonly MatrixCase[] = [
  {
    id: "V1",
    title: "dual HTML, history patch only, empty refs",
    depends: ["B1", "B2", "B3", "B4", "B6"],
    mustProve: "history restore → register → render → dual images; baseline still empty",
    status: "partial",
    owningSuites: [
      "test/application/comparison-historical-baseline.test.ts",
      "test/application/b2-historical-freeze-discovery.test.ts",
      "test/application/comparison-evidence.test.ts",
    ],
  },
  {
    id: "V2",
    title: "dual animation, script/CSS diverge",
    depends: ["B4", "B6"],
    mustProve: "multi-frame sampling with explicit source/conditions; no static PNG as motion proof",
    status: "pending_b4",
    owningSuites: [],
  },
  {
    id: "V3",
    title: "one side unrestorable",
    depends: ["B2", "B6"],
    mustProve: "show evidenced side + visible limitation; no fabricated pair; no forced winner",
    status: "owned",
    owningSuites: [
      "test/application/comparison-publication-tiers.test.ts",
      "test/application/comparison-publication.test.ts",
    ],
  },
  {
    id: "V4",
    title: "multi-page / same basename / relative CSS+images",
    depends: ["B2", "B4"],
    mustProve: "no cross-wiring by basename/index; entry-only copy does not break assets",
    status: "partial",
    owningSuites: [
      "test/application/b2-historical-freeze-discovery.test.ts",
      "test/application/historical-final-discovery.test.ts",
    ],
  },
  {
    id: "N1",
    title: "code fix task",
    depends: ["B6", "B7"],
    mustProve: "repro/result diff can be the subject; screenshots optional",
    status: "owned",
    owningSuites: [
      "test/application/comparison-publication-emptiness.test.ts",
      "test/application/comparison-agent-phases.test.ts",
      "test/application/comparison-report.test.ts",
    ],
  },
  {
    id: "N2",
    title: "text / translation",
    depends: ["B6", "B7"],
    mustProve: "short excerpts visible; no mandatory image frame noise",
    status: "owned",
    owningSuites: [
      "test/application/comparison-publication-emptiness.test.ts",
      "test/application/comparison-report.test.ts",
    ],
  },
  {
    id: "N3",
    title: "data / table",
    depends: ["B3", "B6"],
    mustProve: "key numbers/checks usable; derived charts not labeled as model originals",
    status: "owned",
    owningSuites: [
      "test/application/comparison-evidence.test.ts",
      "test/application/comparison-publication-emptiness.test.ts",
    ],
  },
  {
    id: "C1",
    title: "text-only model",
    depends: ["B5", "B6"],
    mustProve: "can publish real images for humans; no image blocks; no claimed observation",
    status: "owned",
    owningSuites: [
      "test/application/agent-host-input-capabilities.test.ts",
      "test/application/comparison-agent-phases.test.ts",
    ],
  },
  {
    id: "C2",
    title: "vision model",
    depends: ["B5"],
    mustProve: "model receives sourced images; audit can reconstruct inputs",
    status: "owned",
    owningSuites: [
      "test/application/agent-host-input-capabilities.test.ts",
      "test/application/pi-model-caller.test.ts",
    ],
  },
  {
    id: "P1",
    title: "same asset name across attempts; second fails",
    depends: ["B6"],
    mustProve: "first report/media bytes unchanged",
    status: "owned",
    owningSuites: [
      "test/application/comparison-historical-baseline.test.ts",
      "test/application/comparison-publication-emptiness.test.ts",
    ],
  },
  {
    id: "P2",
    title: "cancel / no browser / render failure",
    depends: ["B4"],
    mustProve: "no leaked subprocess; no half-registered facts; CandidateRun untouched",
    status: "pending_b4",
    owningSuites: [],
  },
  {
    id: "S1",
    title: "malicious history JS / path / HTML network",
    depends: ["B1", "B4"],
    mustProve: "no log program exec; no escape from evidence root; no credential leak; no external write",
    status: "partial",
    owningSuites: [
      "test/products/historical-artifacts-extract.test.ts",
    ],
  },
] as const;

const EXPECTED_IDS = ["V1", "V2", "V3", "V4", "N1", "N2", "N3", "C1", "C2", "P1", "P2", "S1"] as const;

const ACCEPTED_ADR_INDEX = [
  "docs/decisions/accepted/2026-09-19-historical-artifact-extract-port.md",
  "docs/decisions/accepted/2026-09-19-historical-deliverable-freeze-and-derived.md",
  "docs/decisions/accepted/2026-09-19-comparison-evidence-catalog.md",
  "docs/decisions/accepted/2026-09-19-harness-model-input-capabilities.md",
  "docs/decisions/accepted/2026-09-19-comparison-autonomous-report-zones.md",
  "docs/decisions/accepted/2026-09-19-comparison-autonomous-prompt-loop.md",
] as const;

async function assertPathExists(rel: string): Promise<void> {
  await access(join(ROOT, rel));
}

test("acceptance matrix lists every handoff §12.2 id exactly once", () => {
  const ids = COMPARISON_ACCEPTANCE_MATRIX.map((row) => row.id);
  assert.deepEqual(ids, [...EXPECTED_IDS]);
  assert.equal(new Set(ids).size, ids.length);
});

test("acceptance matrix dependency tags stay within B1–B8", () => {
  const allowed = new Set(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    for (const dep of row.depends) {
      assert.ok(allowed.has(dep), `${row.id} has unexpected dep ${dep}`);
    }
  }
});

test("PENDING_B4_IDS matches matrix rows that declare pending_b4 or partial+B4", () => {
  for (const id of PENDING_B4_IDS) {
    const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === id);
    assert.ok(row, `unknown pending id ${id}`);
    assert.ok(
      row.status === "pending_b4" || row.status === "partial",
      `${id} must be pending_b4 or partial`,
    );
    assert.ok(row.depends.includes("B4") || id === "V2" || id === "P2", `${id} pending without B4 dep`);
  }
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    if (row.status === "pending_b4") {
      assert.ok(PENDING_B4_IDS.has(row.id), `${row.id} pending_b4 missing from PENDING_B4_IDS`);
      assert.equal(row.owningSuites.length, 0, `${row.id} pending_b4 must not claim owning suites`);
    }
  }
});

test("accepted per-package ADRs exist (proposed umbrellas removed)", async () => {
  for (const rel of ACCEPTED_ADR_INDEX) {
    await assertPathExists(rel);
  }
});

test("matrix V3 OWNED: one-sided publication suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V3");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix N1 OWNED: non-visual compose suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "N1");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix N2 OWNED: text/table visibility suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "N2");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix N3 OWNED: derived evidence + table suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "N3");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix C1 OWNED: text-only capability suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "C1");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix C2 OWNED: vision capability suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "C2");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix P1 OWNED: publish immutability suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "P1");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V1 PARTIAL: history/freeze/catalog suites exist; render PENDING B4", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V1");
  assert.equal(row?.status, "partial");
  assert.ok(PENDING_B4_IDS.has("V1"));
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V4 PARTIAL: basename/identity suites exist; bundle load PENDING B4", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V4");
  assert.equal(row?.status, "partial");
  assert.ok(PENDING_B4_IDS.has("V4"));
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix S1 PARTIAL: extract safety suite exists; HTML network PENDING B4", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "S1");
  assert.equal(row?.status, "partial");
  assert.ok(PENDING_B4_IDS.has("S1"));
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V2 PENDING B4: no owning suite claimed", () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V2");
  assert.equal(row?.status, "pending_b4");
  assert.deepEqual(row?.owningSuites, []);
  assert.ok(PENDING_B4_IDS.has("V2"));
});

test("matrix P2 PENDING B4: no owning suite claimed", () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "P2");
  assert.equal(row?.status, "pending_b4");
  assert.deepEqual(row?.owningSuites, []);
  assert.ok(PENDING_B4_IDS.has("P2"));
});
