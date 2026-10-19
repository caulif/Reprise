import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { copyAtomic, sha256, sha256File, writeImmutable } from '../../core/identity.js';
import type { TaskCase } from '../../core/schema.js';
import { canonicalJson, validateTaskCase, assertFrozenFilePath } from '../../core/task-case-identity.js';
import { readTaskCase, verifyTaskCaseFiles } from './task-case-reader.js';
import { sealFrozenCase } from './frozen-case-files.js';
import { withFrozenCaseLease } from './frozen-case-lease.js';
import type { JsonRecord } from '../../core/json.js';
import type {
  HistoricalArtifactExtractInput,
  HistoricalArtifactExtractResult,
  ImportedSession,
  SessionMessage,
  SessionPrivacy,
} from '../contract.js';
import { firstReplayUserMessage } from './replay-user-input.js';
import { frozenFilesFromExtraction } from './historical-artifact-files.js';
import { publishFrozenDirectory, type FrozenDirectoryPublishDependencies } from './freeze-publish.js';
import { snapshotSessionSource } from './session-source.js';

/** Pack-bound extract callback; sync per ProductHistoryReader port. */
export type HistoricalArtifactExtractFn = (
  input: HistoricalArtifactExtractInput,
) => HistoricalArtifactExtractResult;

export type FrozenFile = {
  readonly relativePath: string;
  readonly content?: string | Buffer;
  readonly copyFrom?: string;
};

export type PublishFrozenCaseInput = {
  readonly taskCase: TaskCase;
  readonly casesRoot: string;
  readonly files: readonly FrozenFile[];
  readonly reuseExisting?: boolean;
  readonly write?: typeof writeImmutable;
  readonly errorLabel?: string;
  readonly publishDependencies?: FrozenDirectoryPublishDependencies;
};

