import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFrozenObservationTree } from '../../src/products/history/observations-materializer.js';
import type { EventEnvelope } from '../../src/core/schema.js';
import { taskCase } from '../support/comparison-fixtures.js';

test('event navigation retains full original payloads, task coverage and same-side neighbors', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-event-navigation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = taskCase();
  task.historicalEvents = [
    { timestamp: '2026-10-14T00:00:00Z', type: 'response_item', payload: { type: 'function_call', call_id: 'restore', name: 'exec_command', arguments: 'git show HEAD:src/tool.rs' } },
    { timestamp: '2026-10-14T00:01:00Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'restore', output: 'source\n' + 'x'.repeat(300) + '\nsolely to execute E2E' } },
  ];
  const events = Array.from({ length: 101 }, (_, index) => ({
    schemaVersion: 1, eventId: `evt-${index}`, experimentId: 'experiment-1', runId: 'run-1',
    sequence: index + 1, occurredAt: '2026-10-14T00:02:00Z', type: 'runtime.tool_result', operationId: `op-${index}`, checksum: 'a'.repeat(64),
    payload: { tool: 'exec_command', output: index === 100 ? '4 passed; 2 failed; restore modified source' : 'next' },
  })) as EventEnvelope[];
  await writeFrozenObservationTree({ root, taskCase: task, runEvents: events });
  const index = (await readFile(join(root, 'event-timeline', 'INDEX.tsv'), 'utf8')).trimEnd().split('\n');
  assert.equal(index.length, 104);
  const first = index[1]!.split('\t'), second = index[2]!.split('\t'), candidate = index[3]!.split('\t');
  assert.equal(first[0], 'historical'); assert.equal(first[5], 'restore'); assert.equal(first[6], 'exec_command');
  assert.equal(first[9], second[7]); assert.equal(second[8], first[7]);
  assert.equal(second[9], ''); assert.equal(candidate[8], '');
  const original = JSON.parse(await readFile(join(root, second[7]!.replace('observations/', '')), 'utf8')) as { truncated: boolean; observation: { payload: { output: string } } };
  assert.equal(original.truncated, false);
  assert.match(original.observation.payload.output, /solely to execute E2E/);
  const secondPage = await readFile(join(root, 'event-timeline', '0002.tsv'), 'utf8');
  assert.match(secondPage, /evt-100/);
  const coverage = await readFile(join(root, 'event-timeline', 'COVERAGE.txt'), 'utf8');
  assert.match(coverage, /historicalEvents=2/); assert.match(coverage, /candidateEvents=101/);
  assert.match(coverage, /indexTruncated=false; previewTruncated=true/);
  assert.match(coverage, /NOT evidence of no execution/);
});
