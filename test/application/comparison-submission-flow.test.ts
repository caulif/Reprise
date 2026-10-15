import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { comparisonSubmission, publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';

for (const mode of ['empty-final', 'missing-preview', 'stale-preview', 'repreviewed', 'provider-before-submit', 'provider-after-preview'] as const) {
  test(`default autonomous application publication boundary: ${mode}`, async t => {
    const steps = publicationSteps();
    if (mode === 'missing-preview') steps.pop();
    if (mode === 'stale-preview' || mode === 'repreviewed') {
      steps.push({ name: 'write', arguments: { path: comparisonSubmission.path, content: '<p>Revised delivery comparison; quality remains unknown.</p>' } },
        { name: 'submit_report', arguments: comparisonSubmission });
      if (mode === 'repreviewed') steps.push({ name: 'preview_report', arguments: {} });
    }
    const f = await runAutonomousPublication(t, { steps, onGeneration: (_context, index) => {
      if ((mode === 'provider-before-submit' && index === 0) || (mode === 'provider-after-preview' && index === 3)) {
        throw Object.assign(new Error('Stream ended without finish_reason'), { status: 503 });
      }
    } });
    const published = mode === 'empty-final' || mode === 'repreviewed';
    assert.equal(f.result.comparison.result.status, published ? 'completed' : 'failed', JSON.stringify(f.result.comparison));
    if (published) {
      assert.ok((await readFile(f.result.reportPath, 'utf8')).length > 0);
      assert.equal(f.contexts.length, steps.length + 1, 'Empty final model text is not a publication envelope');
    } else {
      await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
      const failure = await readFile(join(f.result.experimentRoot, 'comparison-failure.html'), 'utf8');
      assert.ok(failure.length > 0);
      if (f.result.comparison.result.status === 'failed') assert.equal(f.result.comparison.result.failure.code,
        mode.startsWith('provider-') ? 'provider_failure' : 'preview_failed');
    }
    if (mode === 'provider-after-preview') assert.equal(f.renders, 1);
    if (mode === 'provider-before-submit') {
      assert.equal(f.renders, 0);
      assert.equal(f.events.filter(event => event.type === 'comparison.draft_accepted').length, 0);
      assert.match(await readFile(join(f.attemptRoot, 'report.html'), 'utf8'), /data-agent-zone="comparison"/);
    }
  });
}
