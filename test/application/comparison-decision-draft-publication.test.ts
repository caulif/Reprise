import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { comparisonSubmission, publicationSteps, runAutonomousPublication } from '../support/autonomous-comparison.js';

for (const mode of ['unchanged', 'revision', 'image', 'provider-failure'] as const) {
  test(`default autonomous publication preserves uncertainty and actual preview delivery: ${mode}`, async t => {
    const steps = publicationSteps();
    if (mode === 'image') steps[2]!.arguments = { includeImages: true };
    if (mode === 'revision') steps.push(
      { name: 'write', arguments: { path: comparisonSubmission.path, content: '' } },
      { name: 'submit_report', arguments: { ...comparisonSubmission, reason: 'Neither final output is confirmed usable. Revised after actual preview.' } },
      { name: 'preview_report', arguments: {} });
    const f = await runAutonomousPublication(t, { steps, allowImages: mode === 'image', onGeneration: (context, index) => {
      if (index === 3 && mode === 'provider-failure') throw Object.assign(new Error('Provider failed after mechanical preview'), { status: 503 });
      if (index === 3 && mode === 'image') {
        const preview = context.messages.at(-1);
        assert.ok(preview?.role === 'toolResult' && preview.content.some(part => part.type === 'image'), 'Native preview pixels must enter a subsequent generation');
      }
    } });
    assert.equal(f.renders, mode === 'revision' ? 2 : 1);
    assert.equal(f.result.comparison.result.status, mode === 'provider-failure' ? 'failed' : 'completed', JSON.stringify(f.result.comparison));
    const previews = f.events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report' && !event.payload.nativeHook);
    assert.ok(previews.length >= 1);
    assert.ok(f.events.some(event => event.type === 'agent.model_request' && event.sequence > previews.at(-1)!.sequence && 'generationInput' in event.payload));
    assert.equal(f.events.filter(event => event.type === 'agent.session_started' && event.payload.role === 'comparison').length, 1);
    if (mode === 'provider-failure') {
      await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
      return;
    }
    const html = await readFile(f.result.reportPath, 'utf8');
    assert.equal(html.split('Neither final output is confirmed usable.').length - 1, 1);
    assert.match(html, /Final quality could reverse the choice/);
    if (mode === 'revision') assert.match(html, /Revised after actual preview/);
  });
}
