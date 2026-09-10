import { SAFE_ID } from '../../core/identity.js';
import type { RecoveryDiagnostic, RecoveryReadiness, SessionSummary } from '../contract.js';
import { looksLikeInjectedInstruction } from './replay-user-input.js';
import { SessionDiscoveryError, type SessionFileEntry } from './session-files.js';

export type DiscoverySummaryState = {
  sessionId?: string | undefined;
  startedAt?: string | undefined;
  updatedAt?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  summary?: string | undefined;
  laterUserSummaries: string[];
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  completedTurns: number;
};

export function emptyDiscoverySummaryState(): DiscoverySummaryState {
  return { laterUserSummaries: [], userMessages: 0, assistantMessages: 0, toolCalls: 0, completedTurns: 0 };
}

export function compactSessionText(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 160);
}

export function recordLaterUserSummary(state: { summary?: string | undefined; laterUserSummaries: string[] }, text: string): void {
  if (looksLikeInjectedInstruction(text)) return;
  const compactText = compactSessionText(text);
  if (!state.summary) state.summary = compactText;
  else if (state.laterUserSummaries.length < 8) state.laterUserSummaries.push(compactText);
}

export function requireDiscoveredSessionId(sessionId: string | undefined, productLabel: string, kind: 'head' | 'full'): string {
  if (!sessionId || !SAFE_ID.test(sessionId)) {
    if (kind === 'head') throw new SessionDiscoveryError('too-large', `${productLabel} session head has no valid id.`);
    throw new Error(`${productLabel} session metadata has no valid id.`);
  }
  return sessionId;
}

export function sessionSummaryFromDiscovery(input: {
  productId: string;
  entry: SessionFileEntry;
  sourcePath: string;
  state: DiscoverySummaryState;
  recoveryReadiness: RecoveryReadiness;
  partial?: boolean;
  evidenceLevel?: SessionSummary['evidenceLevel'];
  recoveryDiagnostics?: readonly RecoveryDiagnostic[];
}): SessionSummary {
  const fallback = new Date(input.entry.mtime).toISOString();
  const { state } = input;
  return {
    productId: input.productId,
    sessionId: state.sessionId!,
    sourcePath: input.sourcePath,
    ...(input.partial ? { partial: true } : {}),
    ...(state.startedAt ? { startedAt: state.startedAt, startedAtSource: 'event' as const } : {}),
    updatedAt: state.updatedAt ?? fallback,
    updatedAtSource: state.updatedAt ? 'event' : 'file-mtime',
    ...(state.cwd ? { cwd: state.cwd } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.summary ? { summary: state.summary } : {}),
    ...(state.laterUserSummaries.length ? { laterUserSummaries: state.laterUserSummaries } : {}),
    signals: {
      userMessages: state.userMessages,
      assistantMessages: state.assistantMessages,
      toolCalls: state.toolCalls,
      completedTurns: state.completedTurns,
    },
    availability: 'indexed',
    sourceKind: state.cwd ? 'rollout-only' : 'projectless',
    recoveryReadiness: input.recoveryReadiness,
    ...(input.evidenceLevel ? { evidenceLevel: input.evidenceLevel } : {}),
    ...(input.recoveryDiagnostics?.length ? { recoveryDiagnostics: [...input.recoveryDiagnostics] } : {}),
  };
}
