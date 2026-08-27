import { createHash } from 'node:crypto';
import type {
  ImportedSession,
  SessionInspection,
  SessionRef,
  SessionSourceAdapter,
  SessionSummary,
} from '../contract.js';
import type { SessionFileEntry } from './session-files.js';

export type FreezeBlockReason = 'source-missing' | 'unreadable' | 'history-only';

const CATALOG_MARKER = '/.catalog/';
const HISTORY_LOCATOR = '#reprise-history=';

export function isSyntheticCatalogSource(sourcePath: string): boolean {
  return sourcePath.replaceAll('\\', '/').includes(CATALOG_MARKER);
}

function isHistoryLocator(sourcePath: string): boolean {
  return sourcePath.includes(HISTORY_LOCATOR);
}

/** Enter/freeze is allowed only for a verified local transcript, never catalog metadata or history-only prompts. */
export function freezeBlockedReason(
  session: Pick<SessionSummary, 'availability' | 'evidenceLevel' | 'sourcePath'>,
): FreezeBlockReason | undefined {
  if (session.availability === 'unreadable') return 'unreadable';
  if (session.evidenceLevel === 'history' || isHistoryLocator(session.sourcePath)) return 'history-only';
  if (session.availability === 'catalog-only') return 'source-missing';
  if (isSyntheticCatalogSource(session.sourcePath)) return 'source-missing';
  return undefined;
}

function freezeBlockedMessage(reason: FreezeBlockReason): string {
  if (reason === 'unreadable') return 'Selected session transcript is unreadable.';
  if (reason === 'history-only') return 'Selected session is history-only and has no recoverable transcript.';
  return 'Selected session has catalog metadata but no readable transcript.';
}

export function assertTranscriptSessionId(listedId: string, actualId: string): void {
  if (listedId !== actualId) throw new Error('Session id from transcript does not match the listed session.');
}

export function unreadableSessionSummary(productId: string, entry: SessionFileEntry): SessionSummary {
  const digest = createHash('sha256').update(entry.path).digest('hex').slice(0, 16);
  return {
    productId,
    sessionId: `unreadable-${digest}`,
    sourcePath: entry.path,
    availability: 'unreadable',
    evidenceLevel: 'transcript',
    sourceKind: 'rollout-only',
    updatedAt: new Date(entry.mtime).toISOString(),
    updatedAtSource: 'file-mtime',
    signals: { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
}

export async function importVerifiedSession(
  adapter: Pick<SessionSourceAdapter, 'inspect' | 'import'>,
  session: Pick<SessionSummary, 'productId' | 'sessionId' | 'sourcePath' | 'availability' | 'evidenceLevel'>,
  sourcePath: string,
): Promise<ImportedSession> {
  const listed = freezeBlockedReason({ ...session, sourcePath });
  if (listed) throw new Error(freezeBlockedMessage(listed));
  const ref: SessionRef = { productId: session.productId, sessionId: session.sessionId, sourcePath };
  const inspected = await adapter.inspect(ref);
  return importAfterInspection(adapter, session.sessionId, ref, inspected);
}

async function importAfterInspection(
  adapter: Pick<SessionSourceAdapter, 'import'>,
  listedId: string,
  ref: SessionRef,
  inspected: SessionInspection,
): Promise<ImportedSession> {
  assertTranscriptSessionId(listedId, inspected.sessionId);
  const blocked = freezeBlockedReason(inspected);
  if (blocked) throw new Error(freezeBlockedMessage(blocked));
  const imported = await adapter.import(ref);
  assertTranscriptSessionId(listedId, imported.source.sessionId);
  if (imported.evidenceLevel === 'history') throw new Error(freezeBlockedMessage('history-only'));
  return imported;
}
