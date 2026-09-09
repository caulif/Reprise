import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { Value } from '@sinclair/typebox/value';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecoverySelectionManifest, decideRecoverySearch, prepareRecoverySelectionExecution, selectionAliases, validateRecoverySelectionManifest } from '../src/application/recovery/selection.js';
import { RecoverySelectionDiagnosticsSchema } from '../src/core/schema.js';

const sourceState = { readiness: 'isolated' as const, fingerprint: 'a'.repeat(64), fileCount: 3, warningCount: 0 };
const signals = { userMessages: 1, assistantMessages: 2, toolCalls: 1, completedTurns: 1 };

function entry(productId: string, hashChar: string) {
  return { candidate: { private: true }, metadata: { productId, evidenceLayer: 'transcript' as const, sessionContentHash: hashChar.repeat(64), sourceState, signalCounts: signals } };
}

test('selection manifest is schema-checked, redacted, and product-local deterministic', () => {
  const result = createRecoverySelectionManifest({
    runId: 'run-1', seed: 'fixed-seed', selectedAt: '2026-08-18T00:00:00.000Z',
    entries: [entry('codex', 'a'), entry('codex', 'b'), entry('claude-code', 'c')],
  });
  assert.deepEqual(selectionAliases(result.manifest), ['codex-01', 'codex-02', 'claude-code-01']);
  assert.equal(JSON.stringify(result.manifest).includes('private'), false);
  assert.equal(JSON.stringify(result.manifest).includes('sessionId'), false);
  assert.equal(JSON.stringify(result.manifest).includes('cwd'), false);
  assert.equal(JSON.stringify(result.manifest).includes('task'), false);
  assert.equal(Object.isFrozen(result.manifest), true);
  const first = result.manifest.entries[0];
  assert.ok(first);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { first.alias = 'changed'; }, TypeError);
  const replayed = validateRecoverySelectionManifest(JSON.parse(JSON.stringify(result.manifest)));
  assert.equal(Object.isFrozen(replayed), true);
  assert.deepEqual(selectionAliases(replayed), selectionAliases(result.manifest));
});

test('selection diagnostics reject malformed or source-identifying persisted data', () => {
  const diagnostics = {
    schemaVersion: 1,
    products: [{
      productId: 'codex',
      discoveredCount: 12,
      eligibleMetadataCount: 10,
      selectedCount: 5,
      sourceEligibility: { inspected: 8, isolated: 5, notIsolated: 2, inspectionFailed: 1 },
    }],
  };
  assert.equal(Value.Check(RecoverySelectionDiagnosticsSchema, diagnostics), true);
  assert.equal(Value.Check(RecoverySelectionDiagnosticsSchema, {
    ...diagnostics,
    products: [{ ...diagnostics.products[0]!, sourcePath: 'C:/private' }],
  }), false);
  assert.equal(Value.Check(RecoverySelectionDiagnosticsSchema, {
    ...diagnostics,
    products: [{ ...diagnostics.products[0]!, sourceEligibility: { ...diagnostics.products[0]!.sourceEligibility, isolated: -1 } }],
  }), false);
});
test('selection manifest rejects tampering and does not re-sample', () => {
  const result = createRecoverySelectionManifest({ runId: 'run-2', seed: 'fixed-seed', selectedAt: '2026-08-18T00:00:00.000Z', entries: [entry('codex', 'd')] });
  const tampered = { ...result.manifest, entries: [{ ...result.manifest.entries[0], alias: '../other' }] };
  assert.throws(() => validateRecoverySelectionManifest(tampered), /invalid/);
  assert.deepEqual(selectionAliases(result.manifest), ['codex-01']);
  assert.equal(result.bindings[0]?.candidate.private, true);
});

test('a missing binding is represented as unavailable without changing the frozen alias set', () => {
  const result = createRecoverySelectionManifest({ runId: 'run-3', seed: 'fixed-seed', selectedAt: '2026-08-18T00:00:00.000Z', entries: [entry('codex', 'e'), entry('codex', 'f')] });
  const available = new Set(['codex-02']);
  const outcomes = result.manifest.entries.map((item) => available.has(item.alias) ? 'ready' : 'source_unavailable');
  assert.deepEqual(outcomes, ['source_unavailable', 'ready']);
  assert.deepEqual(selectionAliases(result.manifest), ['codex-01', 'codex-02']);
});


test('deleting the third cwd only makes that frozen case source_unavailable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-selection-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidates = await Promise.all([0, 1, 2, 3].map(async (index) => {
    const cwd = join(root, `cwd-${index}`);
    await mkdir(cwd);
    return { candidate: { cwd }, metadata: { productId: 'codex', evidenceLayer: 'transcript' as const, sessionContentHash: String(index + 1).repeat(64), sourceState, signalCounts: signals } };
  }));
  const frozen = createRecoverySelectionManifest({ runId: 'run-4', seed: 'fixed-seed', selectedAt: '2026-08-18T00:00:00.000Z', entries: candidates });
  const third = candidates[2];
  assert.ok(third);
  await rm(third.candidate.cwd, { recursive: true, force: true });
  const outcomes = await Promise.all(prepareRecoverySelectionExecution(frozen.manifest, frozen.bindings).map(async ({ candidate }) => {
    try { return (await stat(candidate.cwd)).isDirectory() ? 'ready' : 'source_unavailable'; }
    catch { return 'source_unavailable'; }
  }));
  assert.deepEqual(outcomes, ['ready', 'ready', 'source_unavailable', 'ready']);
  assert.deepEqual(selectionAliases(frozen.manifest), ['codex-01', 'codex-02', 'codex-03', 'codex-04']);
});

test("recovery search continues for weak but novel evidence and stops only no-gain or unsafe probes", () => {
  assert.equal(decideRecoverySearch({ newEvidenceRefs: ["fact:a"], knownEvidenceRefs: [], estimatedCost: 1, risk: 0.2, remainingBudget: 2 }).action, "investigate");
  assert.equal(decideRecoverySearch({ newEvidenceRefs: ["fact:a"], knownEvidenceRefs: ["fact:a"], estimatedCost: 1, risk: 0.1, remainingBudget: 2 }).reason, "no_new_evidence");
  assert.equal(decideRecoverySearch({ newEvidenceRefs: ["fact:a", "fact:b"], knownEvidenceRefs: ["fact:a"], estimatedCost: 1, risk: 0.95, remainingBudget: 2 }).reason, "risk_exceeds_gain");
  assert.equal(decideRecoverySearch({ newEvidenceRefs: ["fact:b"], knownEvidenceRefs: [], estimatedCost: 1, risk: 0, remainingBudget: 0 }).reason, "budget_exhausted");
  assert.equal(decideRecoverySearch({ newEvidenceRefs: ["fact:b"], knownEvidenceRefs: [], estimatedCost: 3, risk: 0, remainingBudget: 2 }).reason, "budget_exhausted");
  assert.throws(() => decideRecoverySearch({ newEvidenceRefs: ["fact:b"], knownEvidenceRefs: [], estimatedCost: -1, risk: 0, remainingBudget: 2 }), /cost/);
});

