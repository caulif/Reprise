import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SAFE_ID, sha256, writeAtomic } from '../../core/identity.js';
import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  ControllerObservationReadPayloadSchema,
  ControllerRequestedPayloadSchema,
  RunAttemptSchema,
  RunManifestSchema,
  type ArtifactRef,
  type EventEnvelope,
  type RunAttempt,
  type RunManifest,
} from '../../core/schema.js';

const SCHEMA_VERSION = 1;
/** A lock owned by another host cannot be probed for liveness, so it is retired on age alone. */
const FOREIGN_LOCK_TTL_MS = 24 * 60 * 60 * 1000;

/** Recovery keeps structured evidence by default; full workspace trees are never artifacts. */
const RECOVERY_ARTIFACT_LIMITS: RecoveryArtifactPolicy = {
  softBytes: 64 * 1024 * 1024,
  hardBytes: 128 * 1024 * 1024,
  successTtlMs: 7 * 24 * 60 * 60 * 1000,
  failureTtlMs: 30 * 24 * 60 * 60 * 1000,
};

export type RecoveryArtifactPolicy = {
  readonly softBytes: number;
  readonly hardBytes: number;
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
};

export class RecoveryArtifactBudgetError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface ArtifactManifest {
  readonly artifactId: string;
  readonly schemaVersion: number;
  readonly kind: string;
  readonly mediaType?: string;
  readonly byteLength: number;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly owner: { readonly experimentId: string; readonly runId?: string };
  readonly sourceEventId: string;
  readonly path: string;
}

const ArtifactManifestSchema = Type.Object({
  artifactId: Type.String({ pattern: SAFE_ID.source }),
  schemaVersion: Type.Integer({ minimum: 1 }),
  kind: Type.String({ minLength: 1 }),
  mediaType: Type.Optional(Type.String({ minLength: 1 })),
  byteLength: Type.Integer({ minimum: 0 }),
  contentHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T' }),
  owner: Type.Object({ experimentId: Type.String({ pattern: SAFE_ID.source }), runId: Type.Optional(Type.String({ pattern: SAFE_ID.source })) }),
  sourceEventId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
});

export type ExperimentEventListener = (event: EventEnvelope) => void;

export interface AppendEvent {
  readonly type: string;
  readonly eventId?: string;
  readonly runId?: string;
  readonly operationId?: string;
  readonly payload: unknown;
  readonly occurredAt?: string;
}

export interface ReplayedRun {
  readonly runId: string;
  readonly attempt?: RunAttempt;
  readonly manifest?: RunManifest;
  readonly finishedPayload?: unknown;
  readonly eventIds: readonly string[];
}

interface LockInfo {
  readonly experimentId: string;
  readonly pid: number;
  readonly nonce: string;
  readonly startedAt: string;
  readonly host: string;
}

function eventChecksum(event: Omit<EventEnvelope, 'checksum'>): string {
  return sha256(JSON.stringify(event));
}

function isLockInfo(value: unknown): value is LockInfo {
  if (!value || typeof value !== 'object') return false;
  const lock = value as Partial<LockInfo>;
  return typeof lock.experimentId === 'string' && typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0 && typeof lock.nonce === 'string' && typeof lock.startedAt === 'string' && typeof lock.host === 'string';
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

function assertId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`${name} must be a safe identifier.`);
}

function inside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(resolvedRoot, candidate);
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);
  if (pathFromRoot === '..' || pathFromRoot.startsWith('..\\') || pathFromRoot.startsWith('../')) {
    throw new Error(`Path escapes experiment root: ${candidate}.`);
  }
  return resolvedCandidate;
}

/** Writes a JSON artifact once, leaving an existing acceptance/fact file untouched. */
export async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  try {
    await stat(path);
    throw new Error(`Immutable file already exists: ${path}.`);
  } catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  await writeAtomic(path, `${JSON.stringify(value)}\n`);
}

export class ExperimentStore {
  readonly #root: string;
  readonly #experimentId: string;
  readonly #eventsPath: string;
  readonly #lockPath: string;
  #lockHeld = false;
  #lockNonce: string | undefined;
  #events: EventEnvelope[] = [];
  #appendTail: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<ExperimentEventListener>();
  readonly #recoveryArtifactPolicy: RecoveryArtifactPolicy;

  private constructor(root: string, experimentId: string, events: EventEnvelope[], recoveryArtifactPolicy: RecoveryArtifactPolicy) {
    this.#root = root;
    this.#experimentId = experimentId;
    this.#eventsPath = join(root, 'events.jsonl');
    this.#lockPath = join(root, 'writer.lock');
    this.#events = events;
    this.#recoveryArtifactPolicy = recoveryArtifactPolicy;
  }

