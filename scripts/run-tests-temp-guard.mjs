#!/usr/bin/env node
import { spawn } from "node:child_process";
import { assertNoNewRepriseTempDirs, snapshotRepriseTempDirs } from "./reprise-temp-guard.mjs";

const baseline = snapshotRepriseTempDirs();
const child = spawn(process.execPath, ["--test", "dist/test/**/*.test.js"], {
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

const exitCode = await new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    if (signal) resolve(1);
    else resolve(code ?? 1);
  });
  child.on("error", () => resolve(1));
});

if (exitCode !== 0) {
  process.exit(exitCode);
}

try {
  assertNoNewRepriseTempDirs(baseline);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
