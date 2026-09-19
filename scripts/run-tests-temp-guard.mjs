#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  assertNoNewRepriseTempDirs,
  selfTestRepriseTempGuard,
  snapshotRepriseTempDirs,
} from "./reprise-temp-guard.mjs";

selfTestRepriseTempGuard();

const coverage = process.argv.includes("--coverage");
const nodeArgs = coverage
  ? [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-lines=88",
      "--test-coverage-branches=76",
      "--test-coverage-functions=87",
      "--test-coverage-exclude=dist/test/**",
      "--test-coverage-exclude=dist/scripts/**",
      "--test-coverage-exclude=dist/src/**/types.js",
      "--test-coverage-exclude=dist/src/cli/main.js",
      "dist/test/**/*.test.js",
    ]
  : ["--test", "dist/test/**/*.test.js"];

const baseline = snapshotRepriseTempDirs();
const child = spawn(process.execPath, nodeArgs, {
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
