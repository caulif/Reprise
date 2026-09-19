/**
 * B9 acceptance matrix (handoff §12.2).
 * Rows pin owning suites on main (including B4 render/preview). Pointers only —
 * this file alone is not §12.4 complete; Review CLEAR still required to merge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

type MatrixStatus = "owned" | "partial";

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

/** Empty after B4 #46 merge — retained so callers can detect regressions. */
export const PENDING_B4_IDS = new Set<string>();

export const COMPARISON_ACCEPTANCE_MATRIX: readonly MatrixCase[] = [
  {
    id: "V1",
    title: "dual HTML, history patch only, empty refs",
    depends: ["B1", "B2", "B3", "B4", "B6"],
    mustProve: "history restore → register → render → dual images; baseline still empty",
    status: "owned",
    owningSuites: [
      "test/application/comparison-historical-baseline.test.ts",
      "test/application/b2-historical-freeze-discovery.test.ts",
      "test/application/comparison-evidence.test.ts",
      "test/application/comparison-render-tools.test.ts",
      "test/application/comparison-openable-media.test.ts",
    ],
  },
  {
    id: "V2",
    title: "dual animation, script/CSS diverge",
    depends: ["B4", "B6"],
    mustProve: "multi-frame sampling with explicit source/conditions; no static PNG as motion proof",
    status: "owned",
    owningSuites: [
      "test/application/artifact-renderer.test.ts",
      "test/application/comparison-render-tools.test.ts",
      "test/application/headless-screenshot.test.ts",
    ],
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
    status: "owned",
    owningSuites: [
      "test/application/b2-historical-freeze-discovery.test.ts",
      "test/application/historical-final-discovery.test.ts",
      "test/application/artifact-renderer.test.ts",
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
    status: "owned",
    owningSuites: [
      "test/application/artifact-renderer.test.ts",
      "test/application/comparison-render-tools.test.ts",
      "test/application/comparison-openable-media.test.ts",
    ],
  },
  {
    id: "S1",
    title: "malicious history JS / path / HTML network",
    depends: ["B1", "B4"],
    mustProve: "no log program exec; no escape from evidence root; no credential leak; no external write",
    status: "owned",
    owningSuites: [
      "test/products/historical-artifacts-extract.test.ts",
      "test/application/artifact-renderer.test.ts",
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
  "docs/decisions/accepted/2026-09-19-controlled-artifact-render.md",
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

test("PENDING_B4_IDS is empty after B4 merge; every row is OWNED", () => {
  assert.equal(PENDING_B4_IDS.size, 0);
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    assert.equal(row.status, "owned", `${row.id} must be owned`);
    assert.ok(row.owningSuites.length > 0, `${row.id} must claim owning suites`);
  }
});

test("accepted per-package ADRs exist (including B4 render)", async () => {
  for (const rel of ACCEPTED_ADR_INDEX) {
    await assertPathExists(rel);
  }
});

test("every matrix owning suite path exists", async () => {
  const seen = new Set<string>();
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    for (const suite of row.owningSuites) {
      if (seen.has(suite)) continue;
      seen.add(suite);
      await assertPathExists(suite);
    }
  }
});

test("matrix V1 OWNED: history/freeze/catalog/render suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V1");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V2 OWNED: multi-frame render suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V2");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V3 OWNED: one-sided publication suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V3");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix V4 OWNED: basename + bundle CSS suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "V4");
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

test("matrix P2 OWNED: cancel / no_browser / render failure suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "P2");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});

test("matrix S1 OWNED: extract safety + network gate suites exist", async () => {
  const row = COMPARISON_ACCEPTANCE_MATRIX.find((entry) => entry.id === "S1");
  assert.equal(row?.status, "owned");
  for (const suite of row?.owningSuites ?? []) await assertPathExists(suite);
});
