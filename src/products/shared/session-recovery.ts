import { createHash } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { SAFE_ID } from '../../core/identity.js';
import { SessionRecoveryAttemptSchema, type RecoveryDiagnostic } from '../../core/schema.js';
import type {
  DiscoveryDiagnosticCode,
  ImportedSession,
  SessionInspection,
  SessionRef,
  ProductHistoryReader,
  SessionSummary,
} from '../contract.js';
import { peekJsonlSessionId } from './jsonl-io.js';
import type { JsonRecord } from '../../core/json.js';
import type { SessionFileEntry } from './session-files.js';

export type FreezeBlockReason = 'source-missing' | 'unreadable' | 'history-only' | 'no-user-input' | 'corrupt';
export type SessionReplayErrorCode = FreezeBlockReason | 'inspect-failed' | 'pending';

/** Operator-facing freeze failure after inspect. List summaries never throw this. */
export class SessionReplayError extends Error {
  readonly code: SessionReplayErrorCode;
  constructor(code: SessionReplayErrorCode, message: string) {
    super(message);
    this.name = 'SessionReplayError';
    this.code = code;
  }
}

export type SessionRecoveryAttempt = {
  readonly attempted: true;
  readonly status: 'recovered' | 'partial' | 'not-replayable' | 'retryable';
  readonly sourcePath: string;
  readonly sessionId: string;
  readonly parsedMessageCount: number;
  readonly skippedEventCount: number;
  readonly diagnostics: readonly RecoveryDiagnostic[];
  readonly rawSnapshotPath?: string;
  readonly imported?: ImportedSession;
  readonly inspection?: SessionInspection;
};

const CATALOG_MARKER = '/.catalog/';
const HISTORY_LOCATOR = '#reprise-history=';
const HARD_DISCOVERY = new Set<DiscoveryDiagnosticCode>(['unreadable-file', 'unreadable-directory', 'unsupported-entry']);

export function isSyntheticCatalogSource(sourcePath: string): boolean {
  return sourcePath.replaceAll('\\', '/').includes(CATALOG_MARKER);
}

function isHistoryLocator(sourcePath: string): boolean {
  return sourcePath.includes(HISTORY_LOCATOR);
}

function inspectBlockedReason(
  session: Pick<SessionSummary, 'availability' | 'evidenceLevel' | 'sourcePath' | 'recoveryReadiness'>,
): FreezeBlockReason | undefined {
  if (session.evidenceLevel === 'history' || isHistoryLocator(session.sourcePath)) return undefined;
  if (session.availability === 'catalog-only' || isSyntheticCatalogSource(session.sourcePath)) return 'source-missing';
  if (session.availability === 'unreadable' && session.recoveryReadiness !== 'pending') return 'unreadable';
  return undefined;
}

/**
 * Source-level freeze gates that inspect cannot repair (catalog-only, history-only, hard unreadable).
 * List `pending` / truncated-summary `no-user-input` are not freeze eligibility.
 */
export function freezeBlockedReason(
  session: Pick<SessionSummary, 'availability' | 'evidenceLevel' | 'sourcePath' | 'recoveryReadiness'>,
): FreezeBlockReason | undefined {
  const inspect = inspectBlockedReason(session);
  if (inspect) return inspect;
  if (session.evidenceLevel === 'history' || isHistoryLocator(session.sourcePath)) return 'history-only';
  return undefined;
}

/** Freeze eligibility after a full inspect, never from a discovery window. */
export function replayBlockedAfterInspect(
  inspected: Pick<SessionInspection, 'availability' | 'evidenceLevel' | 'sourcePath' | 'recoveryReadiness'>,
): FreezeBlockReason | undefined {
  const source = freezeBlockedReason(inspected);
  if (source) return source;
  if (inspected.recoveryReadiness === 'no-user-input') return 'no-user-input';
  if (inspected.recoveryReadiness === 'corrupt') return 'corrupt';
  return undefined;
}

export function listSummaryIncomplete(
  session: Pick<SessionSummary, 'partial' | 'recoveryReadiness'>,
): boolean {
  return session.partial === true || session.recoveryReadiness === 'pending';
}

function freezeBlockedMessage(reason: FreezeBlockReason, diagnostics: readonly RecoveryDiagnostic[] = []): string {
  const detail = diagnostics.map((item) => item.message).join(' / ');
  if (reason === 'unreadable') {
    return detail ? `Cannot replay: source is unreadable. ${detail}` : 'Cannot replay: source is unreadable.';
  }
  if (reason === 'history-only') return 'Cannot replay: history-only session has no transcript.';
  if (reason === 'no-user-input') {
    return detail ? `Cannot replay: no eligible user input. ${detail}` : 'Cannot replay: no eligible user input.';
  }
  if (reason === 'corrupt') {
    return detail ? `Cannot replay: transcript is corrupt. ${detail}` : 'Cannot replay: transcript is corrupt.';
  }
  return 'Cannot replay: catalog metadata has no readable transcript.';
}