export async function publishFrozenCase(input: PublishFrozenCaseInput): Promise<{ taskCase: TaskCase; reused: boolean }> {
  const casesRoot = resolve(input.casesRoot);
  validateTaskCase(input.taskCase);
  for (const file of input.files) assertFrozenFilePath(file.relativePath);
  if (input.taskCase.schemaVersion === 2 && (await sealFrozenCase(input.taskCase, input.files)).contentHash !== input.taskCase.contentHash) {
    throw new Error('Publication bytes do not match the frozen TaskCase identity.');
  }
  const caseId = input.taskCase.caseId;
  const caseDir = join(casesRoot, caseId);
  const write = input.write ?? writeImmutable;
  await mkdir(casesRoot, { recursive: true });
  const rootInfo = await lstat(casesRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Frozen casesRoot must be a real directory.');
  return withFrozenCaseLease(caseDir, () => publishOwnedCase(input, caseDir, write));
}

async function publishOwnedCase(input: PublishFrozenCaseInput, caseDir: string, write: typeof writeImmutable): Promise<{ taskCase: TaskCase; reused: boolean }> {
  const caseId = input.taskCase.caseId;
  const casesRoot = resolve(input.casesRoot);
  try {
    await lstat(caseDir);
    if (!input.reuseExisting) throw new Error(`Case already exists: ${caseDir}`);
    return { taskCase: await readExistingCase(caseDir, input.taskCase), reused: true };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const staging = join(casesRoot, `.${caseId}.staging-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(join(staging, 'raw'), { recursive: true });
    await write(join(staging, 'case.json'), `${JSON.stringify(input.taskCase, null, 2)}\n`);
    for (const file of input.files) {
      const directory = join(staging, file.relativePath.split(/[/\\]/).slice(0, -1).join('/'));
      if (directory !== staging) await mkdir(directory, { recursive: true });
      const destination = join(staging, file.relativePath);
      if (file.copyFrom) await copyAtomic(file.copyFrom, destination);
      else await write(destination, file.content ?? '');
    }
    await verifyTaskCaseFiles(input.taskCase, staging);
    await write(join(staging, 'case.complete'), '');
    await publishFrozenDirectory(staging, caseDir, input.publishDependencies);
    return { taskCase: input.taskCase, reused: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (input.reuseExisting && await isFrozenCase(caseDir)) {
      return { taskCase: await readExistingCase(caseDir, input.taskCase), reused: true };
    }
    const label = input.errorLabel ?? 'Case';
    throw new Error(`${label} freeze did not complete for ${caseId}: ${errorMessage(error)}`, { cause: error });
  }
}

function assertSessionPrivacy(privacy: SessionPrivacy): void {
  if (typeof privacy.allowModelText !== 'boolean' || typeof privacy.allowBinary !== 'boolean' || privacy.redactions.some((item) => !item.trim())) {
    throw new Error('Session privacy settings are invalid.');
  }
}

function redactText(value: string, redactions: readonly string[]): string {
  return redactions.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}

function taskCaseFromPrepared(
  prepared: ImportedSession,
  privacy: SessionPrivacy,
  now: string,
  sourceHash: string,
  initialMessageId: string | undefined,
  artifactRefs: TaskCase['baseline']['artifactRefs'],
): TaskCase {
  if (prepared.evidenceLevel !== 'history' && !prepared.signals.completedTurns) {
    throw new Error('Session has no completed turn and cannot become a historical TaskCase.');
  }
  const initial = selectInitialInput(prepared, initialMessageId);
  const caseId = `case-${sourceHash.slice(0, 16)}`;
  return {
    schemaVersion: 1,
    caseId,
    source: prepared.source.sourcePath
      ? { productId: prepared.source.productId, sessionId: prepared.source.sessionId, sourcePath: prepared.source.sourcePath }
      : { productId: prepared.source.productId, sessionId: prepared.source.sessionId },
    evidenceLevel: prepared.evidenceLevel ?? 'transcript',
    initialInput: initial,
    transcript: [...prepared.transcript],
    historicalEvents: [...prepared.historicalEvents],
    baseline: {
      ...prepared.baseline,
      artifactRefs: artifactRefs.map((ref) => ({ artifactId: ref.artifactId, caseId })),
    },
    sourceRuntimeEvidence: prepared.sourceRuntimeEvidence,
    ...(prepared.taskContext ? { taskContext: freezeTaskContext(prepared.taskContext) } : {}),
    provenance: { packVersion: prepared.provenance.packVersion, importedAt: now, sourceHash },
    privacy: {
      allowModelText: true,
      allowBinary: privacy.allowBinary,
      redactions: privacy.redactions.map(() => '[REDACTED]'),
    },
    contentHash: sourceHash,
  };
}

function freezeTaskContext(context: JsonRecord): JsonRecord {
  const behavior = context.historicalBehavior;
  if (!behavior || typeof behavior !== 'object' || Array.isArray(behavior)) return context;
  const paths = (behavior as JsonRecord).touchedPaths;
  if (!Array.isArray(paths)) return context;
  const relevantPaths = paths.filter((value): value is string => typeof value === 'string').slice(0, 256);
  return relevantPaths.length > 0
    ? { ...context, relevantPaths: [...new Set(relevantPaths)] }
    : context;
}

function redactImported(imported: ImportedSession, redactions: readonly string[]): ImportedSession {
  if (!redactions.length) return imported;
  return {
    ...imported,
    initialInput: redactMessage(imported.initialInput, redactions),
    transcript: imported.transcript.map((message) => redactMessage(message, redactions)),
    historicalEvents: imported.historicalEvents.map((event) => JSON.parse(redactText(JSON.stringify(event), redactions)) as typeof event),
    baseline: {
      ...imported.baseline,
      ...(imported.baseline.finalMessage ? { finalMessage: redactText(imported.baseline.finalMessage, redactions) } : {}),
    },
    raw: {
      ...imported.raw,
      text: imported.raw.text ? redactText(imported.raw.text, redactions) : imported.raw.text,
    },
  };
}

function redactMessage(message: SessionMessage, redactions: readonly string[]): SessionMessage {
  return { ...message, text: redactText(message.text, redactions) };
}

export async function freezeCase(
  imported: ImportedSession,
  casesRoot: string,
  privacy: SessionPrivacy,
  now: string,
  options: {
    initialMessageId?: string;
    write?: typeof writeImmutable;
    reuseExisting?: boolean;
    errorLabel?: string;
    extractHistoricalArtifacts?: HistoricalArtifactExtractFn;
  } = {},
): Promise<{ taskCase: TaskCase; reused: boolean }> {
  assertSessionPrivacy(privacy);
  const prepared = redactImported(imported, privacy.redactions);
  const raw = await materializeRawFile(prepared, privacy.redactions);
  try {
    const extractionFiles: FrozenFile[] = [];
    let artifactRefs = prepared.baseline.artifactRefs;
    if (options.extractHistoricalArtifacts) {
      const historicalCwd = historicalCwdFromTaskContext(prepared.taskContext);
      const extraction = options.extractHistoricalArtifacts({
        transcript: prepared.transcript,
        historicalEvents: prepared.historicalEvents,
        ...(historicalCwd ? { historicalCwd } : {}),
      });
      const sealed = frozenFilesFromExtraction(extraction);
      extractionFiles.push(...sealed.files);
      artifactRefs = sealed.finalArtifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        caseId: `case-${raw.hash.slice(0, 16)}`,
      }));
    }
    const preparedCase = taskCaseFromPrepared(
      prepared,
      privacy,
      now,
      raw.hash,
      options.initialMessageId,
      artifactRefs,
    );
    const files: FrozenFile[] = [
      raw.file,
      ...(prepared.extraFiles ?? []).map((file) => ({ relativePath: file.relativePath, content: file.bytes })),
      ...extractionFiles,
    ];
    const taskCase = await sealFrozenCase(preparedCase, files);
    const reuseExisting = options.reuseExisting ?? true;
    return await publishFrozenCase({
      taskCase,
      casesRoot,
      files,
      reuseExisting,
      ...(options.write ? { write: options.write } : {}),
      ...(options.errorLabel ? { errorLabel: options.errorLabel } : {}),
    });
  } finally {
    if (raw.cleanup) await rm(raw.cleanup, { force: true });
  }
}

async function materializeRawFile(
  imported: ImportedSession,
  redactions: readonly string[],
): Promise<{ hash: string; file: FrozenFile; cleanup?: string }> {
  if (imported.raw.sourcePath && (imported.raw.encoding || imported.raw.receipt)) {
    const snapshot = join(tmpdir(), `reprise-decoded-${process.pid}-${randomUUID()}.jsonl`);
    try {
      await snapshotSessionSource(imported.raw.sourcePath, snapshot, imported.raw.encoding, imported.raw.receipt);
      const result = await materializeRawFile({ ...imported, raw: { relativePath: imported.raw.relativePath, text: '', sourcePath: snapshot } }, redactions);
      await rm(snapshot, { force: true });
      return result;
    } catch (error) {
      try { await rm(snapshot, { force: true }); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Decoded source cleanup failed; the prior failure is retained.', { cause: cleanupError }); }
      throw error;
    }
  }
  const relativePath = imported.raw.relativePath;
  if (imported.raw.sourcePath && !redactions.length) {
    const path = join(tmpdir(), `reprise-raw-${process.pid}-${randomUUID()}.jsonl`);
    await copyAtomic(imported.raw.sourcePath, path);
    return { hash: await sha256File(path), file: { relativePath, copyFrom: path }, cleanup: path };
  }
  if (imported.raw.sourcePath && redactions.length) {
    const { hash, path } = await writeRedactedJsonlCopy(imported.raw.sourcePath, redactions);
    return { hash, file: { relativePath, copyFrom: path }, cleanup: path };
  }
  const text = imported.raw.text;
  return { hash: sha256(Buffer.from(text, 'utf8')), file: { relativePath, content: text } };
}

async function writeRedactedJsonlCopy(
  sourcePath: string,
  redactions: readonly string[],
): Promise<{ hash: string; path: string }> {
  const path = join(tmpdir(), `reprise-redacted-${process.pid}-${randomUUID()}.jsonl`);
  const hash = createHash('sha256');
  const output = createWriteStream(path, { flags: 'wx' });
  const stream = createReadStream(sourcePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const next = `${redactText(line, redactions)}\n`;
      hash.update(next);
      if (!output.write(next)) await new Promise<void>((resolveWrite) => output.once('drain', resolveWrite));
    }
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    lines.close();
    stream.destroy();
    await new Promise<void>((resolveClose, reject) => output.end((error: Error | null | undefined) => error ? reject(error) : resolveClose()));
  }
  return { hash: hash.digest('hex'), path };
}

function selectInitialInput(imported: ImportedSession, initialMessageId?: string): SessionMessage {
  if (!initialMessageId) return firstReplayUserMessage(imported.transcript) ?? imported.initialInput;
  const selected = imported.transcript.find((message) => message.id === initialMessageId && message.role === 'user');
  if (!selected) throw new Error('Selected task input is not a user message in this session.');
  return selected;
}

export async function isFrozenCase(caseDir: string): Promise<boolean> {
  try {
    await stat(join(caseDir, 'case.complete'));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** Published cases only; staging dirs and unfinished trees are omitted. */
export async function listPublishedFrozenCases(casesRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(casesRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const published: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const caseDir = join(casesRoot, name);
    try {
      if (!(await stat(caseDir)).isDirectory()) continue;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (await isFrozenCase(caseDir)) published.push(name);
  }
  return published;
}

async function readExistingCase(caseDir: string, expected: TaskCase): Promise<TaskCase> {
  try {
    const existing = await readTaskCase(join(caseDir, 'case.json'), { expectedCaseId: expected.caseId, requireComplete: true });
    const original = { ...existing, provenance: { ...existing.provenance, importedAt: expected.provenance.importedAt } };
    const same = existing.schemaVersion === 2
      ? existing.contentHash === expected.contentHash
      : canonicalJson(original) === canonicalJson(expected);
    if (!same) throw new Error('existing case conflicts with the selected task or frozen evidence; preserve it and create a new frozen version');
    return existing;
  } catch (error) {
    throw new Error(`Existing case cannot be safely reused: ${errorMessage(error)}`, { cause: error });
  }
}

function historicalCwdFromTaskContext(taskContext: JsonRecord | undefined): string | undefined {
  const value = taskContext?.historicalCwd;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
