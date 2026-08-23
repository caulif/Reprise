import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { formatBytes } from '../core/format.js';
import { SAFE_ID, sha256, sha256File, writeAtomic } from '../core/identity.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { RecoveryCheckpointRecordSchema, RecoveryManifestSchema, type RecoveryCheckpointRecord, type RecoveryManifest, type RecoveryControlledWrite } from '../core/schema.js';
import { getRecoveryControlledWriteBinding, replayControlledRecoveryDeltaBytes } from '../infrastructure/recovery-write-journal.js';
import { gitFileHash, isRecoveryPath, verifyRecoveryEvidence, type RecoveryEvidenceVerification } from '../infrastructure/recovery-tools.js';

const MAX_INLINE_HASH_BYTES = 8 * 1024 * 1024;
// ponytail: fixed budgets make snapshot cost predictable without silently changing the copied tree.
export const SNAPSHOT_LIMITS = {
  files: 50_000,
  totalBytes: 1024 * 1024 * 1024,
  fileBytes: 512 * 1024 * 1024,
} as const;

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
type FingerprintEntry = { path: string; kind: 'file' | 'directory'; size: number; contentHash?: string };
type TreeCopier = (source: string, destination: string) => Promise<void>;

export type EnvironmentFingerprint = {
  capturedAt: string;
  resources: FingerprintEntry[];
  digest: string;
};

export type SensitiveFileCategory = 'env' | 'credential' | 'private_key';
export type SensitiveFileCounts = Readonly<Record<SensitiveFileCategory, number>>;

