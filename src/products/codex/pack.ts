import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAFE_ID, sha256, writeImmutable } from '../../core/identity.js';
import type { RuntimePort } from '../../core/runtime.js';
import type { CaseArtifactRef, TaskCase } from '../../core/schema.js';
import { CodexRuntimePort } from './runtime-port.js';

const FIXTURE_SCHEMA = 'reprise.codex.fixture/v1';

type FixturePath = string | URL;
type JsonRecord = Record<string, unknown>;

type CodexFixture = {
  schema: typeof FIXTURE_SCHEMA;
  threadId: string;
  sourceRuntime: { version?: string; model?: string };
  events: JsonRecord[];
  artifacts: CodexFixtureArtifact[];
};

type CodexFixtureArtifact = {
  artifactId: string;
  kind: string;
  mediaType: string;
  dataBase64: string;
  baseline?: boolean;
};

type CodexMessageEvent = {
  type: 'user_message' | 'assistant_message';
  id: string;
  text: string;
  executable?: boolean;
};

export type CodexRuntimeEvent = {
  type: string;
  data?: unknown;
};

export type CodexPack = {
  runtime: RuntimePort;
  manifest: {
    productId: 'codex';
    packVersion: '0.1.0';
    schemaVersion: 1;
    sessionSchemaVersions: readonly [typeof FIXTURE_SCHEMA];
  };
};

export const codexProductPack: CodexPack = {
  runtime: new CodexRuntimePort(),
  manifest: {
    productId: 'codex',
    packVersion: '0.1.0',
    schemaVersion: 1,
    sessionSchemaVersions: [FIXTURE_SCHEMA],
  },
};

function inputPath(path: FixturePath): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

function object(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Codex fixture: ${label} must be an object.`);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid Codex fixture: ${label} must be a string.`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!SAFE_ID.test(result)) throw new Error(`Invalid Codex fixture: ${label} is not a safe identifier.`);
  return result;
}

function parseBase64(value: string, label: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Invalid Codex fixture: ${label} must be valid base64.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) throw new Error(`Invalid Codex fixture: ${label} must not be empty.`);
  return bytes;
}

function validateEvent(value: unknown, index: number): JsonRecord {
  const event = object(value, `events[${index}]`);
  const type = text(event.type, `events[${index}].type`);
  if (type === 'user_message' || type === 'assistant_message') {
    id(event.id, `events[${index}].id`);
    text(event.text, `events[${index}].text`);
  }
  return event;
}

function validateFixture(value: unknown): CodexFixture {
  const source = object(value, 'root');
  if (source.schema !== FIXTURE_SCHEMA) throw new Error(`Unsupported Codex fixture schema: ${String(source.schema)}.`);
  const threadId = id(source.threadId, 'threadId');
  const runtime = object(source.sourceRuntime, 'sourceRuntime');
  const sourceRuntime = {
    ...(runtime.version === undefined ? {} : { version: text(runtime.version, 'sourceRuntime.version') }),
    ...(runtime.model === undefined ? {} : { model: text(runtime.model, 'sourceRuntime.model') }),
  };
  if (!Array.isArray(source.events) || source.events.length === 0) throw new Error('Invalid Codex fixture: events must be non-empty.');
  const events = source.events.map(validateEvent);
  if (!events.some((event) => event.type === 'user_message' && event.executable === true)) {
    throw new Error('Invalid Codex fixture: an executable user_message is required.');
  }
  if (!Array.isArray(source.artifacts)) throw new Error('Invalid Codex fixture: artifacts must be an array.');
  const artifactIds = new Set<string>();
  const artifacts = source.artifacts.map((value, index) => {
    const artifact = object(value, `artifacts[${index}]`);
    const artifactId = id(artifact.artifactId, `artifacts[${index}].artifactId`);
    if (artifactIds.has(artifactId)) throw new Error(`Invalid Codex fixture: duplicate artifact ${artifactId}.`);
    artifactIds.add(artifactId);
    return {
      artifactId,
      kind: text(artifact.kind, `artifacts[${index}].kind`),
      mediaType: text(artifact.mediaType, `artifacts[${index}].mediaType`),
      dataBase64: text(artifact.dataBase64, `artifacts[${index}].dataBase64`),
      ...(artifact.baseline === undefined ? {} : { baseline: artifact.baseline === true }),
    };
  });
  for (const artifact of artifacts) parseBase64(artifact.dataBase64, `artifacts.${artifact.artifactId}.dataBase64`);
  return { schema: FIXTURE_SCHEMA, threadId, sourceRuntime, events, artifacts };
}