export function assertTranscriptSessionId(listedId: string, actualId: string): void {
  if (listedId !== actualId) throw new Error('Session id from transcript does not match the listed session.');
}

export function discoveryFailureSummary(
  productId: string,
  entry: SessionFileEntry,
  code: DiscoveryDiagnosticCode,
  extractId: (row: JsonRecord) => string | undefined,
): SessionSummary {
  const digest = createHash('sha256').update(entry.path).digest('hex').slice(0, 16);
  const peeked = peekJsonlSessionId(entry.path, extractId);
  const sessionId = peeked && SAFE_ID.test(peeked) ? peeked : `unreadable-${digest}`;
  const hard = HARD_DISCOVERY.has(code);
  const diagnostic: RecoveryDiagnostic = { code, message: hard ? 'Source file could not be read.' : `Discovery summary was incomplete (${code}).` };
  return {
    productId,
    sessionId,
    sourcePath: entry.path,
    availability: hard ? 'unreadable' : 'indexed',
    ...(hard ? {} : { recoveryReadiness: 'pending' as const }),
    recoveryDiagnostics: [diagnostic],
    evidenceLevel: 'transcript',
    sourceKind: 'rollout-only',
    updatedAt: new Date(entry.mtime).toISOString(),
    updatedAtSource: 'file-mtime',
    signals: { userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 },
  };
}

function replayErrorFromAttempt(attempt: SessionRecoveryAttempt): SessionReplayError {
  const diagnosticCode = attempt.diagnostics[0]?.code;
  const code: SessionReplayErrorCode =
    diagnosticCode === 'source-missing' || diagnosticCode === 'unreadable' || diagnosticCode === 'history-only'
      || diagnosticCode === 'no-user-input' || diagnosticCode === 'corrupt' || diagnosticCode === 'pending'
      || diagnosticCode === 'inspect-failed'
      ? diagnosticCode
      : attempt.status === 'retryable' ? 'pending' : 'inspect-failed';
  const reason: FreezeBlockReason | undefined =
    code === 'source-missing' || code === 'unreadable' || code === 'history-only' || code === 'no-user-input' || code === 'corrupt'
      ? code
      : undefined;
  const message = reason
    ? freezeBlockedMessage(reason, attempt.diagnostics)
    : attempt.diagnostics.map((item) => item.message).join(' / ') || 'Selected session is not eligible for replay.';
  return new SessionReplayError(code, message);
}

export function evidenceRank(session: Pick<SessionSummary, 'availability' | 'recoveryReadiness' | 'signals' | 'sourcePath'>): number {
  if (session.recoveryReadiness === 'verified') return 70;
  if (session.recoveryReadiness === 'best-effort') return 60;
  if (session.availability !== 'unreadable' && session.availability !== 'catalog-only' && !isSyntheticCatalogSource(session.sourcePath) && session.signals.userMessages > 0) return 55;
  if (session.recoveryReadiness === 'pending') return 40;
  if (session.availability === 'unindexed') return 30;
  if (session.recoveryReadiness === 'no-user-input') return 25;
  if (session.recoveryReadiness === 'corrupt') return 20;
  if (session.availability === 'catalog-only' || isSyntheticCatalogSource(session.sourcePath)) return 15;
  if (session.availability === 'unreadable') return 0;
  return 35;
}

