/**
 * B9 acceptance matrix (handoff §12.2).
 * Structural tests always run. Behavioral rows stay skipped until B9 wires
 * them after B1–B8 merge (see WIRED_CASE_IDS). Probe checks only report readiness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

type MatrixCase = {
  id: string;
  title: string;
  /** Packages that must merge before unskipping. */
  depends: readonly string[];
  /** Dist modules that must exist before the case can run. */
  probeModules: readonly string[];
  mustProve: string;
};

const ROOT = join(process.cwd());

/**
 * IDs with implemented behavioral assertions. Empty until B1–B8 land and B9
 * wires each row; do not claim §12.4 complete while this set is incomplete.
 */
const WIRED_CASE_IDS = new Set<string>([]);

/** Full §12.2 matrix — keep in sync with handoff; do not drop rows. */
export const COMPARISON_ACCEPTANCE_MATRIX: readonly MatrixCase[] = [
  {
    id: "V1",
    title: "dual HTML, history patch only, empty refs",
    depends: ["B1", "B2", "B3", "B4", "B6"],
    probeModules: [
      "dist/src/core/schemas/historical-artifacts.js",
      "dist/src/application/comparison-evidence.js",
    ],
    mustProve: "history restore → register → render → dual images; baseline still empty",
  },
  {
    id: "V2",
    title: "dual animation, script/CSS diverge",
    depends: ["B4", "B6"],
    probeModules: ["dist/src/infrastructure/headless-screenshot.js"],
    mustProve: "multi-frame sampling with explicit source/conditions; no static PNG as motion proof",
  },
  {
    id: "V3",
    title: "one side unrestorable",
    depends: ["B2", "B6"],
    probeModules: ["dist/src/application/comparison-publication.js"],
    mustProve: "show evidenced side + visible limitation; no fabricated pair; no forced winner",
  },
  {
    id: "V4",
    title: "multi-page / same basename / relative CSS+images",
    depends: ["B2", "B4"],
    probeModules: ["dist/src/application/historical-final-discovery.js"],
    mustProve: "no cross-wiring by basename/index; entry-only copy does not break assets",
  },
  {
    id: "N1",
    title: "code fix task",
    depends: ["B6", "B7"],
    probeModules: ["dist/src/agents/comparison-agent.js"],
    mustProve: "repro/result diff can be the subject; screenshots optional",
  },
  {
    id: "N2",
    title: "text / translation",
    depends: ["B6", "B7"],
    probeModules: ["dist/src/application/comparison-report-shell.js"],
    mustProve: "short excerpts visible; no mandatory image frame noise",
  },
  {
    id: "N3",
    title: "data / table",
    depends: ["B3", "B6"],
    probeModules: ["dist/src/application/comparison-evidence.js"],
    mustProve: "key numbers/checks usable; derived charts not labeled as model originals",
  },
  {
    id: "C1",
    title: "text-only model",
    depends: ["B5", "B6"],
    probeModules: ["dist/src/infrastructure/harness-model-config.js"],
    mustProve: "can publish real images for humans; no image blocks; no claimed observation",
  },
  {
    id: "C2",
    title: "vision model",
    depends: ["B5"],
    probeModules: ["dist/src/infrastructure/agent/model-caller.js"],
    mustProve: "model receives sourced images; audit can reconstruct inputs",
  },
  {
    id: "P1",
    title: "same asset name across attempts; second fails",
    depends: ["B6"],
    probeModules: ["dist/src/application/comparison-publication.js"],
    mustProve: "first report/media bytes unchanged",
  },
  {
    id: "P2",
    title: "cancel / no browser / render failure",
    depends: ["B4"],
    probeModules: ["dist/src/infrastructure/headless-screenshot.js"],
    mustProve: "no leaked subprocess; no half-registered facts; CandidateRun untouched",
  },
  {
    id: "S1",
    title: "malicious history JS / path / HTML network",
    depends: ["B1", "B4"],
    probeModules: [
      "dist/src/core/schemas/historical-artifacts.js",
      "dist/src/infrastructure/headless-screenshot.js",
    ],
    mustProve: "no log program exec; no escape from evidence root; no credential leak; no external write",
  },
] as const;

const EXPECTED_IDS = ["V1", "V2", "V3", "V4", "N1", "N2", "N3", "C1", "C2", "P1", "P2", "S1"] as const;

async function moduleExists(rel: string): Promise<boolean> {
  try {
    await access(join(ROOT, rel));
    return true;
  } catch {
    // Missing probe file means the owning package has not landed yet.
    return false;
  }
}

async function caseProbesReady(entry: MatrixCase): Promise<boolean> {
  for (const mod of entry.probeModules) {
    if (!(await moduleExists(mod))) return false;
  }
  return true;
}

test("acceptance matrix lists every handoff §12.2 id exactly once", () => {
  const ids = COMPARISON_ACCEPTANCE_MATRIX.map((row) => row.id);
  assert.deepEqual(ids, [...EXPECTED_IDS]);
  assert.equal(new Set(ids).size, ids.length);
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    assert.ok(row.title.length > 0, `${row.id} needs title`);
    assert.ok(row.mustProve.length > 0, `${row.id} needs mustProve`);
    assert.ok(row.depends.length > 0, `${row.id} needs depends`);
    assert.ok(row.probeModules.length > 0, `${row.id} needs probeModules`);
  }
});

test("acceptance matrix dependency tags stay within B1–B8", () => {
  const allowed = new Set(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  for (const row of COMPARISON_ACCEPTANCE_MATRIX) {
    for (const dep of row.depends) {
      assert.ok(allowed.has(dep), `${row.id} has unexpected dep ${dep}`);
    }
  }
});

test("acceptance matrix WIRED ids are known matrix rows", () => {
  for (const id of WIRED_CASE_IDS) {
    assert.ok(
      COMPARISON_ACCEPTANCE_MATRIX.some((row) => row.id === id),
      `unknown wired id ${id}`,
    );
  }
});

test("acceptance matrix probe readiness (diagnostic)", async () => {
  const lines: string[] = [];
  for (const entry of COMPARISON_ACCEPTANCE_MATRIX) {
    const probes = await caseProbesReady(entry);
    const wired = WIRED_CASE_IDS.has(entry.id);
    lines.push(`${entry.id}: probes=${probes ? "ready" : "missing"} wired=${wired}`);
  }
  // Always pass; surfaces readiness in the test name/output for operators.
  assert.equal(lines.length, EXPECTED_IDS.length, lines.join("; "));
});

for (const entry of COMPARISON_ACCEPTANCE_MATRIX) {
  test(`matrix ${entry.id}: ${entry.title}`, async (t) => {
    if (!WIRED_CASE_IDS.has(entry.id)) {
      const probes = await caseProbesReady(entry);
      t.skip(
        probes
          ? `probes ready; behavioral hook not wired (deps ${entry.depends.join(",")}) — ${entry.mustProve}`
          : `waiting deps ${entry.depends.join(",")} — ${entry.mustProve}`,
      );
      return;
    }
    assert.fail(
      `${entry.id} is marked WIRED but has no behavioral body — add assertions or remove from WIRED_CASE_IDS`,
    );
  });
}
