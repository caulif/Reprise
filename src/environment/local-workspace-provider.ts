import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SAFE_ID, writeAtomic } from '../core/identity.js';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RecoveryCheckpointRecordSchema, type RecoveryCheckpointRecord, type RecoveryControlledWrite } from '../core/schema.js';
import { getRecoveryControlledWriteBinding, replayControlledRecoveryDeltaBytes } from '../infrastructure/recovery-write-journal.js';
import {
  copyTree as copyTree,
  assertId as assertId,
  isMissing as isMissing,
  unsupportedBaseline as unsupportedBaseline,
  isInside as isInside,
  fingerprintTree as fingerprintTree,
  recoveryPath as recoveryPath,
  assertNoSymlinkAncestors as assertNoSymlinkAncestors,
  ensureRegularRecoveryTarget as ensureRegularRecoveryTarget,
  removeRecoveryFile as removeRecoveryFile,
  exists,
  publishDirectory as publishDirectory,
  removeCaptureArtifacts as removeCaptureArtifacts,
  readBaselineMarker as readBaselineMarker,
  loadSealedBaseline as loadSealedBaseline,
  isRecoveryEnvelope as isRecoveryEnvelope,
  readRecoveryReport as readRecoveryReport,
  candidateChangedPaths as candidateChangedPaths,
  assertRecoveryPathBoundary as assertRecoveryPathBoundary,
  changedPaths as changedPaths,
  cleanupRecoveryTransients as cleanupRecoveryTransients,
} from './local-workspace-fs.js';
import { gitSinkRoot, isolateGitTopology } from './git-sink.js';
export {
  publishDirectory as publishDirectory,
  calculateWorkspaceBudget as calculateWorkspaceBudget,
} from './local-workspace-fs.js';


export const MAX_INLINE_HASH_BYTES = 8 * 1024 * 1024;

export class RecoveryValidationError extends Error {
  constructor(readonly code: 'source_tripwire_failed' | 'provider_validation_failed', message: string) {
    super(message);
  }
}

type JsonRecord = Record<string, unknown>;
type EnvironmentSource = { caseId: string; sourceRoot: string; checkpointRoot?: string; playbook?: RecoveryPlaybookProvenance };
export type RecoveryCheckpoint = { checkpointId: string; caseId: string; root: string; fingerprint: EnvironmentFingerprint; budget: WorkspaceBudget };
export type RecoveryPlaybookProvenance = { productId: string; version: string; sha256: string };
type EnvironmentClue = JsonRecord;
type EnvironmentPolicy = JsonRecord;
export type FingerprintEntry = { path: string; kind: 'file' | 'directory'; size: number; contentHash?: string };
type TreeCopier = (source: string, destination: string) => Promise<void>;

export type EnvironmentFingerprint = {
  capturedAt: string;
  resources: FingerprintEntry[];
  digest: string;
};

export type SensitiveFileCategory = 'env' | 'credential' | 'private_key';
export type SensitiveFileCounts = Readonly<Record<SensitiveFileCategory, number>>;

export type WorkspaceExclusionReason =
  | 'workspace.symlink_skipped'
  | 'workspace.permission_denied'
  | 'workspace.target_missing'
  | 'workspace.cycle_skipped'
  | 'workspace.unsupported_entry'
  | 'workspace.budget_skipped';

export type WorkspaceExclusion = {
  path: string;
  reasonCode: WorkspaceExclusionReason;
};

export type WorkspaceBudget = {
  fileCount: number;
  totalBytes: number;
  largestFileBytes: number;
  blockedReasons: readonly string[];
  /** Category counts only; paths and contents never leave the provider scan. */
  sensitiveFileCounts?: SensitiveFileCounts;
  /** Link, permission, and other skipped paths; never followed out of the source root. */
  excludedEntries?: readonly WorkspaceExclusion[];
};

