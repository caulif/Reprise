import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../../core/identity.js';
import { isRecord } from '../../core/json.js';
import type { EventEnvelope, TaskCase } from '../../core/schema.js';
import { recoveryEvidenceCatalog } from '../../core/recovery-evidence.js';

type Row = { source: string; order: number; ref: string; path: string; value: unknown };
const cell = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '').replace(/[\t\r\n]/g, ' ');

export async function writeObservationEventNavigation(root: string, taskCase: TaskCase, runEvents: readonly EventEnvelope[]): Promise<number> {
  const historical = recoveryEvidenceCatalog(taskCase).filter(entry => entry.source === 'historical_events');
  const rows: Row[] = historical.map(entry => ({ source: 'historical', order: entry.index,
    ref: entry.ref, path: `observations/events/historical/${entry.ref.replace(/^event:/, '')}.json`, value: taskCase.historicalEvents[entry.index] }));
  rows.push(...runEvents.map(event => ({ source: 'candidate', order: event.sequence, ref: `event:${event.eventId}`,
    path: `observations/events/run/${event.eventId}.json`, value: event })));
  const header = 'side\torder\tref\ttimestamp\ttype\tcall_id\ttool\toriginal\tprevious\tnext\tpreview';
  const lines = rows.map((row, index) => {
    const value = isRecord(row.value) ? row.value : {};
    const payload = isRecord(value.payload) ? value.payload : value;
    const details = isRecord(payload.payload) ? payload.payload : payload;
    const before = rows[index - 1], after = rows[index + 1];
    return [row.source, row.order, row.ref, value.occurredAt ?? value.timestamp,
      details.type ?? payload.type ?? value.type, details.call_id ?? payload.call_id,
      details.name ?? payload.tool ?? payload.name, row.path,
      before?.source === row.source ? before.path : '', after?.source === row.source ? after.path : '',
      JSON.stringify(row.value).replace(/\s+/g, ' ').slice(0, 180),
    ].map(cell).join('\t');
  });
  const directory = join(root, 'event-timeline');
  await mkdir(directory, { recursive: true });
  await writeAtomic(join(directory, 'INDEX.tsv'), `${[header, ...lines].join('\n')}\n`);
  let pages = 0;
  for (let offset = 0; offset < lines.length; offset += 100) {
    pages++;
    await writeAtomic(join(directory, `${String(pages).padStart(4, '0')}.tsv`), `${[header, ...lines.slice(offset, offset + 100)].join('\n')}\n`);
  }
  await writeAtomic(join(directory, 'COVERAGE.txt'), [
    `caseId=${taskCase.caseId}`, `sourceHash=${taskCase.provenance.sourceHash}`,
    `historicalEvents=${historical.length}`, `candidateEvents=${runEvents.length}`, `pages=${pages}`,
    'scope=all frozen historicalEvents and supplied candidate runEvents for this task, in source order',
    'indexTruncated=false; previewTruncated=true (180 characters); original JSON retains the complete frozen payload',
    'previous/next are adjacent source records, not proof of call/result pairing. Match call_id and inspect originals.',
    'read/grep tool results have their own byte/match caps. A capped search or page without a match is NOT evidence of no execution.',
    'No match across the complete frozen scope only means no record was found here; it does not establish that no external action occurred.',
    '',
  ].join('\n'));
  return pages + 2;
}