  static async open(experimentRoot: string, experimentId: string, options: { recoveryArtifactPolicy?: RecoveryArtifactPolicy } = {}): Promise<ExperimentStore> {
    assertId(experimentId, 'experimentId');
    const root = resolve(experimentRoot);
    await mkdir(root, { recursive: true });
    const events = await readEvents(join(root, 'events.jsonl'));
    const recoveryArtifactPolicy = options.recoveryArtifactPolicy ?? RECOVERY_ARTIFACT_LIMITS;
    if (!Number.isSafeInteger(recoveryArtifactPolicy.softBytes) || !Number.isSafeInteger(recoveryArtifactPolicy.hardBytes) || recoveryArtifactPolicy.softBytes < 0 || recoveryArtifactPolicy.hardBytes < recoveryArtifactPolicy.softBytes || (recoveryArtifactPolicy.successTtlMs !== undefined && recoveryArtifactPolicy.successTtlMs < 0) || (recoveryArtifactPolicy.failureTtlMs !== undefined && recoveryArtifactPolicy.failureTtlMs < 0)) {
      throw new Error('Invalid recovery artifact budget policy.');
    }
    return new ExperimentStore(root, experimentId, events, recoveryArtifactPolicy);
  }

  async acquireWriter(): Promise<void> {
    if (this.#lockHeld) return;
    const lock: LockInfo = {
      experimentId: this.#experimentId,
      pid: process.pid,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
      host: hostname(),
    };
    const reclaimed = await this.#reclaimStaleLock();
    try {
      await writeFile(this.#lockPath, `${JSON.stringify(lock)}\n`, { encoding: 'utf8', flag: 'wx' });
      this.#lockHeld = true;
      this.#lockNonce = lock.nonce;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`Experiment ${this.#experimentId} already has an active writer. If no process is running, delete ${this.#lockPath}.`, { cause: error });
      }
      throw error;
    }
    await repairIncompleteTail(this.#eventsPath);
    this.#events = await readEvents(this.#eventsPath);
    if (reclaimed) await this.append({ type: 'writer.lock_reclaimed', operationId: `writer-lock-reclaimed-${lock.nonce}`, payload: { previousPid: reclaimed.pid, previousStartedAt: reclaimed.startedAt } });
  }

  async #reclaimStaleLock(): Promise<LockInfo | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#lockPath, 'utf8');
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = undefined;
    }
    // A lock written during a crash can be truncated or empty. Keeping it would lock the experiment out forever.
    const reclaimable = !isLockInfo(value) || value.experimentId !== this.#experimentId || this.#isStale(value);
    if (!reclaimable) return undefined;
    if (!(await this.#claimLock())) return undefined;
    return isLockInfo(value) && value.experimentId === this.#experimentId ? value : undefined;
  }

  #isStale(lock: LockInfo): boolean {
    if (lock.host === hostname()) return !processExists(lock.pid);
    // Another host's liveness is unknowable here, so only age can retire the lock.
    const startedAt = Date.parse(lock.startedAt);
    return !Number.isFinite(startedAt) || Date.now() - startedAt >= FOREIGN_LOCK_TTL_MS;
  }

  async #claimLock(): Promise<boolean> {
    const tombstone = `${this.#lockPath}.${randomUUID()}.retired`;
    try {
      await rename(this.#lockPath, tombstone);
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
    await rm(tombstone, { force: true });
    return true;
  }

  async close(): Promise<void> {
    if (!this.#lockHeld) return;
    await this.#appendTail;
    let raw: string | undefined;
    try {
      raw = await readFile(this.#lockPath, 'utf8');
    } catch (error: unknown) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (raw !== undefined) {
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        value = undefined;
      }
      if (isLockInfo(value) && value.experimentId === this.#experimentId && value.nonce === this.#lockNonce) {
        await rm(this.#lockPath, { force: true });
      }
    }
    this.#lockHeld = false;
    this.#lockNonce = undefined;
  }

  subscribe(listener: ExperimentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get experimentId(): string { return this.#experimentId; }

  /** Immutable snapshots are returned for evidence readers; callers cannot append through this view. */
  events(runId?: string): readonly EventEnvelope[] {
    return this.#events.filter((event) => runId === undefined || event.runId === runId).map((event) => ({ ...event }));
  }

  /**
   * Snapshot of everything appended after `cursor`, plus the cursor to resume from. Readers that fold the
   * journal repeatedly (the Controller loop runs once per decision) would otherwise re-copy it every time.
   */
  eventsSince(cursor: number, runId?: string): { events: readonly EventEnvelope[]; cursor: number } {
    const from = Math.max(0, Math.min(cursor, this.#events.length));
    const events = this.#events.slice(from).filter((event) => runId === undefined || event.runId === runId).map((event) => ({ ...event }));
    return { events, cursor: this.#events.length };
  }

  async listArtifacts(runId?: string): Promise<readonly ArtifactManifest[]> {
    const folder = runId ? join(this.#root, 'runs', runId, 'artifacts') : join(this.#root, 'artifacts');
    try {
      const names = await readdir(folder);
      // Artifact payloads may themselves be JSON; only adjacent manifest files have a valid owner.
      const manifests = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(folder, name), 'utf8')) as unknown));
      return manifests.filter(isArtifactManifest).filter((manifest) => manifest.owner.experimentId === this.#experimentId && manifest.owner.runId === runId);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
  }


  nextSequence(): number {
    this.#assertWriter();
    return this.#events.length + 1;
  }

  async append(input: AppendEvent): Promise<EventEnvelope> {
    const pending = this.#appendTail.then(() => this.#appendOne(input));
    this.#appendTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async #appendOne(input: AppendEvent): Promise<EventEnvelope> {
    this.#assertWriter();
    if (!input.type.trim()) throw new Error('Event type must not be empty.');
    if (input.eventId) assertId(input.eventId, 'eventId');
    if (input.runId) assertId(input.runId, 'runId');
    if (input.operationId) assertId(input.operationId, 'operationId');

    const duplicate = input.operationId
      ? this.#events.find((event) => event.operationId === input.operationId)
      : undefined;
    if (input.eventId && this.#events.some((event) => event.eventId === input.eventId)) {
      throw new Error(`Event ${input.eventId} was already committed.`);
    }
    if (duplicate) {
      if (duplicate.type !== input.type || duplicate.runId !== input.runId || JSON.stringify(duplicate.payload) !== JSON.stringify(input.payload)) {
        throw new Error(`Operation ${input.operationId} was already committed with different data.`);
      }
      return duplicate;
    }

    const body = {
      schemaVersion: SCHEMA_VERSION,
      sequence: this.#events.length + 1,
      eventId: input.eventId ?? randomUUID(),
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      type: input.type,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      payload: input.payload,
    };
    const event: EventEnvelope = { ...body, checksum: eventChecksum(body) };
    if (!Value.Check(EventEnvelopeSchema, event)) throw new Error('Generated event does not satisfy the event schema.');
    if (event.type === 'controller.requested' && !Value.Check(ControllerRequestedPayloadSchema, event.payload)) throw new Error('controller.requested payload does not satisfy its schema.');
    if (event.type === 'controller.observation_read' && !Value.Check(ControllerObservationReadPayloadSchema, event.payload)) throw new Error('controller.observation_read payload does not satisfy its schema.');
    await writeFile(this.#eventsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    this.#events.push(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#listeners.delete(listener);
        process.emitWarning(`Experiment event observer failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return event;
  }

  async commitAttempt(attempt: RunAttempt, operationId = `attempt-${attempt.runId}`): Promise<EventEnvelope> {
    this.#assertWriter();
    assertRunAttempt(attempt);
    const path = inside(this.#root, join('runs', attempt.runId, 'attempt.json'));
    if (!this.#events.some((event) => event.type === 'run.attempt_created' && event.runId === attempt.runId)) {
      await writeImmutableJson(path, attempt);
    }
    return this.append({ type: 'run.attempt_created', runId: attempt.runId, operationId, payload: attempt });
  }

  async commitManifest(manifest: RunManifest, operationId = `manifest-${manifest.attempt.runId}`): Promise<EventEnvelope> {
    this.#assertWriter();
    assertRunManifest(manifest);
    const runId = manifest.attempt.runId;
    if (!this.#events.some((event) => event.type === 'run.attempt_created' && event.runId === runId)) {
      throw new Error(`RunAttempt must be committed before RunManifest for ${runId}.`);
    }
    const path = inside(this.#root, join('runs', runId, 'manifest.json'));
    if (!this.#events.some((event) => event.type === 'run.manifest_created' && event.runId === runId)) {
      await writeImmutableJson(path, manifest);
    }
    return this.append({ type: 'run.manifest_created', runId, operationId, payload: manifest });
  }

  async commitArtifact(input: {
    artifactId: string;
    runId?: string;
    kind: string;
    mediaType?: string;
    bytes: Uint8Array;
    operationId?: string;
  }): Promise<ArtifactManifest> {
    this.#assertWriter();
    assertId(input.artifactId, 'artifactId');
    if (input.runId) assertId(input.runId, 'runId');
    if (!input.kind.trim()) throw new Error('Artifact kind must not be empty.');
    const folder = input.runId ? join('runs', input.runId, 'artifacts') : 'artifacts';
    const filePath = inside(this.#root, join(folder, input.artifactId));
    const manifestPath = `${filePath}.json`;
    try {
      await stat(filePath);
      return JSON.parse(await readFile(manifestPath, 'utf8')) as ArtifactManifest;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (input.kind.startsWith('recovery_')) await this.#assertRecoveryArtifactBudget(input);
    await writeAtomic(filePath, input.bytes);
    const manifest: ArtifactManifest = {
      artifactId: input.artifactId, schemaVersion: SCHEMA_VERSION, kind: input.kind, ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      byteLength: input.bytes.byteLength, contentHash: sha256(input.bytes), createdAt: new Date().toISOString(),
      owner: { experimentId: this.#experimentId, ...(input.runId ? { runId: input.runId } : {}) },
      sourceEventId: randomUUID(), path: relative(this.#root, filePath),
    };
    await writeImmutableJson(manifestPath, manifest);
    // If the append fails, the immutable file is intentionally left as an uncommitted residual.
    await this.append({
      type: 'artifact.created', eventId: manifest.sourceEventId, ...(input.runId ? { runId: input.runId } : {}),
      operationId: input.operationId ?? `artifact-${input.artifactId}`, payload: { artifactId: input.artifactId },
    });
    return manifest;
  }


  async cleanupRecoveryArtifacts(input: { runId?: string; terminalStatus: 'completed' | 'failed'; now?: number }): Promise<{ removed: number; failed: number }> {
    this.#assertWriter();
    const ttlMs = input.terminalStatus === 'completed'
      ? this.#recoveryArtifactPolicy.successTtlMs
      : this.#recoveryArtifactPolicy.failureTtlMs;
    if (ttlMs === undefined) return { removed: 0, failed: 0 };
    const cutoff = (input.now ?? Date.now()) - ttlMs;
    const artifacts = (await this.listArtifacts(input.runId)).filter((artifact) => artifact.kind.startsWith('recovery_') && Date.parse(artifact.createdAt) < cutoff);
    let removed = 0;
    let failed = 0;
    for (const artifact of artifacts) {
      try {
        const folder = input.runId ? join('runs', input.runId, 'artifacts') : 'artifacts';
        await unlink(inside(this.#root, join(folder, artifact.artifactId)));
        await unlink(inside(this.#root, join(folder, `${artifact.artifactId}.json`)));
        removed += 1;
      } catch (error: unknown) {
        failed += 1;
        await this.append({
          type: 'recovery.artifact_cleanup_failed',
          ...(input.runId ? { runId: input.runId } : {}),
          operationId: `recovery-artifact-cleanup-failed-${artifact.artifactId}`,
          payload: { reasonCode: errorCode(error), terminalStatus: input.terminalStatus },
        });
      }
    }
    if (removed > 0) await this.append({
      type: 'recovery.artifact_cleanup_completed',
      ...(input.runId ? { runId: input.runId } : {}),
      operationId: `recovery-artifact-cleanup-${input.runId ?? 'experiment'}`,
      payload: { removed, failed, terminalStatus: input.terminalStatus },
    });
    return { removed, failed };
  }

  async #assertRecoveryArtifactBudget(input: { artifactId: string; runId?: string; kind: string; bytes: Uint8Array }): Promise<void> {
    const manifests = await this.listArtifacts(input.runId);
    const recoveryArtifacts = manifests.filter((manifest) => manifest.kind.startsWith('recovery_'));
    const contentHash = sha256(input.bytes);
    const retainedBytes = recoveryArtifacts.reduce((total, manifest) => total + manifest.byteLength, 0);
    const duplicateBytes = recoveryArtifacts.some((manifest) => manifest.contentHash === contentHash) ? input.bytes.byteLength : 0;
    const projectedBytes = retainedBytes + input.bytes.byteLength;
    const payload = {
      retainedBytes,
      incomingBytes: input.bytes.byteLength,
      projectedBytes,
      dedupRatio: projectedBytes === 0 ? 0 : duplicateBytes / projectedBytes,
      scope: input.runId ? 'run' : 'experiment',
    };
    if (projectedBytes > this.#recoveryArtifactPolicy.hardBytes) {
      await this.append({
        type: 'recovery.artifact_budget_hard_rejected',
        ...(input.runId ? { runId: input.runId } : {}),
        operationId: `recovery-artifact-budget-hard-${input.artifactId}`,
        payload,
      });
      throw new RecoveryArtifactBudgetError('Recovery artifact hard budget exceeded; full environment exports require explicit debug opt-in.');
    }
    if (projectedBytes > this.#recoveryArtifactPolicy.softBytes) {
      await this.append({
        type: 'recovery.artifact_budget_soft_exceeded',
        ...(input.runId ? { runId: input.runId } : {}),
        operationId: `recovery-artifact-budget-soft-${input.artifactId}`,
        payload,
      });
    }
  }

  async readArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    if (!Value.Check(ArtifactRefSchema, ref) || !('experimentId' in ref) || ref.experimentId !== this.#experimentId) {
      throw new Error('Artifact reference does not belong to this experiment.');
    }
    const folder = ref.runId ? join('runs', ref.runId, 'artifacts') : 'artifacts';
    const filePath = inside(this.#root, join(folder, ref.artifactId));
    const manifest = JSON.parse(await readFile(`${filePath}.json`, 'utf8')) as ArtifactManifest;
    if (manifest.owner.experimentId !== this.#experimentId || manifest.owner.runId !== ref.runId || manifest.artifactId !== ref.artifactId) {
      throw new Error('Artifact manifest ownership does not match its reference.');
    }
    const bytes = await readFile(filePath);
    if (bytes.byteLength !== manifest.byteLength || sha256(bytes) !== manifest.contentHash) throw new Error(`Artifact integrity check failed: ${ref.artifactId}.`);
    return bytes;
  }

  replay(runId: string): ReplayedRun {
    assertId(runId, 'runId');
    let attempt: RunAttempt | undefined;
    let manifest: RunManifest | undefined;
    let finishedPayload: unknown;
    const eventIds: string[] = [];
    for (const event of this.#events) {
      if (event.runId !== runId) continue;
      eventIds.push(event.eventId);
      if (finishedPayload !== undefined) continue; // ponytail: retain late facts without letting them rewrite a terminal outcome.
      if (event.type === 'run.attempt_created' && Value.Check(RunAttemptSchema, event.payload)) attempt = event.payload;
      if (event.type === 'run.manifest_created' && Value.Check(RunManifestSchema, event.payload)) manifest = event.payload;
      if (event.type === 'run.finished') finishedPayload = event.payload;
    }
    return { runId, ...(attempt ? { attempt } : {}), ...(manifest ? { manifest } : {}), ...(finishedPayload === undefined ? {} : { finishedPayload }), eventIds };
  }

  #assertWriter(): void {
    if (!this.#lockHeld) throw new Error(`Experiment ${this.#experimentId} must acquire its writer lock first.`);
  }
}

function assertRunAttempt(value: unknown): asserts value is RunAttempt {
  if (!Value.Check(RunAttemptSchema, value)) throw new Error('Invalid RunAttempt.');
}

function assertRunManifest(value: unknown): asserts value is RunManifest {
  if (!Value.Check(RunManifestSchema, value)) throw new Error('Invalid RunManifest.');
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
}

function isArtifactManifest(value: unknown): value is ArtifactManifest {
  return Value.Check(ArtifactManifestSchema, value);
}

async function readEvents(eventsPath: string): Promise<EventEnvelope[]> {
  let content: string;
  try {
    content = await readFile(eventsPath, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = content.split('\n');
  const completeLines = lines.slice(0, -1);
  return completeLines.map((line, index) => {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error(`Corrupt event JSON at sequence ${index + 1}.`); }
    if (!Value.Check(EventEnvelopeSchema, event)) throw new Error(`Invalid event envelope at sequence ${index + 1}.`);
    const { checksum, ...body } = event;
    if (checksum !== eventChecksum(body)) throw new Error(`Event checksum mismatch at sequence ${index + 1}.`);
    if (event.sequence !== index + 1) throw new Error(`Event sequence is not contiguous at sequence ${index + 1}.`);
    return event;
  });
}

async function repairIncompleteTail(eventsPath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(eventsPath, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (!content.endsWith('\n')) await truncate(eventsPath, content.lastIndexOf('\n') + 1);
}
