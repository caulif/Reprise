#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  assertNoNewRepriseTempDirs,
  selfTestRepriseTempGuard,
  snapshotRepriseTempDirs,
} from "./reprise-temp-guard.mjs";
import { parseTestConcurrency, selfTestTestConcurrency } from './test-runner-options.mjs';

const options = process.argv.slice(2);
const selfTestOnly = options.length === 1 && options[0] === '--self-test';
if (options.includes('--self-test') && !selfTestOnly) throw new Error('--self-test must be the only option');
if (options.filter(arg => arg === '--coverage').length > 1) throw new Error('--coverage cannot be repeated');
const concurrency = parseTestConcurrency(options.filter(arg => arg !== '--coverage' && arg !== '--self-test'));
selfTestRepriseTempGuard();
selfTestTestConcurrency();
if (selfTestOnly) {
  console.log('test runner self-test: omitted concurrency preserves defaults; invalid concurrency is rejected');
  process.exit(0);
}

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
if (concurrency !== undefined) nodeArgs.splice(1, 0, `--test-concurrency=${concurrency}`);

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
