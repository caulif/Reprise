import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosisReasonCode, recoveryAcceptIsExposed, userRecoveryStatus } from '../../src/application/recovery/user-status.js';
import type { EnvironmentBaseline } from '../../src/environment/local-workspace-provider.js';

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

test('insufficient evidence stays failed even when an accept handle exists', () => {
  assert.equal(userRecoveryStatus({
    baseline: baseline({
      match: 'current_state_fallback',
      recovery: { status: 'insufficient_evidence', unresolved: ['no git object'], sourceDigest: 'a'.repeat(64), recoveredDigest: 'a'.repeat(64) },
    }),
    transcriptOk: true,
    hasAccept: true,
  }), 'failed');
  assert.equal(userRecoveryStatus({
    baseline: baseline({
      match: 'recovered_partial',
      readiness: { runnable: 'blocked', strictness: 'strict', blockingResourceIds: ['recovery-evidence'] },
      recovery: { status: 'partial', unresolved: [], sourceDigest: 'a'.repeat(64), recoveredDigest: 'b'.repeat(64) },
    }),
    transcriptOk: true,
    hasAccept: true,
  }), 'failed');
});


test('fallback without accept is failed; skipped symlink with accept stays partial', () => {
  assert.equal(userRecoveryStatus({
    baseline: baseline({
      match: 'current_state_fallback',
      recovery: { status: 'failed', unresolved: [], sourceDigest: 'a'.repeat(64), recoveredDigest: 'b'.repeat(64) },
      budget: {
        fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [],
        excludedEntries: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }],
      },
    }),
    transcriptOk: true,
    hasAccept: false,
  }), 'failed');
  assert.equal(userRecoveryStatus({
    baseline: baseline({
      match: 'recovered_partial',
      recovery: { status: 'partial', unresolved: [], sourceDigest: 'a'.repeat(64), recoveredDigest: 'b'.repeat(64) },
      budget: {
        fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [],
        excludedEntries: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }],
      },
    }),
    transcriptOk: true,
    hasAccept: true,
  }), 'partial');
});

test('diagnosis reason prefers failureStage over skipped symlink', () => {
  const crashed = baseline({
    match: 'current_state_fallback',
    recovery: {
      status: 'failed', unresolved: [], sourceDigest: 'a'.repeat(64), recoveredDigest: 'b'.repeat(64),
      failureStage: 'runner_crashed',
    },
    budget: {
      fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [],
      excludedEntries: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }],
    },
  });
  assert.equal(diagnosisReasonCode({ baseline: crashed, transcriptOk: true, failureStage: 'runner_crashed' }), 'runner_crashed');
  assert.equal(diagnosisReasonCode({
    baseline: baseline({
      match: 'recovered',
      budget: {
        fileCount: 1, totalBytes: 1, largestFileBytes: 1, blockedReasons: [],
        excludedEntries: [{ path: 'ppt_build/node_modules', reasonCode: 'workspace.symlink_skipped' }],
      },
    }),
    transcriptOk: true,
  }), 'workspace.symlink_skipped');
  assert.equal(diagnosisReasonCode({
    baseline: baseline({
      match: 'recovered_partial',
      recovery: { status: 'partial', unresolved: ['no git'], sourceDigest: 'a'.repeat(64), recoveredDigest: 'b'.repeat(64) },
    }),
    transcriptOk: true,
    hasAccept: true,
  }), 'weak_or_incomplete_evidence');
});

test('accept is not exposed for insufficient evidence unless Host already auto-accepted', () => {
  assert.equal(recoveryAcceptIsExposed({ envelopeStatus: 'insufficient_evidence', match: 'current_state_fallback', runnable: 'isolated' }), false);
  assert.equal(recoveryAcceptIsExposed({ automaticallyAccepted: true, envelopeStatus: 'insufficient_evidence' }), true);
  assert.equal(recoveryAcceptIsExposed({ envelopeStatus: 'partial', match: 'recovered_partial', runnable: 'isolated' }), true);
});