export type EnvironmentBaseline = {
  baselineId: string;
  caseId: string;
  mode: 'canonical' | 'unsupported';
  match: 'matched' | 'observational' | 'recovered' | 'recovered_partial' | 'current_state_fallback';
  resources: [];
  readiness: {
    runnable: 'isolated' | 'blocked' | 'unsupported';
    strictness: 'strict';
    blockingResourceIds: string[];
  };
  fingerprint: EnvironmentFingerprint;
  budget: WorkspaceBudget;
  capabilities: {
    canFork: boolean;
    fingerprints: ['file_tree'];
    externalSideEffects: 'none';
  };
  warnings: string[];
  recovery?: {
    /** New writes are ready | blocked | failed; recovered | partial | insufficient_evidence are disk-read only. */
    status: 'ready' | 'blocked' | 'failed' | 'recovered' | 'partial' | 'insufficient_evidence';
    /** Host-owned task continuation outcome; agent status alone is not task readiness. */
    taskOutcome?: 'ready_for_task' | 'unrecoverable' | 'blocked_by_safety' | 'runner_failed';
    reportRef?: string;
    unresolved: string[];
    sourceDigest: string;
    recoveredDigest: string;
    sourceTripwire?: { before: string; after: string };
    playbook?: RecoveryPlaybookProvenance;
    failureStage?: 'preflight_failed' | 'agent_model_failed' | 'agent_timeout' | 'agent_tool_failed' | 'agent_invalid_output' | 'provider_validation_failed' | 'source_tripwire_failed' | 'cancelled' | 'runner_crashed';
    failureDetail?: { operation: string; reasonCode: string; exitCategory: string; retryable: boolean };
    accepted?: boolean;
  };
  createdAt: string;
  root?: string;
};

export type PreparedEnvironmentRef = {
  environmentId: string;
  baselineId: string;
  runId: string;
  mode: 'isolated';
  root: string;
  resources: [{ resourceId: string; mode: 'isolated'; bindingRef: string; writable: true; owner: 'harness' }];
  manifestRef: string;
  beforeFingerprint: EnvironmentFingerprint;
};

export type ReleaseResult = { status: 'released' | 'already_released'; environmentId: string };

export type RecoveryEnvelope = {
  status: 'ready' | 'blocked';
  reportPath: 'recovery.md';
  unresolved: string[];
  evidenceRefs?: string[];
  manifestPath?: 'recovery-manifest.json';
};

export type RecoveryStaging = {
  recoveryId: string;
  caseId: string;
  sourceRoot: string;
  root: string;
  sourceFingerprint: EnvironmentFingerprint;
  sourceBudget: WorkspaceBudget;
  sourceTripwireBefore: EnvironmentFingerprint;
  checkpointRoot?: string;
  checkpointId?: string;
  checkpointFingerprint?: EnvironmentFingerprint;
  temporaryRoot?: string;
  playbook?: RecoveryPlaybookProvenance;
};

export type RecoveryPreview = {
  recoveryId: string;
  baseline: EnvironmentBaseline;
  reportText?: string;
  changedPaths: readonly string[];
  accepted: boolean;
};

export class LocalWorkspaceProvider {
  readonly #root: string;
  readonly #copyTree: TreeCopier;
  readonly #preparedRoots = new Map<string, string>();
  readonly #recoveryStaging = new Map<string, RecoveryStaging>();
  readonly #recoveryCheckpoints = new Map<string, RecoveryCheckpoint>();

  constructor(root: string, copy = copyTree) {
    if (!isAbsolute(root)) throw new Error('Environment root must be an absolute path.');
    this.#root = resolve(root);
    this.#copyTree = copy;
  }

  /**
   * Reads and fingerprints a potential source baseline without copying or
   * modifying it. Candidate isolation is created only by prepareRun().
   */
  async inspectBaseline(source: EnvironmentSource, _clues: EnvironmentClue[], _policy: EnvironmentPolicy): Promise<EnvironmentBaseline> {
    assertId(source.caseId, 'caseId');
    const sourceRoot = resolve(source.sourceRoot);
    let sourceInfo;
    try {
      sourceInfo = await lstat(sourceRoot);
    } catch (error) {
      if (isMissing(error)) return unsupportedBaseline(source.caseId);
      throw error;
    }
    if (!sourceInfo.isDirectory()) throw new Error('Environment source must be a directory.');
    if (sourceRoot === this.#root || isInside(this.#root, sourceRoot) || isInside(sourceRoot, this.#root)) {
      throw new Error('Environment source and provider workspace must not overlap.');
    }
    const captured = await fingerprintTree(sourceRoot);
    const { fingerprint, budget } = captured;
    const excluded = budget.excludedEntries ?? [];
    return {
      baselineId: `baseline-${source.caseId}`,
      caseId: source.caseId,
      mode: 'canonical',
      match: 'matched',
      resources: [],
      readiness: { runnable: budget.blockedReasons.length ? 'blocked' : 'isolated', strictness: 'strict', blockingResourceIds: budget.blockedReasons.length ? ['workspace-budget'] : [] },
      fingerprint,
      budget,
      capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
      warnings: [
        ...budget.blockedReasons,
        ...excluded.map((item) => `${item.path}: ${item.reasonCode}`),
      ],
      createdAt: new Date().toISOString(),
    };
  }

