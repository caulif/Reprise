#!/usr/bin/env node
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPRISE_TEMP_PREFIX = "reprise-";

/** @returns {ReadonlySet<string>} absolute paths of existing reprise-* temp dirs */
export function snapshotRepriseTempDirs(tempRoot = tmpdir()) {
  const names = readdirSync(tempRoot, { withFileTypes: true });
  const baseline = new Set();
  for (const entry of names) {
    if (!entry.isDirectory() || !entry.name.startsWith(REPRISE_TEMP_PREFIX)) continue;
    baseline.add(join(tempRoot, entry.name));
  }
  return baseline;
}

/** @param {ReadonlySet<string>} baseline */
export function findNewRepriseTempDirs(baseline, tempRoot = tmpdir()) {
  const leaked = [];
  for (const path of snapshotRepriseTempDirs(tempRoot)) {
    if (!baseline.has(path)) leaked.push(path);
  }
  return leaked;
}

/** @param {ReadonlySet<string>} baseline */
export function assertNoNewRepriseTempDirs(baseline, tempRoot = tmpdir()) {
  const leaked = findNewRepriseTempDirs(baseline, tempRoot);
  if (leaked.length === 0) return;
  const lines = [
    `Found ${leaked.length} new ${REPRISE_TEMP_PREFIX}* temp dir(s) under ${tempRoot}:`,
    ...leaked.map((path) => `  ${path}`),
    "Tests and catalog probes must remove mkdtemp dirs (t.after / rm in finally).",
    "Local cleanup (PowerShell): Get-ChildItem $env:TEMP -Directory -Filter 'reprise-*' | Remove-Item -Recurse -Force",
  ];
  throw new Error(lines.join("\n"));
}

function selfTest() {
  const tempRoot = tmpdir();
  const baseline = snapshotRepriseTempDirs(tempRoot);
  const leak = mkdtempSync(join(tempRoot, `${REPRISE_TEMP_PREFIX}self-test-leak-`));
  try {
    assertNoNewRepriseTempDirs(baseline, tempRoot);
    throw new Error("self-test: expected leak detection to fail");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(leak)) {
      throw error;
    }
  }
  rmSync(leak, { recursive: true, force: true });
  assertNoNewRepriseTempDirs(baseline, tempRoot);
  console.log("reprise-temp-guard self-test: new reprise-* dirs are detected; cleaned dirs pass");
}

if (process.argv.includes("--self-test")) {
  selfTest();
}
