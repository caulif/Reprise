import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { isRecord, record, text, type JsonRecord } from '../../core/json.js';
import { SAFE_ID } from '../../core/identity.js';
import type { RecoveryDiagnostic } from '../../core/schema.js';

export const SESSION_HEAD_BYTES = 256 * 1024;

export type JsonlWalkResult = {
  readonly records: number;
  readonly physicalLines: number;
  readonly truncated: boolean;
  readonly changed: boolean;
  readonly retried: boolean;
  readonly diagnostics: readonly RecoveryDiagnostic[];
};

/** Reads at most `maxBytes` from the start of a file. Never loads the remainder into memory. */
export function readFileHeadSync(path: string, maxBytes = SESSION_HEAD_BYTES): { text: string; bytesRead: number } {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } finally {
    closeSync(handle);
  }
}

export function peekJsonlSessionId(productId: string, path: string): string | undefined {
  try {
    const { text: head } = readFileHeadSync(path);
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (!isRecord(parsed)) continue;
      const id = productId === 'codex'
        ? text(parsed.type) === 'session_meta' ? text(record(parsed.payload).id) : undefined
        : text(parsed.sessionId);
      if (id && SAFE_ID.test(id)) return id;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function forEachJsonlRecord(
  path: string,
  product: string,
  onRow: (row: JsonRecord, index: number, physicalLine: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const result = await walkJsonlRecords(path, product, onRow, signal, false);
  if (result.diagnostics.length) throw new Error(result.diagnostics[0]!.message);
}

/** Stream a JSONL file, keeping the parsed prefix when the tail is damaged. */
export async function forEachJsonlRecordLenient(
  path: string,
  product: string,
  onRow: (row: JsonRecord, index: number, physicalLine: number) => void,
  signal?: AbortSignal,
): Promise<JsonlWalkResult> {
  return walkJsonlRecords(path, product, onRow, signal, true);
}

export async function withStableJsonlRead<T>(
  path: string,
  read: () => Promise<T>,
): Promise<{ value: T; changed: boolean; retried: boolean }> {
  const first = await stat(path);
  const value = await read();
  const second = await stat(path);
  if (sameStat(first, second)) return { value, changed: false, retried: false };
  const retried = await read();
  const third = await stat(path);
  if (sameStat(second, third)) return { value: retried, changed: false, retried: true };
  return { value: retried, changed: true, retried: true };
}

async function walkJsonlRecords(
  path: string,
  product: string,
  onRow: (row: JsonRecord, index: number, physicalLine: number) => void,
  signal: AbortSignal | undefined,
  lenient: boolean,
): Promise<JsonlWalkResult> {
  throwIfAborted(signal);
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let physicalLine = 0;
  let recordIndex = 0;
  let any = false;
  let truncated = false;
  const diagnostics: RecoveryDiagnostic[] = [];
  try {
    for await (const line of lines) {
      physicalLine += 1;
      throwIfAborted(signal);
      if (!line.trim()) continue;
      any = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const rest = await remainingNonEmpty(lines, signal);
        const trailing = rest === 0;
        truncated = trailing;
        const message = `${product} session ${path} has invalid JSONL at line ${physicalLine}: ${errorMessage(error)}`;
        if (!lenient) {
          diagnostics.push({ code: 'invalid-jsonl', message, physicalLine });
          return finish(recordIndex, physicalLine, truncated, diagnostics);
        }
        diagnostics.push({ code: trailing ? 'truncated-tail' : 'invalid-jsonl', message, physicalLine });
        if (!trailing) {
          diagnostics.push({
            code: 'corrupt-prefix',
            message: `${product} session ${path} kept the parsed prefix before line ${physicalLine}.`,
            physicalLine,
          });
        }
        return finish(recordIndex, physicalLine, truncated, diagnostics);
      }
      if (!isRecord(parsed)) {
        const message = `${product} session ${path} has invalid JSONL at line ${physicalLine}: row is not an object`;
        if (!lenient) {
          diagnostics.push({ code: 'invalid-jsonl', message, physicalLine });
          return finish(recordIndex, physicalLine, false, diagnostics);
        }
        const rest = await remainingNonEmpty(lines, signal);
        truncated = rest === 0;
        diagnostics.push({ code: rest === 0 ? 'truncated-tail' : 'invalid-jsonl', message, physicalLine });
        return finish(recordIndex, physicalLine, truncated, diagnostics);
      }
      onRow(parsed, recordIndex, physicalLine);
      recordIndex += 1;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof Error && error.message.includes(`${product} session ${path} has invalid JSONL`)) throw error;
    throw new Error(`${product} session cannot be read: ${path}`, { cause: error });
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!any) {
    diagnostics.push({ code: 'empty', message: `${product} session ${path} is empty.` });
  }
  return finish(recordIndex, physicalLine, truncated, diagnostics);
}

async function remainingNonEmpty(lines: AsyncIterable<string>, signal: AbortSignal | undefined): Promise<number> {
  let count = 0;
  for await (const line of lines) {
    throwIfAborted(signal);
    if (line.trim()) count += 1;
  }
  return count;
}

function finish(records: number, physicalLines: number, truncated: boolean, diagnostics: readonly RecoveryDiagnostic[]): JsonlWalkResult {
  return { records, physicalLines, truncated, changed: false, retried: false, diagnostics };
}

function sameStat(left: { size: number; mtimeMs: number }, right: { size: number; mtimeMs: number }): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Session discovery was cancelled.', 'AbortError');
}
