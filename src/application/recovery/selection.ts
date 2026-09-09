import { Value } from '@sinclair/typebox/value';
import { RecoverySelectionManifestSchema, type RecoverySelectionManifest } from '../../core/schema.js';

export type RecoverySelectionCandidate = {
  readonly productId: string;
  readonly evidenceLayer: 'history' | 'transcript';
  readonly sessionContentHash: string;
  readonly sourceState: RecoverySelectionManifest['entries'][number]['sourceState'];
  readonly signalCounts: RecoverySelectionManifest['entries'][number]['signalCounts'];
};

export type RecoverySelectionBinding<T> = {
  readonly candidate: T;
  readonly metadata: RecoverySelectionCandidate;
};

/**
 * Freezes the chosen aliases separately from their private runtime bindings.
 * The persisted manifest deliberately contains no session id, cwd, source path, or task text.
 */
export function createRecoverySelectionManifest<T>(input: {
  readonly runId: string;
  readonly seed: string;
  readonly selectedAt: string;
  readonly entries: readonly RecoverySelectionBinding<T>[];
}): { readonly manifest: RecoverySelectionManifest; readonly bindings: readonly RecoverySelectionBinding<T>[] } {
  const ordinals = new Map<string, number>();
  const manifest = {
    schemaVersion: 1 as const,
    runId: input.runId,
    seed: input.seed,
    selectedAt: input.selectedAt,
    entries: input.entries.map((entry) => {
      const ordinal = (ordinals.get(entry.metadata.productId) ?? 0) + 1;
      ordinals.set(entry.metadata.productId, ordinal);
      return {
      alias: aliasFor(entry.metadata.productId, ordinal),
      productId: entry.metadata.productId,
      evidenceLayer: entry.metadata.evidenceLayer,
      sessionContentHash: entry.metadata.sessionContentHash,
      sourceState: entry.metadata.sourceState,
      signalCounts: entry.metadata.signalCounts,
      };
    }),
  };
  if (!Value.Check(RecoverySelectionManifestSchema, manifest)) throw new Error('Recovery selection manifest is invalid.');
  freezeManifest(manifest);
  return { manifest, bindings: input.entries.map((entry) => ({ ...entry })) };
}

/** Validates a manifest loaded from disk before it can influence execution. */
export function validateRecoverySelectionManifest(value: unknown): RecoverySelectionManifest {
  if (!Value.Check(RecoverySelectionManifestSchema, value)) throw new Error('Recovery selection manifest is invalid.');
  freezeManifest(value);
  return value;
}

/** Returns aliases in manifest order; no discovery or re-sampling occurs here. */
export function selectionAliases(manifest: RecoverySelectionManifest): readonly string[] {
  validateRecoverySelectionManifest(manifest);
  return manifest.entries.map((entry) => entry.alias);
}

/**
 * Joins private, in-memory bindings to their frozen public entries without permitting re-selection.
 * A missing or mismatched binding is deliberately a per-case execution concern, not a reason to select again.
 */
export function prepareRecoverySelectionExecution<T>(
  manifest: RecoverySelectionManifest,
  bindings: readonly RecoverySelectionBinding<T>[],
): readonly { readonly alias: string; readonly selection: RecoverySelectionManifest['entries'][number]; readonly candidate: T }[] {
  validateRecoverySelectionManifest(manifest);
  if (manifest.entries.length !== bindings.length) throw new Error('Recovery selection binding count does not match manifest.');
  return manifest.entries.map((selection, index) => {
    const binding = bindings[index];
    if (!binding || binding.metadata.productId !== selection.productId || binding.metadata.sessionContentHash !== selection.sessionContentHash)
      throw new Error('Recovery selection binding does not match manifest.');
    return { alias: selection.alias, selection, candidate: binding.candidate };
  });
}

function freezeManifest(manifest: RecoverySelectionManifest): void {
  for (const entry of manifest.entries) {
    Object.freeze(entry.sourceState);
    Object.freeze(entry.signalCounts);
    Object.freeze(entry);
  }
  Object.freeze(manifest.entries);
  Object.freeze(manifest);
}

function aliasFor(productId: string, ordinal: number): string {
  return `${productId}-${String(ordinal).padStart(2, '0')}`;
}

export type RecoverySearchDecision = {
  readonly action: "investigate" | "stop";
  readonly informationGain: number;
  readonly risk: number;
  readonly cost: number;
  readonly reason: "new_evidence" | "no_new_evidence" | "risk_exceeds_gain" | "budget_exhausted";
};

/**
 * Scores a proposed probe without turning weak evidence into an early exit.
 * A zero-gain probe is stopped; any probe with new evidence remains eligible
 * unless its explicit risk or budget makes it unsafe.
 */
export function decideRecoverySearch(input: {
  readonly newEvidenceRefs: readonly string[];
  readonly knownEvidenceRefs: readonly string[];
  readonly estimatedCost: number;
  readonly risk: number;
  readonly remainingBudget: number;
}): RecoverySearchDecision {
  if (!Number.isFinite(input.estimatedCost) || input.estimatedCost < 0)
    throw new Error("Recovery probe cost must be a finite non-negative number.");
  if (!Number.isFinite(input.risk) || input.risk < 0 || input.risk > 1)
    throw new Error("Recovery probe risk must be between 0 and 1.");
  if (!Number.isFinite(input.remainingBudget) || input.remainingBudget < 0)
    throw new Error("Recovery search budget must be a finite non-negative number.");
  if (input.remainingBudget <= 0 || input.estimatedCost > input.remainingBudget) return { action: "stop", informationGain: 0, risk: input.risk, cost: input.estimatedCost, reason: "budget_exhausted" };
  const known = new Set(input.knownEvidenceRefs);
  const informationGain = new Set(input.newEvidenceRefs).size === 0
    ? 0
    : [...new Set(input.newEvidenceRefs)].filter((ref) => !known.has(ref)).length / new Set(input.newEvidenceRefs).size;
  if (informationGain === 0) return { action: "stop", informationGain, risk: input.risk, cost: input.estimatedCost, reason: "no_new_evidence" };
  if (input.risk > informationGain && input.risk > 0.8) return { action: "stop", informationGain, risk: input.risk, cost: input.estimatedCost, reason: "risk_exceeds_gain" };
  return { action: "investigate", informationGain, risk: input.risk, cost: input.estimatedCost, reason: "new_evidence" };
}

