import test from 'node:test';
import assert from 'node:assert/strict';
import { userRecoveryStatus } from '../src/application/recovery-user-status.js';
import type { EnvironmentBaseline } from '../src/environment/local-workspace-provider.js';

function baseline(overrides: Partial<EnvironmentBaseline>): EnvironmentBaseline {
  return {
    baselineId: 'baseline-case',
    caseId: 'case',
    mode: 'canonical',
    match: 'matched',
    resources: [],
    readiness: { runnable: 'isolated', strictness: 'strict', blockingResourceIds: [] },
    fingerprint: { capturedAt: '2026-08-14T00:00:00.000Z', resources: [], digest: 'a'.repeat(64) },
    budget: { fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [] },
    capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
    warnings: [],
    createdAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

test('user recovery status maps complete recovery, skipped links, and missing source', () => {
  assert.equal(userRecoveryStatus({
    baseline: baseline({ match: 'recovered', recovery: { status: 'recovered', unresolved: [], sourceDigest: 'a'.repeat(64), recoveredDigest: 'a'.repeat(64) } }),
    transcriptOk: true,
  }), 'recovered');
  assert.equal(userRecoveryStatus({
    baseline: baseline({
      match: 'recovered',
      budget: {
        fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [],
        excludedEntries: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }],
      },
    }),
    transcriptOk: true,
  }), 'partial');
  assert.equal(userRecoveryStatus({
    baseline: baseline({ mode: 'unsupported', match: 'observational', readiness: { runnable: 'unsupported', strictness: 'strict', blockingResourceIds: ['workspace'] } }),
    transcriptOk: true,
  }), 'failed');
  assert.equal(userRecoveryStatus({
    baseline: baseline({ match: 'recovered' }),
    transcriptOk: false,
  }), 'failed');
});
