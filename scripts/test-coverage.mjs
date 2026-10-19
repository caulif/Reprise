import { spawn } from 'node:child_process';
import { assertNoNewRepriseTempDirs, snapshotRepriseTempDirs } from './reprise-temp-guard.mjs';

export const COVERAGE_THRESHOLDS = Object.freeze({ lines: 88, branches: 76, functions: 87 });
export const COVERAGE_EXCLUDES = Object.freeze(['dist/test/**', 'dist/scripts/**', 'dist/src/**/types.js', 'dist/src/cli/main.js']);

export function coverageArguments(enforce = true) {
  return [
    '--experimental-test-coverage',
    ...(enforce ? Object.entries(COVERAGE_THRESHOLDS).map(([kind, value]) => `--test-coverage-${kind}=${value}`) : []),
    ...COVERAGE_EXCLUDES.map(pattern => `--test-coverage-exclude=${pattern}`),
  ];
}

export async function runGuardedTests(args, { cwd = process.cwd(), env = process.env } = {}) {
  const baseline = snapshotRepriseTempDirs();
  const child = spawn(process.execPath, args, { cwd, env: { ...env }, stdio: 'inherit', shell: false, windowsHide: true });
  const exitCode = await new Promise(resolve => {
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
    child.once('error', error => { console.error(error.message); resolve(1); });
  });
  if (exitCode === 0) assertNoNewRepriseTempDirs(baseline);
  return exitCode;
}