function messages(events: JsonRecord[]): CodexMessageEvent[] {
  return events.flatMap((event) => {
    if (event.type !== 'user_message' && event.type !== 'assistant_message') return [];
    return [{
      type: event.type,
      id: id(event.id, `events.${event.type}.id`),
      text: text(event.text, `events.${event.type}.text`),
      ...(event.executable === undefined ? {} : { executable: event.executable === true }),
    }];
  });
}

export async function importCodexFixture(path: FixturePath, now = new Date().toISOString()): Promise<{ taskCase: TaskCase; rawSession: CodexFixture }> {
  const bytes = await readFile(inputPath(path));
  const rawSession = validateFixture(JSON.parse(bytes.toString('utf8')));
  const sourceHash = sha256(bytes);
  const caseId = `case-${sourceHash.slice(0, 16)}`;
  const transcript = messages(rawSession.events).map(({ type, id: messageId, text: messageText }) => ({
    id: messageId,
    role: type === 'user_message' ? 'user' as const : 'assistant' as const,
    text: messageText,
  }));
  const initial = messages(rawSession.events).find((event) => event.type === 'user_message' && event.executable === true);
  if (!initial) throw new Error('Invalid Codex fixture: executable initial input disappeared during import.');
  const finalMessage = [...transcript].reverse().find((message) => message.role === 'assistant')?.text;
  const artifactRefs: CaseArtifactRef[] = rawSession.artifacts.filter((artifact) => artifact.baseline === true).map((artifact) => ({
    artifactId: artifact.artifactId,
    caseId,
  }));
  const taskCase: TaskCase = {
    schemaVersion: 1,
    caseId,
    source: { productId: 'codex', sessionId: rawSession.threadId },
    initialInput: { id: initial.id, role: 'user', text: initial.text },
    transcript,
    historicalEvents: [],
    baseline: {
      status: finalMessage === undefined ? 'unavailable' : 'available',
      ...(finalMessage === undefined ? {} : { finalMessage }),
      artifactRefs,
      evidenceRefs: [],
    },
    sourceRuntimeEvidence: {
      productId: 'codex',
      ...(rawSession.sourceRuntime.version === undefined ? {} : { version: rawSession.sourceRuntime.version }),
      ...(rawSession.sourceRuntime.model === undefined ? {} : { model: rawSession.sourceRuntime.model }),
      artifactRefs: [],
    },
    provenance: { packVersion: codexProductPack.manifest.packVersion, importedAt: now, sourceHash },
    privacy: { allowModelText: false, allowBinary: false, redactions: [] },
    contentHash: sourceHash,
  };
  return { taskCase, rawSession };
}

export async function freezeCodexFixture(path: FixturePath, root: string, now = new Date().toISOString()): Promise<{ taskCase: TaskCase; rawSession: CodexFixture }> {
  const imported = await importCodexFixture(path, now);
  const caseDir = join(root, imported.taskCase.caseId);
  try {
    await mkdir(caseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Case already exists: ${caseDir}`);
    throw new Error(`Unable to create case directory ${caseDir}: ${String(error)}`);
  }
  await mkdir(join(caseDir, 'raw'));
  await mkdir(join(caseDir, 'baseline-artifacts'));
  await writeImmutable(join(caseDir, 'case.json'), `${JSON.stringify(imported.taskCase, null, 2)}
`);
  await writeImmutable(join(caseDir, 'raw', 'session.json'), `${JSON.stringify(imported.rawSession, null, 2)}
`);
  for (const artifact of imported.rawSession.artifacts.filter((item) => item.baseline === true)) {
    await writeImmutable(join(caseDir, 'baseline-artifacts', artifact.artifactId), parseBase64(artifact.dataBase64, `artifacts.${artifact.artifactId}.dataBase64`));
  }
  await writeImmutable(join(caseDir, 'case.complete'), '');
  return imported;
}

export function normalizeCodexRuntimeEvent(event: CodexRuntimeEvent): JsonRecord {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as JsonRecord : {};
  if (event.type === 'model.resolved') {
    return { type: 'runtime.model_resolved', provider: typeof data.provider === 'string' ? data.provider : 'unknown', model: typeof data.model === 'string' ? data.model : 'unknown' };
  }
  if (event.type === 'turn.completed') {
    return { type: 'runtime.turn_settled', ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}) };
  }
  return { type: 'runtime.unknown', originalType: event.type };
}
