import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { hostname } from 'node:os';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SAFE_ID, sha256 } from '../../core/identity.js';
import {
  ArtifactRefSchema,
  EventEnvelopeSchema,
  RunAttemptSchema,
  RunManifestSchema,
  type ArtifactRef,
  type EventEnvelope,
  type RunAttempt,
  type RunManifest,
} from '../../core/schema.js';

const SCHEMA_VERSION = 1;

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
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, path);
}

export class ExperimentStore {
  readonly #root: string;
  readonly #experimentId: string;
  readonly #eventsPath: string;
  readonly #lockPath: string;
  #lockHeld = false;
  #events: EventEnvelope[] = [];
  #appendTail: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<ExperimentEventListener>();

  private constructor(root: string, experimentId: string, events: EventEnvelope[]) {
    this.#root = root;
    this.#experimentId = experimentId;
    this.#eventsPath = join(root, 'events.jsonl');
    this.#lockPath = join(root, 'writer.lock');
    this.#events = events;
  }

  static async open(experimentRoot: string, experimentId: string): Promise<ExperimentStore> {
    assertId(experimentId, 'experimentId');
    const root = resolve(experimentRoot);
    await mkdir(root, { recursive: true });
    const events = await readEvents(join(root, 'events.jsonl'));
    return new ExperimentStore(root, experimentId, events);
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
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error(`Experiment ${this.#experimentId} already has an active writer.`);
      }
      throw error;
    }
    if (reclaimed) await this.append({ type: 'writer.lock_reclaimed', operationId: `writer-lock-reclaimed-${lock.nonce}`, payload: { previousPid: reclaimed.pid, previousStartedAt: reclaimed.startedAt } });
  }

  async #reclaimStaleLock(): Promise<LockInfo | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#lockPath, 'utf8')) as unknown;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      return undefined;
    }
    if (!isLockInfo(value) || value.experimentId !== this.#experimentId || value.host !== hostname() || processExists(value.pid)) return undefined;
    await rm(this.#lockPath, { force: true });
    return value;
  }

  async close(): Promise<void> {
    if (!this.#lockHeld) return;
    await this.#appendTail;
    await rm(this.#lockPath, { force: true });
    this.#lockHeld = false;
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

  async listArtifacts(runId?: string): Promise<readonly ArtifactManifest[]> {
    const folder = runId ? join(this.#root, 'runs', runId, 'artifacts') : join(this.#root, 'artifacts');
    try {
      const { readdir } = await import('node:fs/promises');
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
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, input.bytes, { flag: 'wx' });
    await rename(temporary, filePath);
    const manifest: ArtifactManifest = {
      artifactId: input.artifactId, schemaVersion: SCHEMA_VERSION, kind: input.kind, ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      byteLength: input.bytes.byteLength, contentHash: sha256(input.bytes), createdAt: new Date().toISOString(),
      owner: { experimentId: this.#experimentId, ...(input.runId ? { runId: input.runId } : {}) },
      sourceEventId: randomUUID(), path: relative(this.#root, filePath),
    };
    await writeImmutableJson(manifestPath, manifest);
    try {
      await this.append({
        type: 'artifact.created', eventId: manifest.sourceEventId, ...(input.runId ? { runId: input.runId } : {}),
        operationId: input.operationId ?? `artifact-${input.artifactId}`, payload: { artifactId: input.artifactId },
      });
      return manifest;
    } catch (error) {
      // The immutable file is intentionally left as an uncommitted residual when the event cannot be appended.
      throw error;
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

export function assertRunAttempt(value: unknown): asserts value is RunAttempt {
  if (!Value.Check(RunAttemptSchema, value)) throw new Error('Invalid RunAttempt.');
}

export function assertRunManifest(value: unknown): asserts value is RunManifest {
  if (!Value.Check(RunManifestSchema, value)) throw new Error('Invalid RunManifest.');
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
  if (lines.at(-1) !== '') await truncate(eventsPath, content.lastIndexOf('\n') + 1);
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
