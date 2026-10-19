import { readFileSync } from 'node:fs';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const Timings = Type.Object({
  source: Type.String(), description: Type.String(), defaultMs: Type.Number({ exclusiveMinimum: 0 }),
  weights: Type.Record(Type.String({ pattern: '^dist/test/.+\\.test\\.js$' }), Type.Number({ exclusiveMinimum: 0 })),
}, { additionalProperties: false });
const timings = JSON.parse(readFileSync(new URL('./coverage-timings.json', import.meta.url), 'utf8'));
if (!Value.Check(Timings, timings)) throw new Error('Invalid coverage timing weights');

export function planShards(files, total, weights = timings.weights, defaultMs = timings.defaultMs) {
  if (!Number.isSafeInteger(total) || total < 1 || total > files.length || new Set(files).size !== files.length) {
    throw new Error('Invalid or empty coverage shard plan');
  }
  const cost = file => weights[file] ?? defaultMs;
  const weighted = [...files].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const buckets = Array.from({ length: total }, () => ({ files: [], estimatedMs: 0 }));
  for (const file of weighted) {
    const bucket = buckets.reduce((best, next) => next.estimatedMs < best.estimatedMs ? next : best);
    bucket.files.push(file);
    bucket.estimatedMs += cost(file);
  }
  return buckets.map(bucket => ({ ...bucket, files: bucket.files.sort() }));
}