  /** Captures an immutable provider-owned copy before a task can mutate its source. */
  async captureRecoveryCheckpoint(source: { caseId: string; sourceRoot: string }): Promise<RecoveryCheckpoint> {
    const inspected = await this.inspectBaseline(source, [], {});
    const checkpointId = `checkpoint-${source.caseId}-${randomUUID()}`;
    const root = join(this.#root, 'recovery-checkpoints', checkpointId);
    await mkdir(dirname(root), { recursive: true });
    try {
      await mkdir(root);
      await this.#copyTree(resolve(source.sourceRoot), root);
      const captured = await fingerprintTree(root);
      if (captured.fingerprint.digest !== inspected.fingerprint.digest)
        throw new Error('Recovery checkpoint changed while it was being captured.');
      const checkpoint = { checkpointId, caseId: source.caseId, root, fingerprint: captured.fingerprint, budget: captured.budget };
      await this.#persistRecoveryCheckpoint(checkpoint);
      this.#recoveryCheckpoints.set(checkpointId, checkpoint);
      return checkpoint;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  /** Captures a reviewed provider-owned staging tree without treating it as the user source. */
  async captureRecoveryCheckpointFromStaging(staging: RecoveryStaging): Promise<RecoveryCheckpoint> {
    this.#assertRecoveryStaging(staging);
    const captured = await fingerprintTree(staging.root);
    const checkpointId = `checkpoint-${staging.caseId}-review-${randomUUID()}`;
    const root = join(this.#root, 'recovery-checkpoints', checkpointId);
    await mkdir(dirname(root), { recursive: true });
    try {
      await mkdir(root);
      await this.#copyTree(staging.root, root);
      const checkpoint = { checkpointId, caseId: staging.caseId, root, fingerprint: captured.fingerprint, budget: captured.budget };
      await this.#persistRecoveryCheckpoint(checkpoint);
      this.#recoveryCheckpoints.set(checkpointId, checkpoint);
      return checkpoint;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async #persistRecoveryCheckpoint(checkpoint: RecoveryCheckpoint): Promise<void> {
    const record: RecoveryCheckpointRecord = {
      schemaVersion: 1,
      checkpointId: checkpoint.checkpointId,
      caseId: checkpoint.caseId,
      fingerprint: checkpoint.fingerprint,
      budget: {
        fileCount: checkpoint.budget.fileCount,
        totalBytes: checkpoint.budget.totalBytes,
        largestFileBytes: checkpoint.budget.largestFileBytes,
        blockedReasons: [...checkpoint.budget.blockedReasons],
        ...(checkpoint.budget.excludedEntries ? { excludedEntries: [...checkpoint.budget.excludedEntries] } : {}),
      },
    };
    if (!Value.Check(RecoveryCheckpointRecordSchema, record))
      throw new Error('Recovery checkpoint metadata does not match RecoveryCheckpointRecordSchema.');
    await writeAtomic(this.#checkpointMetadataPath(checkpoint.checkpointId), `${JSON.stringify(record)}\r\n`);
  }

  async #resolveRecoveryCheckpoint(root: string, caseId: string): Promise<RecoveryCheckpoint> {
    const checkpointId = basename(root);
    if (root !== join(this.#root, 'recovery-checkpoints', checkpointId) || !SAFE_ID.test(checkpointId))
      throw new Error('Recovery checkpoint is not owned by this provider.');
    const cached = this.#recoveryCheckpoints.get(checkpointId);
    if (cached?.root === root && cached.caseId === caseId) return cached;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#checkpointMetadataPath(checkpointId), 'utf8'));
    } catch {
      throw new Error('Recovery checkpoint is not owned by this provider.');
    }
    if (!Value.Check(RecoveryCheckpointRecordSchema, parsed) || parsed.caseId !== caseId)
      throw new Error('Recovery checkpoint is not owned by this provider.');
    const checkpoint: RecoveryCheckpoint = { ...parsed, root };
    this.#recoveryCheckpoints.set(checkpoint.checkpointId, checkpoint);
    return checkpoint;
  }

  #checkpointMetadataPath(checkpointId: string): string {
    return join(this.#root, 'recovery-checkpoints', `${checkpointId}.json`);
  }
  /**
   * Creates an unpublished, provider-owned recovery copy.  The caller may only
   * obtain this path to pass it to the Recovery tool whitelist; publishing still
   * requires validateRecovery() and acceptRecovery().
   */
  async beginRecovery(source: EnvironmentSource, clues: EnvironmentClue[] = [], policy: EnvironmentPolicy = {}): Promise<RecoveryStaging> {
    const inspected = await this.inspectBaseline(source, clues, policy);
    if (inspected.mode !== 'canonical' || inspected.readiness.runnable !== 'isolated') {
      throw new Error(`Environment source for ${source.caseId} cannot be recovered.`);
    }
    const recoveriesRoot = join(this.#root, 'rs');
    await mkdir(recoveriesRoot, { recursive: true });
    const recoveryId = randomUUID().replaceAll('-', '');
    const root = join(recoveriesRoot, recoveryId);
    const temporaryRoot = join(this.#root, 'rt', recoveryId);
    try {
      await mkdir(root);
      await mkdir(temporaryRoot, { recursive: true });
      const sourceRoot = resolve(source.sourceRoot);
      const checkpointRoot = source.checkpointRoot ? resolve(source.checkpointRoot) : undefined;
      let checkpointId: string | undefined;
      let checkpointFingerprint: EnvironmentFingerprint | undefined;
      if (checkpointRoot) {
        if (!isInside(this.#root, checkpointRoot) || checkpointRoot === this.#root || isInside(this.#root, sourceRoot) || isInside(sourceRoot, checkpointRoot))
          throw new Error('Recovery checkpoint must be an independent provider-owned directory.');
        const checkpointRecord = await this.#resolveRecoveryCheckpoint(checkpointRoot, source.caseId);
        const checkpointInfo = await lstat(checkpointRoot);
        if (!checkpointInfo.isDirectory()) throw new Error('Recovery checkpoint must be a directory.');
        const checkpoint = await fingerprintTree(checkpointRoot);
        if (checkpoint.budget.blockedReasons.length) throw new Error('Recovery checkpoint exceeds workspace budget.');
        if (checkpoint.fingerprint.digest !== checkpointRecord.fingerprint.digest)
          throw new Error('Recovery checkpoint fingerprint does not match its captured digest.');
        checkpointId = checkpointRecord.checkpointId;
        checkpointFingerprint = checkpoint.fingerprint;
        await this.#copyTree(checkpointRoot, root);
      } else {
        await this.#copyTree(sourceRoot, root);
      }
      await isolateGitTopology(root, gitSinkRoot(this.#root, recoveryId));
      const staging: RecoveryStaging = { recoveryId, caseId: source.caseId, sourceRoot, root, sourceFingerprint: inspected.fingerprint, sourceBudget: inspected.budget, sourceTripwireBefore: inspected.fingerprint, ...(checkpointRoot ? { checkpointRoot } : {}), ...(checkpointId ? { checkpointId } : {}), ...(checkpointFingerprint ? { checkpointFingerprint } : {}), temporaryRoot, ...(source.playbook ? { playbook: source.playbook } : {}) };
      this.#recoveryStaging.set(recoveryId, staging);
      return staging;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Applies an artifact-backed direct-write journal to an isolated staging tree.
   * The operation is transactional at the provider boundary: writes happen in a
   * temporary copy and replace staging only after every artifact and path check
   * succeeds.
   */
  async applyControlledRecoveryDelta(
    staging: RecoveryStaging,
    entries: readonly RecoveryControlledWrite[],
    readArtifact: (artifactId: string) => Promise<Uint8Array>,
    expectedDigest?: string,
  ): Promise<EnvironmentFingerprint> {
    this.#assertRecoveryStaging(staging);
    const current = (await fingerprintTree(staging.root)).fingerprint;
    const baselineDigest = expectedDigest ?? staging.checkpointFingerprint?.digest ?? staging.sourceFingerprint.digest;
    if (current.digest !== baselineDigest)
      throw new Error('Recovery delta base fingerprint does not match the owned staging tree.');
    const binding = getRecoveryControlledWriteBinding(entries);
    if (binding) {
      if (binding.baseDigest !== baselineDigest || binding.baseDigest !== current.digest)
        throw new Error('Recovery delta journal base fingerprint does not match the owned staging tree.');
      if (binding.checkpointId !== staging.checkpointId)
        throw new Error('Recovery delta journal checkpoint does not belong to this staging tree.');
    }
    const replayed = await replayControlledRecoveryDeltaBytes(entries, readArtifact);
    const temporary = join(staging.root, '..', `${basename(staging.root)}-delta-${randomUUID()}`);
    await mkdir(temporary, { recursive: true });
    try {
      await this.#copyTree(staging.root, temporary);
      for (const [relativePath, state] of replayed) {
        const target = recoveryPath(temporary, relativePath);
        await assertNoSymlinkAncestors(temporary, relativePath);
        if (!state) {
          await removeRecoveryFile(target);
          continue;
        }
        await ensureRegularRecoveryTarget(target);
        await writeAtomic(target, state.bytes);
      }
      const result = (await fingerprintTree(temporary)).fingerprint;
      await rm(staging.root, { recursive: true, force: true });
      await rename(temporary, staging.root);
      return result;
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  /** Recopy the user source onto staging. Callers must also `releasePreparation` so Recovery restarts all three turns. */
  async resetRecoveryWorkspace(staging: RecoveryStaging): Promise<void> {
    this.#assertRecoveryStaging(staging);
    const temporary = join(this.#root, 'rt', `${staging.recoveryId}-reset-${randomUUID()}`);
    await mkdir(temporary, { recursive: true });
    try {
      await this.#copyTree(staging.sourceRoot, temporary);
      await rm(staging.root, { recursive: true, force: true });
      await mkdir(staging.root, { recursive: true });
      await this.#copyTree(temporary, staging.root);
      await isolateGitTopology(staging.root, gitSinkRoot(this.#root, staging.recoveryId));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async fingerprintRecoveryStaging(staging: RecoveryStaging): Promise<EnvironmentFingerprint> {
    this.#assertRecoveryStaging(staging);
    return (await fingerprintTree(staging.root)).fingerprint;
  }

  /** Mechanical checks only; never ranks evidence or rewrites ready/blocked from changed paths. */
  async validateRecovery(staging: RecoveryStaging, result: RecoveryEnvelope): Promise<RecoveryPreview> {
    this.#assertRecoveryStaging(staging);
    let reportText: string | undefined;
    let sourceTripwireAfter: EnvironmentFingerprint;
    try {
      await this.probeRecovery(staging, result);
      if (!isRecoveryEnvelope(result)) throw new Error('Recovery result is invalid.');
      sourceTripwireAfter = (await fingerprintTree(staging.sourceRoot)).fingerprint;
      reportText = await readRecoveryReport(staging.root);
      await cleanupRecoveryTransients(staging.root);
      if (staging.temporaryRoot) await rm(staging.temporaryRoot, { recursive: true, force: true });
      const captured = await fingerprintTree(staging.root);
      if (captured.budget.blockedReasons.length) throw new Error(captured.budget.blockedReasons.join(' '));
      const changed = changedPaths(staging.sourceFingerprint, captured.fingerprint).filter((path) => path !== 'recovery.md' && path !== 'recovery-manifest.json' && path !== '.reprise/recovery-work' && !path.startsWith('.reprise/recovery-work/'));
      assertRecoveryPathBoundary(changed);
      const recovery: NonNullable<EnvironmentBaseline['recovery']> = {
        status: result.status,
        ...(reportText ? { reportRef: 'recovery-md' } : {}),
        unresolved: [...result.unresolved],
        sourceDigest: staging.sourceFingerprint.digest,
        recoveredDigest: captured.fingerprint.digest,
        sourceTripwire: { before: staging.sourceTripwireBefore.digest, after: sourceTripwireAfter.digest },
        ...(staging.playbook ? { playbook: staging.playbook } : {}),
      };
      const match = result.status === 'ready' ? 'recovered' : 'current_state_fallback';
      const baseline: EnvironmentBaseline = {
        baselineId: `baseline-${staging.caseId}`, caseId: staging.caseId, mode: 'canonical', match, resources: [],
        readiness: {
          runnable: result.status === 'ready' ? 'isolated' : 'blocked',
          strictness: 'strict',
          blockingResourceIds: result.status === 'ready' ? [] : ['recovery-blocked'],
        }, fingerprint: captured.fingerprint, budget: captured.budget,
        capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
        warnings: [],
        recovery, createdAt: new Date().toISOString(), root: staging.root,
      };
      return { recoveryId: staging.recoveryId, baseline, ...(reportText ? { reportText } : {}), changedPaths: [...changed], accepted: false };
    } catch (error) {
      await this.discardRecovery(staging);
      throw error;
    }
  }

  /** Same checks as validateRecovery, but never unlinks sinks or discards staging. */
  async probeRecovery(staging: RecoveryStaging, result: RecoveryEnvelope): Promise<void> {
    this.#assertRecoveryStaging(staging);
    const root = staging.root;
    try {
      if (!isRecoveryEnvelope(result)) throw new RecoveryValidationError("provider_validation_failed", "Recovery result is invalid.");
      const sourceTripwireAfter = (await fingerprintTree(staging.sourceRoot)).fingerprint;
      if (sourceTripwireAfter.digest !== staging.sourceTripwireBefore.digest) throw new RecoveryValidationError("source_tripwire_failed", "Recovery changed the user source directory; staging will be discarded.");
      try {
        await readRecoveryReport(root);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new RecoveryValidationError("provider_validation_failed", message.includes("ENOENT") || message.includes("no such file") ? "Recovery report recovery.md is missing." : message);
      }
      const captured = await fingerprintTree(root);
      if (captured.budget.blockedReasons.length) throw new RecoveryValidationError("provider_validation_failed", captured.budget.blockedReasons.join(" "));
      const changed = candidateChangedPaths(staging.sourceFingerprint, captured.fingerprint)
        .filter((path) => path !== "recovery.md" && path !== "recovery-manifest.json" && !path.startsWith(".reprise/recovery-work"));
      assertRecoveryPathBoundary(changed);
    } catch (error) {
      if (error instanceof RecoveryValidationError) throw error;
      throw new RecoveryValidationError("provider_validation_failed", error instanceof Error ? error.message : String(error));
    }
  }

  /** Publishes a previously validated preview; this is the operator confirmation boundary. */
  async acceptRecovery(preview: RecoveryPreview): Promise<EnvironmentBaseline> {
    const staging = this.#recoveryStaging.get(preview.recoveryId);
    if (!staging || preview.accepted || preview.baseline.root !== staging.root) throw new Error('Recovery preview is no longer available.');
    if (preview.baseline.recovery?.status === 'blocked' || preview.baseline.readiness.runnable === 'blocked') {
      throw new Error('Blocked Recovery cannot be published as a baseline.');
    }
    const baselineRoot = join(this.#root, 'baselines', staging.caseId);
    const markerPath = join(dirname(baselineRoot), `${staging.caseId}.marker.json`);
    if (await exists(baselineRoot) || await exists(markerPath)) throw new Error(`A baseline already exists for ${staging.caseId}.`);
    await mkdir(dirname(baselineRoot), { recursive: true });
    try {
      await publishDirectory(staging.root, baselineRoot);
      await isolateGitTopology(baselineRoot, gitSinkRoot(this.#root, `baseline-${staging.caseId}`));
      await writeFile(markerPath, JSON.stringify({ sourceFingerprint: staging.sourceFingerprint.digest, recovery: preview.baseline.recovery }), { flag: 'wx' });
      this.#recoveryStaging.delete(staging.recoveryId);
      return { ...preview.baseline, root: baselineRoot };
    } catch (error) {
      await removeCaptureArtifacts(staging.root, baselineRoot, markerPath);
      this.#recoveryStaging.delete(staging.recoveryId);
      throw error;
    }
  }

  async discardRecovery(staging: RecoveryStaging): Promise<void> {
    const owned = this.#recoveryStaging.get(staging.recoveryId);
    if (!owned || owned.root !== staging.root) return;
    this.#recoveryStaging.delete(staging.recoveryId);
    await rm(staging.root, { recursive: true, force: true });
    if (staging.temporaryRoot) await rm(staging.temporaryRoot, { recursive: true, force: true });
  }

  #assertRecoveryStaging(staging: RecoveryStaging): void {
    const owned = this.#recoveryStaging.get(staging.recoveryId);
    if (!owned || owned.root !== staging.root || !isInside(this.#root, staging.root)) throw new Error('Recovery staging is not owned by this provider.');
  }

  /** Copies a previously inspected source into provider-owned baseline storage. */
  async resolveBaseline(source: EnvironmentSource, clues: EnvironmentClue[], policy: EnvironmentPolicy): Promise<EnvironmentBaseline> {
    const inspected = await this.inspectBaseline(source, clues, policy);
    const baselineRoot = join(this.#root, 'baselines', source.caseId);
    const baselinesRoot = dirname(baselineRoot);
    const markerPath = join(baselinesRoot, `${source.caseId}.marker.json`);
    const recorded = await readBaselineMarker(markerPath);
    const baselineExists = await exists(baselineRoot);
    if (inspected.mode === 'unsupported') {
      if (recorded && baselineExists) return loadSealedBaseline(source.caseId, baselineRoot, recorded);
      return inspected;
    }
    if (inspected.readiness.runnable === 'blocked') return inspected;
    await mkdir(baselinesRoot, { recursive: true });

    if (recorded !== undefined && recorded.sourceFingerprint !== inspected.fingerprint.digest) {
      // Silently reusing a stale copy would make the whole run compare against the wrong tree.
      throw new Error(`Environment source for case ${source.caseId} changed since its baseline was captured. Use a new caseId, or delete ${baselineRoot} to recapture it.`);
    }
    if (recorded === undefined && baselineExists) {
      // A missing marker makes an existing baseline uncommitted residue, never a reusable copy.
      await rm(baselineRoot, { recursive: true, force: true });
    }
    if (recorded === undefined || !baselineExists) {
      const stagingRoot = join(baselinesRoot, `.${source.caseId}.staging-${process.pid}-${randomUUID()}`);
      try {
        await mkdir(stagingRoot);
        await this.#copyTree(resolve(source.sourceRoot), stagingRoot);
        await publishDirectory(stagingRoot, baselineRoot);
        await isolateGitTopology(baselineRoot, gitSinkRoot(this.#root, `baseline-${source.caseId}`));
        await rm(markerPath, { force: true });
        await writeFile(markerPath, JSON.stringify({ sourceFingerprint: inspected.fingerprint.digest, ...(recorded?.recovery ? { recovery: recorded.recovery } : {}) }), { flag: 'wx' });
      } catch (error) {
        await removeCaptureArtifacts(stagingRoot, baselineRoot, markerPath);
        throw error;
      }
    }

    try {
      const { fingerprint } = await fingerprintTree(baselineRoot);
      return { ...inspected, fingerprint, root: baselineRoot, ...(recorded?.recovery ? { recovery: recorded.recovery, match: recorded.recovery.status === 'ready' || recorded.recovery.status === 'recovered' ? 'recovered' : recorded.recovery.status === 'partial' ? 'recovered_partial' : 'current_state_fallback' } : {}) };
    } catch (error) {
      if (recorded === undefined) await removeCaptureArtifacts(undefined, baselineRoot, markerPath);
      throw error;
    }
  }
  async prepareRun(baseline: EnvironmentBaseline, runId: string): Promise<PreparedEnvironmentRef> {
    assertId(runId, 'runId');
    if (baseline.mode !== 'canonical' || baseline.readiness.runnable !== 'isolated' || !baseline.root) {
      throw new Error(`Environment baseline ${baseline.baselineId} is unsupported.`);
    }
    const baselineRoot = resolve(baseline.root);
    if (!isInside(this.#root, baselineRoot)) throw new Error('Environment baseline is outside the provider workspace.');
    const runRoot = join(this.#root, 'runs', runId);
    await mkdir(dirname(runRoot), { recursive: true });
    await mkdir(runRoot);
    let beforeFingerprint: EnvironmentFingerprint;
    try {
      await this.#copyTree(baselineRoot, runRoot);
      await cleanupRecoveryTransients(runRoot);
      await isolateGitTopology(runRoot, gitSinkRoot(this.#root, runId));
      beforeFingerprint = (await fingerprintTree(runRoot)).fingerprint;
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
    this.#preparedRoots.set(`environment-${runId}`, runRoot);
    return {
      environmentId: `environment-${runId}`,
      baselineId: baseline.baselineId,
      runId,
      mode: 'isolated',
      root: runRoot,
      resources: [{ resourceId: 'workspace', mode: 'isolated', bindingRef: runRoot, writable: true, owner: 'harness' }],
      manifestRef: `environment:${runId}`,
      beforeFingerprint,
    };
  }

  candidateSnapshotRoot(runId: string): string {
    assertId(runId, 'runId');
    return join(this.#root, 'snapshots', runId);
  }

  async candidateSnapshot(runId: string): Promise<{ root: string; status: 'complete' | 'incomplete' | 'missing' }> {
    const root = this.candidateSnapshotRoot(runId);
    if (await exists(join(this.#root, 'snapshots', `${runId}.complete`))) return { root, status: 'complete' };
    if (await exists(join(this.#root, 'snapshots', `${runId}.incomplete`))) return { root, status: 'incomplete' };
    return { root, status: 'missing' };
  }

  /** Copies the run workspace to an immutable comparison snapshot before release. */
  async sealCandidateSnapshot(environment: PreparedEnvironmentRef): Promise<{ root: string; status: 'complete' | 'incomplete' }> {
    this.#assertOwnedEnvironment(environment);
    const snapshotRoot = this.candidateSnapshotRoot(environment.runId);
    const snapshotsRoot = dirname(snapshotRoot);
    const staging = join(snapshotsRoot, `.${environment.runId}.staging-${process.pid}-${randomUUID()}`);
    const completeMarker = join(snapshotsRoot, `${environment.runId}.complete`);
    const incompleteMarker = join(snapshotsRoot, `${environment.runId}.incomplete`);
    try {
      await mkdir(snapshotsRoot, { recursive: true });
      await mkdir(staging);
      await this.#copyTree(environment.root, staging);
      await publishDirectory(staging, snapshotRoot);
      await rm(incompleteMarker, { force: true });
      await writeFile(completeMarker, '');
      return { root: snapshotRoot, status: 'complete' };
    } catch {
      // Staging copy or publish failed; the live run directory must not be treated as a final snapshot.
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(snapshotRoot, { recursive: true });
      await writeFile(incompleteMarker, '');
      await rm(completeMarker, { force: true });
      return { root: snapshotRoot, status: 'incomplete' };
    }
  }

  // ponytail: ownership is process-local until a run manifest exists; later recovery can validate that manifest before cleanup.
  #assertOwnedEnvironment(environment: PreparedEnvironmentRef): void {
    const expectedRoot = this.#preparedRoots.get(environment.environmentId);
    if (environment.environmentId !== `environment-${environment.runId}` || expectedRoot !== resolve(environment.root)) {
      throw new Error('Environment workspace is not owned by this provider.');
    }
  }
  async fingerprint(environment: PreparedEnvironmentRef): Promise<EnvironmentFingerprint> {
    this.#assertOwnedEnvironment(environment);
    try {
      await stat(environment.root);
    } catch (error) {
      if (isMissing(error)) throw new Error(`Environment workspace is unavailable: ${environment.root}`, { cause: error });
      throw error;
    }
    return (await fingerprintTree(environment.root)).fingerprint;
  }

  async release(environment: PreparedEnvironmentRef): Promise<ReleaseResult> {
    const expectedRoot = join(this.#root, 'runs', environment.runId);
    if (environment.environmentId !== `environment-${environment.runId}` || resolve(environment.root) !== expectedRoot) {
      throw new Error('Environment workspace is not owned by this provider.');
    }
    if (!this.#preparedRoots.has(environment.environmentId)) {
      return { status: 'already_released', environmentId: environment.environmentId };
    }
    this.#assertOwnedEnvironment(environment);
    this.#preparedRoots.delete(environment.environmentId);
    return { status: 'released', environmentId: environment.environmentId };
  }
}
