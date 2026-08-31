import { record, text } from '../../core/json.js';
import type { TurnFailure } from '../../core/runtime.js';
import { summarizeDiagnostic } from '../shared/process.js';

export type ReconnectAttempt = { current: number; total: number };

export function parseReconnectAttempt(message: string): ReconnectAttempt | undefined {
  const match = /Reconnecting\s+(\d+)\s*\/\s*(\d+)/i.exec(message);
  if (!match) return undefined;
  return { current: Number(match[1]), total: Number(match[2]) };
}

export function diagnosticMessage(params: unknown): string | undefined {
  const payload = record(params);
  return text(payload.message) ?? text(payload.line);
}

function classifyRuntimeFailureMessage(message: string | undefined): Pick<TurnFailure, 'kind' | 'retryable'> {
  const value = message ?? '';
  if (/HTTP\s*503|\b503\b|temporarily unavailable|overloaded|service unavailable/i.test(value)) {
    return { kind: 'upstream', retryable: true };
  }
  if (/HTTP\s*401|\b401\b|HTTP\s*403|\b403\b|unauthorized|authentication|invalid api key|invalid_api_key/i.test(value)) {
    return { kind: 'authentication', retryable: false };
  }
  if (/unrecognized turn|invalid json-rpc|protocol_error|protocol error/i.test(value)) {
    return { kind: 'protocol', retryable: false };
  }
  if (/app-server exited|process exited|failed to start:|EPIPE/i.test(value)) {
    return { kind: 'process', retryable: false };
  }
  return { kind: 'unknown', retryable: false };
}

export function classifyCodexTurnFailure(
  turn: Record<string, unknown>,
  extras: { reconnectCount?: number } = {},
): TurnFailure | undefined {
  const status = text(turn.status);
  if (status !== 'failed' && status !== 'aborted') return undefined;
  const error = record(turn.error);
  const message = text(error.message) ?? text(error.code);
  const classified = classifyRuntimeFailureMessage(message);
  const summary = message
    ? summarizeDiagnostic(message)
    : status === 'failed'
      ? 'Codex turn failed without a classified upstream error.'
      : `Codex turn settled as ${status}.`;
  return {
    kind: classified.kind,
    summary,
    retryable: classified.retryable,
    ...(extras.reconnectCount ? { reconnectCount: extras.reconnectCount } : {}),
  };
}

export function redactNotificationParams(method: string, params: unknown): unknown {
  if (method !== 'error' && method !== 'stderr') return params;
  const payload = record(params);
  const message = diagnosticMessage(payload);
  if (!message) return params;
  return { ...payload, ...(text(payload.message) ? { message: summarizeDiagnostic(message, 1_000) } : {}), ...(text(payload.line) ? { line: summarizeDiagnostic(message, 1_000) } : {}) };
}
