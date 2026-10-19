#!/usr/bin/env node
import { selfTestRepriseTempGuard } from "./reprise-temp-guard.mjs";
import { coverageArguments, runGuardedTests } from './test-coverage.mjs';
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
const nodeArgs = ['--test', ...(coverage ? coverageArguments() : []), 'dist/test/**/*.test.js'];
if (concurrency !== undefined) nodeArgs.splice(1, 0, `--test-concurrency=${concurrency}`);

try {
  process.exitCode = await runGuardedTests(nodeArgs);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