export async function attemptSessionRecovery(
  adapter: Pick<ProductHistoryReader, 'inspect' | 'import'>,
  session: Pick<SessionSummary, 'productId' | 'sessionId' | 'sourcePath' | 'availability' | 'evidenceLevel' | 'recoveryReadiness'>,
  sourcePath: string,
): Promise<SessionRecoveryAttempt> {
  const listed = inspectBlockedReason({ ...session, sourcePath });
  if (listed) {
    return checkedAttempt({
      attempted: true,
      status: listed === 'source-missing' ? 'not-replayable' : 'retryable',
      sourcePath,
      sessionId: session.sessionId,
      parsedMessageCount: 0,
      skippedEventCount: 0,
      diagnostics: [{ code: listed, message: freezeBlockedMessage(listed) }],
    });
  }
  const ref: SessionRef = { productId: session.productId, sessionId: session.sessionId, sourcePath };
  try {
    const inspected = await adapter.inspect(ref);
    const freezeReason = replayBlockedAfterInspect(inspected);
    if (freezeReason === 'history-only') {
      return checkedAttempt({
        attempted: true,
        status: 'not-replayable',
        sourcePath,
        sessionId: inspected.sessionId,
        parsedMessageCount: inspected.transcript.length,
        skippedEventCount: 0,
        diagnostics: inspected.recoveryDiagnostics ?? [{ code: 'history-only', message: freezeBlockedMessage('history-only') }],
        inspection: inspected,
      });
    }
    if (inspected.recoveryReadiness === 'pending') {
      return checkedAttempt({
        attempted: true,
        status: 'retryable',
        sourcePath,
        sessionId: inspected.sessionId,
        parsedMessageCount: inspected.transcript.length,
        skippedEventCount: 0,
        diagnostics: inspected.recoveryDiagnostics ?? [{ code: 'pending', message: 'Source changed during read; retry the recovery attempt.' }],
        inspection: inspected,
      });
    }
    if (freezeReason === 'no-user-input' || freezeReason === 'corrupt') {
      return checkedAttempt({
        attempted: true,
        status: 'not-replayable',
        sourcePath,
        sessionId: inspected.sessionId,
        parsedMessageCount: inspected.transcript.length,
        skippedEventCount: 0,
        diagnostics: [
          { code: freezeReason, message: freezeBlockedMessage(freezeReason, inspected.recoveryDiagnostics ?? []) },
          ...(inspected.recoveryDiagnostics ?? []),
        ],
        inspection: inspected,
      });
    }
    const imported = await importAfterInspection(adapter, session.sessionId, ref, inspected);
    const partial = inspected.recoveryReadiness === 'best-effort';
    return checkedAttempt({
      attempted: true,
      status: partial ? 'partial' : 'recovered',
      sourcePath,
      sessionId: imported.source.sessionId,
      parsedMessageCount: imported.transcript.length,
      skippedEventCount: imported.diagnostics.filter((item) => item.code.includes('skip') || item.code === 'unknown-event').length,
      diagnostics: [...(inspected.recoveryDiagnostics ?? []), ...imported.diagnostics],
      ...(imported.raw.sourcePath ? { rawSnapshotPath: imported.raw.sourcePath } : {}),
      imported,
      inspection: inspected,
    });
  } catch (error) {
    if (error instanceof SessionReplayError) {
      return checkedAttempt({
        attempted: true,
        status: error.code === 'pending' ? 'retryable' : 'not-replayable',
        sourcePath,
        sessionId: session.sessionId,
        parsedMessageCount: 0,
        skippedEventCount: 0,
        diagnostics: [{ code: error.code, message: error.message }],
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return checkedAttempt({
      attempted: true,
      status: /chang|pending|retry/i.test(message) ? 'retryable' : 'not-replayable',
      sourcePath,
      sessionId: session.sessionId,
      parsedMessageCount: 0,
      skippedEventCount: 0,
      diagnostics: [{ code: 'inspect-failed', message }],
    });
  }
}

export async function importVerifiedSession(
  adapter: Pick<ProductHistoryReader, 'inspect' | 'import'>,
  session: Pick<SessionSummary, 'productId' | 'sessionId' | 'sourcePath' | 'availability' | 'evidenceLevel' | 'recoveryReadiness'>,
  sourcePath: string,
): Promise<ImportedSession> {
  const attempt = await attemptSessionRecovery(adapter, session, sourcePath);
  if (attempt.imported && (attempt.status === 'recovered' || attempt.status === 'partial')) return attempt.imported;
  throw replayErrorFromAttempt(attempt);
}

async function importAfterInspection(
  adapter: Pick<ProductHistoryReader, 'import'>,
  listedId: string,
  ref: SessionRef,
  inspected: SessionInspection,
): Promise<ImportedSession> {
  assertTranscriptSessionId(listedId, inspected.sessionId);
  const blocked = replayBlockedAfterInspect(inspected);
  if (blocked) throw new SessionReplayError(blocked, freezeBlockedMessage(blocked, inspected.recoveryDiagnostics ?? []));
  const imported = await adapter.import(ref);
  assertTranscriptSessionId(listedId, imported.source.sessionId);
  if (imported.evidenceLevel === 'history') throw new Error(freezeBlockedMessage('history-only'));
  return imported;
}

function checkedAttempt(attempt: SessionRecoveryAttempt): SessionRecoveryAttempt {
  const record = {
    attempted: true as const,
    status: attempt.status,
    sourcePath: attempt.sourcePath,
    sessionId: attempt.sessionId,
    parsedMessageCount: attempt.parsedMessageCount,
    skippedEventCount: attempt.skippedEventCount,
    diagnostics: [...attempt.diagnostics],
    ...(attempt.rawSnapshotPath ? { rawSnapshotPath: attempt.rawSnapshotPath } : {}),
  };
  if (!Value.Check(SessionRecoveryAttemptSchema, record)) throw new Error('Session recovery attempt is invalid.');
  return attempt;
}
