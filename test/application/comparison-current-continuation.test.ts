import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';
import { comparisonReadCoverage } from '../../src/agents/comparison-tool-feedback.js';

for (const truncated of [1, 2]) {
  test(`current factory continues ${truncated} actual native output-limit generations before genuine publication`, async t => {
    const steps = [...Array.from({ length: truncated }, () => ({ name: '', arguments: {}, outputLimit: true as const })), ...publicationSteps()];
    const f = await runAutonomousPublication(t, { steps });
    assert.equal(f.result.comparison.result.status, 'completed', JSON.stringify(f.result.comparison));
    assert.equal(f.contexts.length, steps.length + 1);
    assert.equal(f.renders, 1);
    assert.equal(f.events.filter(event => event.type === 'agent.session_started' && event.payload.role === 'comparison').length, 1);
    assert.equal(f.events.filter(event => event.type === 'agent.invocation_yielded' && event.payload.reason === 'output_limit').length, truncated);
    assert.match(await readFile(f.result.reportPath, 'utf8'), /Neither final output is confirmed usable/);
  });
}

test('current factory delivers actual read coverage to a subsequent generation without inventing missing counters', async t => {
  const steps = [{ name: 'read', arguments: { path: 'candidate/README.md', offset: 2, maxBytes: 4 } }, ...publicationSteps()];
  let observed = false;
  const f = await runAutonomousPublication(t, { steps, onGeneration: (context, index) => {
    if (index !== 1) return;
    const receipt = context.messages.at(-1);
    assert.ok(receipt?.role === 'toolResult');
    const coverage = receipt.content.find(part => part.type === 'text' && part.text.startsWith('Host read coverage: '));
    assert.ok(coverage?.type === 'text');
    assert.deepEqual(JSON.parse(coverage.text.slice('Host read coverage: '.length)), { available: true, truncated: true, offset: 2, nextCursor: 6 });
    assert.ok(receipt.content.some(part => part.type === 'text' && part.text.includes('Host total-time budget remaining:')));
    observed = true;
  } });
  assert.ok(observed);
  assert.equal(f.result.comparison.result.status, 'completed', JSON.stringify(f.result.comparison));
});

test('read coverage rejects private and malformed fields and never fills absent false or zero', () => {
  assert.deepEqual(comparisonReadCoverage({ available: false, truncated: false, offset: 0, byteLength: 0, returnedBytes: 0, totalBytes: 0, nextCursor: 0,
    absolutePath: 'C:/private', arbitrary: 'private body' }), { available: false, truncated: false, offset: 0, byteLength: 0, returnedBytes: 0, totalBytes: 0, nextCursor: 0 });
  for (const details of [undefined, null, [], 'private', { available: 0, truncated: 'false', offset: -1, byteLength: NaN, totalBytes: Infinity, nextCursor: 0.5 }]) {
    assert.deepEqual(comparisonReadCoverage(details), {});
  }
});