export type WorkspaceBudget = {
  fileCount: number;
  totalBytes: number;
  largestFileBytes: number;
  blockedReasons: readonly string[];
  /** Category counts only; paths and contents never leave the provider scan. */
  sensitiveFileCounts?: SensitiveFileCounts;
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
    status: 'recovered' | 'partial' | 'insufficient_evidence' | 'failed';
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
  status: 'recovered' | 'partial' | 'insufficient_evidence';
  reportPath: 'recovery.md';
  unresolved: string[];
  evidenceRefs: string[];
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

export type RecoveryCandidateStaging = {
  candidateId: string;
  hypothesisId: string;
  recoveryId: string;
  root: string;
  beforeFingerprint: EnvironmentFingerprint;
  createdAt: string;
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
  readonly #recoveryCandidates = new Map<string, RecoveryCandidateStaging>();
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
      warnings: [...budget.blockedReasons],
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
      budget: { ...checkpoint.budget, blockedReasons: [...checkpoint.budget.blockedReasons] },
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
    const recoveriesRoot = join(this.#root, 'recovery-staging');
    await mkdir(recoveriesRoot, { recursive: true });
    const recoveryId = `recovery-${source.caseId}-${randomUUID()}`;
    const root = join(recoveriesRoot, recoveryId);
    const temporaryRoot = join(this.#root, 'recovery-temp', recoveryId);
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
   * Forks a recovery point into a provider-owned candidate workspace. Candidates
   * never alias the mutable primary staging root, so competing hypotheses cannot
   * contaminate each other or the source tripwire.
   */
  async createRecoveryCandidate(
    staging: RecoveryStaging,
    input: { candidateId: string; hypothesisId: string },
  ): Promise<RecoveryCandidateStaging> {
    this.#assertRecoveryStaging(staging);
    assertId(input.candidateId, 'candidateId');
    assertId(input.hypothesisId, 'hypothesisId');
    const key = `${staging.recoveryId}:${input.candidateId}`;
    if (this.#recoveryCandidates.has(key)) throw new Error('Recovery candidate already exists.');
    const root = join(this.#root, 'recovery-candidates', staging.recoveryId, input.candidateId);
    await mkdir(dirname(root), { recursive: true });
    try {
      await mkdir(root);
      await this.#copyTree(staging.root, root);
      const candidate: RecoveryCandidateStaging = {
        candidateId: input.candidateId,
        hypothesisId: input.hypothesisId,
        recoveryId: staging.recoveryId,
        root,
        beforeFingerprint: (await fingerprintTree(root)).fingerprint,
        createdAt: new Date().toISOString(),
      };
      this.#recoveryCandidates.set(key, candidate);
      return candidate;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  /** Copies a chosen isolated candidate back into the primary staging root for Provider validation. */
  async selectRecoveryCandidate(
    staging: RecoveryStaging,
    candidate: RecoveryCandidateStaging,
  ): Promise<void> {
    this.#assertRecoveryStaging(staging);
    this.#assertRecoveryCandidate(candidate);
    if (candidate.recoveryId !== staging.recoveryId)
      throw new Error("Recovery candidate belongs to a different staging session.");
    await rm(staging.root, { recursive: true, force: true });
    try {
      await mkdir(staging.root, { recursive: true });
      await this.#copyTree(candidate.root, staging.root);
    } catch (error) {
      await rm(staging.root, { recursive: true, force: true });
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
  async fingerprintRecoveryStaging(staging: RecoveryStaging): Promise<EnvironmentFingerprint> {
    this.#assertRecoveryStaging(staging);
    return (await fingerprintTree(staging.root)).fingerprint;
  }

  async fingerprintRecoveryCandidate(candidate: RecoveryCandidateStaging): Promise<EnvironmentFingerprint> {
    this.#assertRecoveryCandidate(candidate);
    return (await fingerprintTree(candidate.root)).fingerprint;
  }

  async discardRecoveryCandidate(candidate: RecoveryCandidateStaging): Promise<void> {
    const key = `${candidate.recoveryId}:${candidate.candidateId}`;
    const owned = this.#recoveryCandidates.get(key);
    if (!owned || owned.root !== candidate.root) return;
    this.#recoveryCandidates.delete(key);
    await rm(candidate.root, { recursive: true, force: true });
  }

  /** Independently validates an agent result before the operator can publish it. */
  async validateRecovery(staging: RecoveryStaging, result: RecoveryEnvelope, evidence: readonly RecoveryEvidenceVerification[] = []): Promise<RecoveryPreview> {
    this.#assertRecoveryStaging(staging);
    let reportText: string | undefined;
    let sourceTripwireAfter: EnvironmentFingerprint;
    try {
      if (!isRecoveryEnvelope(result)) throw new Error('Recovery result is invalid.');
      await verifyRecoveryEvidence(staging.root, result.evidenceRefs, evidence);
      sourceTripwireAfter = (await fingerprintTree(staging.sourceRoot)).fingerprint;
      if (sourceTripwireAfter.digest !== staging.sourceTripwireBefore.digest) throw new RecoveryValidationError('source_tripwire_failed', 'Recovery changed the user source directory; staging will be discarded.');
      if (result.status !== 'insufficient_evidence') reportText = await readRecoveryReport(staging.root);
      else reportText = await readRecoveryReport(staging.root).catch(() => undefined);
      const manifest = result.status === 'insufficient_evidence' ? undefined : await readRecoveryManifest(staging.root, result);
      // recovery.md and the shell's HOME are audit/runtime artifacts, not candidate-visible workspace input.
      await unlink(join(staging.root, 'recovery.md')).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      await unlink(join(staging.root, 'recovery-manifest.json')).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      if (staging.temporaryRoot) await rm(staging.temporaryRoot, { recursive: true, force: true });
      const captured = await fingerprintTree(staging.root);
      if (captured.budget.blockedReasons.length) throw new Error(captured.budget.blockedReasons.join(' '));
      const changed = changedPaths(staging.sourceFingerprint, captured.fingerprint);
      if (result.status === 'insufficient_evidence' && changed.length) throw new Error('insufficient_evidence must leave the staging workspace unchanged.');
      if (manifest) await validateManifest(manifest, changed, result, evidence, staging.sourceFingerprint, captured.fingerprint, staging.root);
      const recovery: NonNullable<EnvironmentBaseline['recovery']> = {
        status: result.status,
        ...(reportText ? { reportRef: 'recovery-md' } : {}),
        unresolved: [...result.unresolved],
        sourceDigest: staging.sourceFingerprint.digest,
        recoveredDigest: captured.fingerprint.digest,
        sourceTripwire: { before: staging.sourceTripwireBefore.digest, after: sourceTripwireAfter.digest },
        ...(staging.playbook ? { playbook: staging.playbook } : {}),
      };
      const match = result.status === 'recovered' ? 'recovered' : result.status === 'partial' ? 'recovered_partial' : 'current_state_fallback';
      const baseline: EnvironmentBaseline = {
        baselineId: `baseline-${staging.caseId}`, caseId: staging.caseId, mode: 'canonical', match, resources: [],
        readiness: { runnable: 'isolated', strictness: 'strict', blockingResourceIds: [] }, fingerprint: captured.fingerprint, budget: captured.budget,
        capabilities: { canFork: true, fingerprints: ['file_tree'], externalSideEffects: 'none' },
        warnings: result.status === 'insufficient_evidence' ? ['Recovery had insufficient evidence; replay will use the current source state.'] : [],
        recovery, createdAt: new Date().toISOString(), root: staging.root,
      };
      return { recoveryId: staging.recoveryId, baseline, ...(reportText ? { reportText } : {}), changedPaths: changed, accepted: false };
    } catch (error) {
      await this.discardRecovery(staging);
      throw error;
    }
  }

  /** Publishes a previously validated preview; this is the operator confirmation boundary. */
  async acceptRecovery(preview: RecoveryPreview): Promise<EnvironmentBaseline> {
    const staging = this.#recoveryStaging.get(preview.recoveryId);
    if (!staging || preview.accepted || preview.baseline.root !== staging.root) throw new Error('Recovery preview is no longer available.');
    const baselineRoot = join(this.#root, 'baselines', staging.caseId);
    const markerPath = join(dirname(baselineRoot), `${staging.caseId}.marker.json`);
    if (await exists(baselineRoot) || await exists(markerPath)) throw new Error(`A baseline already exists for ${staging.caseId}.`);
    await mkdir(dirname(baselineRoot), { recursive: true });
    try {
      await publishDirectory(staging.root, baselineRoot);
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
    for (const candidate of [...this.#recoveryCandidates.values()]) {
      if (candidate.recoveryId === staging.recoveryId) await this.discardRecoveryCandidate(candidate);
    }
    await rm(staging.root, { recursive: true, force: true });
    if (staging.temporaryRoot) await rm(staging.temporaryRoot, { recursive: true, force: true });
  }

  #assertRecoveryStaging(staging: RecoveryStaging): void {
    const owned = this.#recoveryStaging.get(staging.recoveryId);
    if (!owned || owned.root !== staging.root || !isInside(this.#root, staging.root)) throw new Error('Recovery staging is not owned by this provider.');
  }
  #assertRecoveryCandidate(candidate: RecoveryCandidateStaging): void {
    const owned = this.#recoveryCandidates.get(`${candidate.recoveryId}:${candidate.candidateId}`);
    if (!owned || owned.root !== candidate.root || !isInside(this.#root, candidate.root)) throw new Error('Recovery candidate is not owned by this provider.');
  }

  /** Copies a previously inspected source into provider-owned baseline storage. */
  async resolveBaseline(source: EnvironmentSource, clues: EnvironmentClue[], policy: EnvironmentPolicy): Promise<EnvironmentBaseline> {
    const inspected = await this.inspectBaseline(source, clues, policy);
    if (inspected.mode === 'unsupported' || inspected.readiness.runnable === 'blocked') return inspected;
    const baselineRoot = join(this.#root, 'baselines', source.caseId);
    const baselinesRoot = dirname(baselineRoot);
    const markerPath = join(baselinesRoot, `${source.caseId}.marker.json`);
    await mkdir(baselinesRoot, { recursive: true });

    const recorded = await readBaselineMarker(markerPath);
    if (recorded !== undefined && recorded.sourceFingerprint !== inspected.fingerprint.digest) {
      // Silently reusing a stale copy would make the whole run compare against the wrong tree.
      throw new Error(`Environment source for case ${source.caseId} changed since its baseline was captured. Use a new caseId, or delete ${baselineRoot} to recapture it.`);
    }
    const baselineExists = await exists(baselineRoot);
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
        await rm(markerPath, { force: true });
        await writeFile(markerPath, JSON.stringify({ sourceFingerprint: inspected.fingerprint.digest, ...(recorded?.recovery ? { recovery: recorded.recovery } : {}) }), { flag: 'wx' });
      } catch (error) {
        await removeCaptureArtifacts(stagingRoot, baselineRoot, markerPath);
        throw error;
      }
    }

    try {
      const { fingerprint } = await fingerprintTree(baselineRoot);
      return { ...inspected, fingerprint, root: baselineRoot, ...(recorded?.recovery ? { recovery: recorded.recovery, match: recorded.recovery.status === 'recovered' ? 'recovered' : recorded.recovery.status === 'partial' ? 'recovered_partial' : 'current_state_fallback' } : {}) };
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
      beforeFingerprint = (await fingerprintTree(runRoot)).fingerprint;
    } catch (error) {
      await rm(runRoot, { recursive: true, force: true });
      throw error;
    }
    if (!baseline.recovery) await rm(baselineRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => undefined);
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
    if (!this.#preparedRoots.has(environment.environmentId)) {
      const expectedRoot = join(this.#root, 'runs', environment.runId);
      if (environment.environmentId !== `environment-${environment.runId}` || resolve(environment.root) !== expectedRoot) {
        throw new Error('Environment workspace is not owned by this provider.');
      }
      try {
        await stat(environment.root);
      } catch (error) {
        if (isMissing(error)) return { status: 'already_released', environmentId: environment.environmentId };
        throw error;
      }
      throw new Error('Environment workspace is not owned by this provider.');
    }
    this.#assertOwnedEnvironment(environment);
    try {
      await rm(environment.root, { recursive: true, force: false });
      this.#preparedRoots.delete(environment.environmentId);
      return { status: 'released', environmentId: environment.environmentId };
    } catch (error) {
      if (isMissing(error)) {
        this.#preparedRoots.delete(environment.environmentId);
        return { status: 'already_released', environmentId: environment.environmentId };
      }
      throw new Error(`Unable to release environment ${environment.environmentId}: ${String(error)}`, { cause: error });
    }
  }
}

function recoveryPath(root: string, relativePath: string): string {
  if (!isRecoveryPath(relativePath)) throw new Error(`Recovery delta path is outside the workspace: ${relativePath}.`);
  const target = resolve(root, relativePath);
  if (!isInside(root, target)) throw new Error(`Recovery delta path is outside the workspace: ${relativePath}.`);
  return target;
}

async function assertNoSymlinkAncestors(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.split(/[\\/]/).slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Recovery delta path traverses a symbolic link: ${relativePath}.`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function ensureRegularRecoveryTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Recovery delta target is not a regular file: ${path}.`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function removeRecoveryFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(`Recovery delta delete target is not a regular file: ${path}.`);
    await unlink(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}
function assertId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}


async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }

const PUBLISH_BACKOFF_MS = [0, 30, 80, 160, 320, 640] as const;

/**
 * Publishes a fully copied staging tree as the baseline directory.
 * Windows often returns EPERM on a directory rename while Defender/Search still
 * holds a handle on a file that was just written; retry, then copy as fallback.
 */
export async function publishDirectory(
  staging: string,
  destination: string,
  attemptRename: typeof rename = rename,
): Promise<void> {
  let last: unknown;
  for (const delay of PUBLISH_BACKOFF_MS) {
    if (delay) await sleep(delay);
    try {
      await attemptRename(staging, destination);
      return;
    } catch (error) {
      last = error;
      if (await exists(destination) || !isBusy(error)) throw error;
    }
  }
  if (await exists(destination)) throw last;
  try {
    await cp(staging, destination, { recursive: true, errorOnExist: true });
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw new Error('Could not publish the isolated baseline. Windows still had a lock on the copied files. Retry the run.', { cause: error });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EAGAIN';
}

async function removeCaptureArtifacts(stagingRoot: string | undefined, baselineRoot: string, markerPath: string): Promise<void> {
  for (const path of [stagingRoot, baselineRoot, markerPath]) {
    if (path === undefined) continue;
    try {
      await rm(path, { recursive: path !== markerPath, force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

/** Returns the source digest recorded when the baseline was captured, or undefined when none exists yet. */
type BaselineMarker = { sourceFingerprint: string; recovery?: NonNullable<EnvironmentBaseline['recovery']> };

async function readBaselineMarker(path: string): Promise<BaselineMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = undefined;
  }
  const marker = parsed !== null && typeof parsed === 'object' ? parsed as { sourceFingerprint?: unknown; recovery?: unknown } : undefined;
  if (typeof marker?.sourceFingerprint !== 'string' || !marker.sourceFingerprint) throw new Error(`Baseline marker ${path} is unreadable. Delete its directory to recapture the baseline.`);
  return marker.recovery && isRecoveryMarker(marker.recovery) ? { sourceFingerprint: marker.sourceFingerprint, recovery: marker.recovery } : { sourceFingerprint: marker.sourceFingerprint };
}

function isRecoveryEnvelope(value: RecoveryEnvelope): boolean {
  return (value.status === 'recovered' || value.status === 'partial' || value.status === 'insufficient_evidence')
    && !(value.status === 'recovered' && value.unresolved.length > 0)
    && !((value.status === 'recovered' || value.status === 'partial') && value.evidenceRefs.length === 0)
    && ((value.status === 'insufficient_evidence' && value.manifestPath === undefined) || ((value.status === 'recovered' || value.status === 'partial') && value.manifestPath === 'recovery-manifest.json'))
    && value.reportPath === 'recovery.md' && Array.isArray(value.unresolved) && value.unresolved.every((item) => typeof item === 'string')
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((item) => typeof item === 'string' && /^(event|artifact):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item));
}

async function readRecoveryManifest(root: string, result: RecoveryEnvelope): Promise<RecoveryManifest> {
  if (result.manifestPath !== 'recovery-manifest.json') throw new Error('Recovery manifest is required.');
  let value: unknown;
  try { value = JSON.parse(await readFile(join(root, result.manifestPath), 'utf8')) as unknown; }
  catch { throw new Error('Recovery manifest is unreadable.'); }
  if (!Value.Check(RecoveryManifestSchema, value)) throw new Error('Recovery manifest is invalid.');
  return value;
}
async function validateManifest(
  manifest: RecoveryManifest,
  changed: readonly string[],
  result: RecoveryEnvelope,
  evidence: readonly RecoveryEvidenceVerification[],
  before: EnvironmentFingerprint,
  after: EnvironmentFingerprint,
  root: string,
): Promise<void> {
  const paths = manifest.actions.map((action) => action.path).sort();
  if (manifest.actions.some((action) => !isRecoveryPath(action.path))) throw new Error('Recovery manifest contains an unsafe path.');
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...changed].sort())) throw new Error('Recovery manifest paths must exactly match changed paths.');
  const known = new Map(evidence.map((item) => [item.ref, item]));
  const previous = new Map(before.resources.map((entry) => [entry.path, entry]));
  const current = new Map(after.resources.map((entry) => [entry.path, entry]));
  for (const action of manifest.actions) {
    if (action.evidenceRefs.some((ref) => !result.evidenceRefs.includes(ref) || !known.has(ref))) throw new Error('Recovery manifest action uses evidence absent from the envelope.');
    const beforeEntry = previous.get(action.path);
    const afterEntry = current.get(action.path);
    validateActionOperation(action.operation, beforeEntry, afterEntry, action.path);
    validateActionHashes(action.beforeHash, action.afterHash, beforeEntry, afterEntry, action.path);
    if (result.status === 'recovered' && !(await actionHasStrongEvidence(action.path, afterEntry, action.evidenceRefs, known, root))) {
      throw new Error(`Recovered action lacks strong path evidence: ${action.path}.`);
    }
  }
}

function validateActionOperation(
  operation: RecoveryManifest['actions'][number]['operation'],
  before: FingerprintEntry | undefined,
  after: FingerprintEntry | undefined,
  path: string,
): void {
  const beforeExists = Boolean(before);
  const afterExists = Boolean(after);
  if ((operation === 'create' && (beforeExists || !afterExists)) || (operation === 'delete' && (!beforeExists || afterExists)) || ((operation === 'modify' || operation === 'restore') && (!beforeExists || !afterExists))) {
    throw new Error(`Recovery manifest operation does not match the observed change: ${path}.`);
  }
}

function validateActionHashes(
  beforeHash: string | undefined,
  afterHash: string | undefined,
  before: FingerprintEntry | undefined,
  after: FingerprintEntry | undefined,
  path: string,
): void {
  if (beforeHash && before?.contentHash !== beforeHash) throw new Error(`Recovery manifest beforeHash does not match: ${path}.`);
  if (afterHash && after?.contentHash !== afterHash) throw new Error(`Recovery manifest afterHash does not match: ${path}.`);
}

async function actionHasStrongEvidence(
  path: string,
  after: FingerprintEntry | undefined,
  refs: readonly string[],
  evidence: ReadonlyMap<string, RecoveryEvidenceVerification>,
  root: string,
): Promise<boolean> {
  for (const ref of refs) {
    const item = evidence.get(ref);
    if (!item) continue;
    if (item.kind === 'checkpoint' && item.path === path && item.entryKind === after?.kind && item.hash === after?.contentHash) return true;
    if (item.kind === 'preimage' && item.path === path && after?.contentHash === item.hash) return true;
    if (item.kind === 'git_commit' && after?.contentHash && await gitFileHash(root, item.commit, path) === after.contentHash) return true;
  }
  return false;
}

async function readRecoveryReport(root: string): Promise<string> {
  const report = await readFile(join(root, 'recovery.md'), 'utf8');
  if (!report.trim()) throw new Error('Recovery report is empty.');
  return report;
}

function changedPaths(before: EnvironmentFingerprint, after: EnvironmentFingerprint): string[] {
  const index = (fingerprint: EnvironmentFingerprint) => new Map(fingerprint.resources.map((entry) => [entry.path, JSON.stringify(entry)]));
  const initial = index(before);
  const current = index(after);
  return [...new Set([...initial.keys(), ...current.keys()])].filter((path) => !path.startsWith('.git/') && initial.get(path) !== current.get(path)).sort();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function unsupportedBaseline(caseId: string): EnvironmentBaseline {
  const fingerprint: EnvironmentFingerprint = { capturedAt: new Date().toISOString(), resources: [], digest: sha256('unsupported') };
  return {
    baselineId: `baseline-${caseId}`,
    caseId,
    mode: 'unsupported',
    match: 'observational',
    resources: [],
    readiness: { runnable: 'unsupported', strictness: 'strict', blockingResourceIds: ['workspace'] },
    fingerprint,
    budget: { fileCount: 0, totalBytes: 0, largestFileBytes: 0, blockedReasons: ['Source workspace is unavailable.'] },
    capabilities: { canFork: false, fingerprints: ['file_tree'], externalSideEffects: 'none' },
    warnings: ['Source workspace is unavailable.'],
    createdAt: new Date().toISOString(),
  };
}


function isRecoveryMarker(value: unknown): value is NonNullable<EnvironmentBaseline['recovery']> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<NonNullable<EnvironmentBaseline['recovery']>>;
  return (item.status === 'recovered' || item.status === 'partial' || item.status === 'insufficient_evidence' || item.status === 'failed')
    && Array.isArray(item.unresolved) && typeof item.sourceDigest === 'string' && typeof item.recoveredDigest === 'string';
}

async function copyTree(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Environment source contains an unsupported symlink: ${from}`);
    if (entry.isDirectory()) {
      await mkdir(to);
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from, { flag: 'r' }), { flag: 'wx' });
    } else {
      throw new Error(`Unsupported environment entry: ${from}`);
    }
  }
}


export function calculateWorkspaceBudget(resources: readonly Pick<FingerprintEntry, 'kind' | 'size'>[]): WorkspaceBudget {
  const totals = resources.filter((resource) => resource.kind === 'file').reduce<FingerprintTotals>((result, resource) => ({
    fileCount: result.fileCount + 1,
    totalBytes: result.totalBytes + resource.size,
    largestFileBytes: Math.max(result.largestFileBytes, resource.size),
  }), { fileCount: 0, totalBytes: 0, largestFileBytes: 0 });
  return workspaceBudgetFromTotals(totals);
}

function workspaceBudgetFromTotals({ fileCount, totalBytes, largestFileBytes }: FingerprintTotals): WorkspaceBudget {
  const blockedReasons = [
    ...(fileCount > SNAPSHOT_LIMITS.files ? [`Source has ${fileCount.toLocaleString()} files; the ${SNAPSHOT_LIMITS.files.toLocaleString()} file snapshot limit prevents an unexpectedly large copy.`] : []),
    ...(totalBytes > SNAPSHOT_LIMITS.totalBytes ? [`Source is ${formatBytes(totalBytes)}; the ${formatBytes(SNAPSHOT_LIMITS.totalBytes)} snapshot limit prevents an unexpectedly large copy.`] : []),
    ...(largestFileBytes > SNAPSHOT_LIMITS.fileBytes ? [`Largest source file is ${formatBytes(largestFileBytes)}; the ${formatBytes(SNAPSHOT_LIMITS.fileBytes)} per-file snapshot limit prevents an unexpectedly large copy.`] : []),
  ];
  return { fileCount, totalBytes, largestFileBytes, blockedReasons };
}

type FingerprintTotals = { fileCount: number; totalBytes: number; largestFileBytes: number };
type FingerprintScan = { resources: FingerprintEntry[]; totals: FingerprintTotals; sensitiveFileCounts: Record<SensitiveFileCategory, number>; budget: WorkspaceBudget };

async function fingerprintTree(root: string): Promise<{ fingerprint: EnvironmentFingerprint; budget: WorkspaceBudget }> {
  const scan = await scanFingerprintTree(root);
  const metadata = [...scan.resources].sort(compareFingerprintEntries);
  if (scan.budget.blockedReasons.length > 0) {
    return { fingerprint: { capturedAt: new Date().toISOString(), resources: metadata, digest: sha256(JSON.stringify(metadata)) }, budget: scan.budget };
  }
  const resources = await Promise.all(scan.resources.map(async (resource) => {
    if (resource.kind !== 'file') return resource;
    const path = join(root, ...resource.path.split('/'));
    const contentHash = resource.size > MAX_INLINE_HASH_BYTES ? await sha256File(path) : sha256(await readFile(path));
    return { ...resource, contentHash };
  }));
  resources.sort(compareFingerprintEntries);
  return { fingerprint: { capturedAt: new Date().toISOString(), resources, digest: sha256(JSON.stringify(resources)) }, budget: scan.budget };
}

async function scanFingerprintTree(root: string): Promise<FingerprintScan> {
  const resources: FingerprintEntry[] = [];
  const totals = { fileCount: 0, totalBytes: 0, largestFileBytes: 0 };
  const sensitiveFileCounts: Record<SensitiveFileCategory, number> = { env: 0, credential: 0, private_key: 0 };
  try {
    await collectFingerprintMetadata(root, '', resources, totals, sensitiveFileCounts);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
  }
  return {
    resources,
    totals,
    sensitiveFileCounts,
    budget: { ...workspaceBudgetFromTotals(totals), sensitiveFileCounts },
  };
}

async function collectFingerprintMetadata(
  root: string,
  prefix: string,
  resources: FingerprintEntry[],
  totals: { fileCount: number; totalBytes: number; largestFileBytes: number },
  sensitiveFileCounts: Record<SensitiveFileCategory, number>,
): Promise<void> {
  const entries = await readdir(join(root, ...prefix ? prefix.split('/') : []), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, ...relativePath.split('/'));
    if (entry.isSymbolicLink()) throw new Error(`Environment workspace contains an unsupported symlink: ${path}`);
    if (entry.isDirectory()) {
      resources.push({ path: relativePath, kind: 'directory', size: 0 });
      await collectFingerprintMetadata(root, relativePath, resources, totals, sensitiveFileCounts);
    } else if (entry.isFile()) {
      const size = (await stat(path)).size;
      totals.fileCount += 1;
      totals.totalBytes += size;
      totals.largestFileBytes = Math.max(totals.largestFileBytes, size);
      const sensitiveCategory = sensitiveFileCategory(entry.name);
      if (sensitiveCategory) sensitiveFileCounts[sensitiveCategory] += 1;
      resources.push({ path: relativePath, kind: 'file', size });
      if (totals.fileCount > SNAPSHOT_LIMITS.files || totals.totalBytes > SNAPSHOT_LIMITS.totalBytes || totals.largestFileBytes > SNAPSHOT_LIMITS.fileBytes) {
        throw new BudgetExceeded();
      }
    } else {
      throw new Error(`Unsupported environment entry: ${path}`);
    }
  }
}


function sensitiveFileCategory(name: string): SensitiveFileCategory | undefined {
  const normalized = name.toLowerCase();
  if (normalized === '.env' || normalized.startsWith('.env.')) return 'env';
  if (normalized === 'auth.json' || normalized === '.credentials.json' || normalized === 'credentials.json' || normalized.includes('credential')) return 'credential';
  if (normalized.endsWith('.pem') || normalized.endsWith('.key') || normalized.endsWith('.p12') || normalized.endsWith('.pfx')) return 'private_key';
  return undefined;
}

class BudgetExceeded extends Error {
  constructor() { super('Workspace snapshot budget exceeded.'); }
}

function compareFingerprintEntries(left: FingerprintEntry, right: FingerprintEntry): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
