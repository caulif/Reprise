import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isRecord, text } from '../../../src/core/json.js';
import type {
  ImportedSession,
  SessionDiscoveryQuery,
  SessionInspection,
  SessionRef,
  SessionSourceAdapter,
  SessionSummary,
} from '../../../src/products/contract.js';

const PRODUCT_ID = 'fake';

export const fakeSessionAdapter: SessionSourceAdapter = {
  defaultRoot: join(process.cwd(), 'test', 'fixtures', 'fake-pack', 'sessions'),
  async discover(query?: SessionDiscoveryQuery) {
    const root = resolve(query?.root ?? this.defaultRoot);
    const limit = query?.limit ?? 50;
    let names: string[];
    try { names = await readdir(root); } catch { return []; }
    const summaries: SessionSummary[] = [];
    for (const name of names.sort().reverse()) {
      if (!name.endsWith('.jsonl') || summaries.length >= limit) continue;
      try { summaries.push(await inspectPath(join(root, name))); } catch { /* skip bad files */ }
    }
    return summaries;
  },
  inspect(ref: SessionRef) {
    if (!ref.sourcePath) throw new Error('Fake session inspect requires a sourcePath.');
    return inspectPath(ref.sourcePath);
  },
  async import(ref: SessionRef) {
    const inspection = await this.inspect(ref);
    const bytes = await readFile(inspection.sourcePath);
    const initial = inspection.transcript.find((message) => message.role === 'user');
    if (!initial) throw new Error('Fake session has no user message.');
    return {
      source: { productId: PRODUCT_ID, sessionId: inspection.sessionId, sourcePath: inspection.sourcePath },
      initialInput: initial,
      transcript: [...inspection.transcript],
      historicalEvents: parseRows(bytes.toString('utf8')),
      baseline: {
        status: inspection.finalMessage ? 'available' : 'unavailable',
        ...(inspection.finalMessage ? { finalMessage: inspection.finalMessage } : {}),
        artifactRefs: [],
        evidenceRefs: [],
      },
      sourceRuntimeEvidence: { productId: PRODUCT_ID, ...(inspection.model ? { model: inspection.model } : {}), artifactRefs: [] },
      provenance: { packVersion: 'fake-session-jsonl/v1' },
      raw: { relativePath: 'raw/session.jsonl', text: bytes.toString('utf8') },
      diagnostics: [],
      signals: inspection.signals,
    } satisfies ImportedSession;
  },
};

async function inspectPath(sourcePath: string): Promise<SessionInspection> {
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error(`Fake session is not a file: ${sourcePath}`);
  const rows = parseRows(await readFile(sourcePath, 'utf8'));
  const meta = rows.find((row) => row.type === 'meta');
  const sessionId = text(meta?.sessionId);
  const startedAt = text(meta?.startedAt);
  if (!sessionId || !startedAt) throw new Error('Fake session metadata is incomplete.');
  const transcript: SessionInspection['transcript'][number][] = [];
  for (const [index, row] of rows.entries()) {
    const value = text(row.text);
    if (row.type === 'user' && value) transcript.push({ id: `message-${index}`, role: 'user', text: value });
    if (row.type === 'assistant' && value) transcript.push({ id: `message-${index}`, role: 'assistant', text: value });
  }
  const finalMessage = [...transcript].reverse().find((message) => message.role === 'assistant')?.text;
  const cwd = text(meta?.cwd);
  const model = text(meta?.model);
  const summary = transcript[0]?.text.slice(0, 160);
  return {
    productId: PRODUCT_ID,
    sessionId,
    sourcePath: resolve(sourcePath),
    startedAt,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(summary ? { summary } : {}),
    signals: {
      userMessages: transcript.filter((message) => message.role === 'user').length,
      assistantMessages: transcript.filter((message) => message.role === 'assistant').length,
      toolCalls: 0,
      completedTurns: rows.filter((row) => row.type === 'assistant' && row.stop === 'end').length,
    },
    transcript,
    ...(finalMessage ? { finalMessage } : {}),
  };
}

function parseRows(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error('Fake session row is not an object.');
    return parsed;
  });
}
