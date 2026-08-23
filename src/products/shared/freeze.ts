import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { sha256, writeImmutable } from '../../core/identity.js';
import type { TaskCase } from '../../core/schema.js';
import type { JsonRecord } from '../../core/json.js';
import type { ImportedSession, SessionMessage, SessionPrivacy } from '../contract.js';

export type FrozenFile = {
  readonly relativePath: string;
  readonly content: string | Buffer;
};

export type PublishFrozenCaseInput = {
  readonly taskCase: TaskCase;
  readonly casesRoot: string;
  readonly files: readonly FrozenFile[];
  readonly reuseExisting?: boolean;
  readonly write?: typeof writeImmutable;
  readonly errorLabel?: string;
};

export async function publishFrozenCase(input: PublishFrozenCaseInput): Promise<{ taskCase: TaskCase; reused: boolean }> {
  const casesRoot = resolve(input.casesRoot);
  const caseId = input.taskCase.caseId;
  const caseDir = join(casesRoot, caseId);
  const write = input.write ?? writeImmutable;
  await mkdir(casesRoot, { recursive: true });
  if (input.reuseExisting) {
    if (await isFrozenCase(caseDir)) return { taskCase: await readExistingCase(caseDir, input.taskCase.provenance.sourceHash), reused: true };
    await rm(caseDir, { recursive: true, force: true });
  } else {
    try {
      await stat(caseDir);
      throw new Error(`Case already exists: ${caseDir}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const staging = join(casesRoot, `.${caseId}.staging-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(join(staging, 'raw'), { recursive: true });
    await write(join(staging, 'case.json'), `${JSON.stringify(input.taskCase, null, 2)}\n`);
    for (const file of input.files) {
      const directory = join(staging, file.relativePath.split(/[/\\]/).slice(0, -1).join('/'));
      if (directory !== staging) await mkdir(directory, { recursive: true });
      await write(join(staging, file.relativePath), file.content);
    }
    await write(join(staging, 'case.complete'), '');
    await rename(staging, caseDir);
    return { taskCase: input.taskCase, reused: false };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (input.reuseExisting && await isFrozenCase(caseDir)) {
      return { taskCase: await readExistingCase(caseDir, input.taskCase.provenance.sourceHash), reused: true };
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

export function redactText(value: string, redactions: readonly string[]): string {
  return redactions.reduce((result, secret) => result.split(secret).join('[REDACTED]'), value);
}

function taskCaseFromPrepared(prepared: ImportedSession, privacy: SessionPrivacy, now: string, initialMessageId?: string): TaskCase {
  if (prepared.evidenceLevel !== 'history' && !prepared.signals.completedTurns) {
    throw new Error('Session has no completed turn and cannot become a historical TaskCase.');
  }
  const initial = selectInitialInput(prepared, initialMessageId);
  const sourceHash = sha256(Buffer.from(prepared.raw.text, 'utf8'));
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
    baseline: prepared.baseline,
    sourceRuntimeEvidence: prepared.sourceRuntimeEvidence,
    ...(prepared.taskContext ? { taskContext: freezeTaskContext(prepared.taskContext) } : {}),
    provenance: { packVersion: prepared.provenance.packVersion, importedAt: now, sourceHash },
    privacy: {
      allowModelText: privacy.allowModelText,
      allowBinary: privacy.allowBinary,
      redactions: privacy.redactions.map(() => '[REDACTED]'),
    },
    contentHash: sha256(Buffer.from(prepared.raw.text, 'utf8')),
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
    raw: { ...imported.raw, text: redactText(imported.raw.text, redactions) },
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
  options: { initialMessageId?: string; write?: typeof writeImmutable; reuseExisting?: boolean; errorLabel?: string } = {},
): Promise<{ taskCase: TaskCase; reused: boolean }> {
  assertSessionPrivacy(privacy);
  const prepared = redactImported(imported, privacy.redactions);
  const taskCase = taskCaseFromPrepared(prepared, privacy, now, options.initialMessageId);
  const files: FrozenFile[] = [
    { relativePath: prepared.raw.relativePath, content: prepared.raw.text },
    ...(prepared.extraFiles ?? []).map((file) => ({ relativePath: file.relativePath, content: file.bytes })),
  ];
  return publishFrozenCase({
    taskCase,
    casesRoot,
    files,
    reuseExisting: options.reuseExisting ?? true,
    ...(options.write ? { write: options.write } : {}),
    ...(options.errorLabel ? { errorLabel: options.errorLabel } : {}),
  });
}

function selectInitialInput(imported: ImportedSession, initialMessageId?: string): SessionMessage {
  if (!initialMessageId) return imported.initialInput;
  const selected = imported.transcript.find((message) => message.id === initialMessageId && message.role === 'user');
  if (!selected) throw new Error('Selected task input is not a user message in this session.');
  return selected;
}

async function isFrozenCase(caseDir: string): Promise<boolean> {
  try {
    await stat(join(caseDir, 'case.complete'));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readExistingCase(caseDir: string, sourceHash: string): Promise<TaskCase> {
  try {
    const existing = JSON.parse(await readFile(join(caseDir, 'case.json'), 'utf8')) as TaskCase;
    if (existing.provenance.sourceHash !== sourceHash) throw new Error('existing case content does not match the source session');
    await stat(join(caseDir, 'case.complete'));
    return existing;
  } catch (error) {
    throw new Error(`Existing case cannot be safely reused: ${errorMessage(error)}`, { cause: error });
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
