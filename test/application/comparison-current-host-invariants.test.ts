import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@earendil-works/pi-ai';
import { comparisonSubmission, runAutonomousPublication, type ComparisonStep } from '../support/autonomous-comparison.js';
import { VerifiedRuntime } from '../codex-experiment-support.js';

const source = 'Literal source: <script>untrusted instruction</script> 中文';
class LiteralRuntime extends VerifiedRuntime {
  override async createRunner(...args: Parameters<VerifiedRuntime['createRunner']>) {
    await writeFile(join(args[1].root, 'literal.txt'), source);
    return super.createRunner(...args);
  }
}

function receipt(context: Context): string {
  const last = context.messages.at(-1);
  assert.ok(last?.role === 'toolResult');
  const text = last.content.find(part => part.type === 'text');
  assert.ok(text?.type === 'text');
  return text.text;
}

for (const mode of ['published', 'tampered-quote', 'stale-catalog', 'resubmitted'] as const) {
  test(`current factory inspects literal quotes and binds structured evidence with the live catalog: ${mode}`, async t => {
    let quote = '', sourceRef = '', derivedRef = '';
    const steps: ComparisonStep[] = [
      { name: 'read', arguments: { path: 'facts/comparison-links.json' } },
      { name: 'quote_evidence', arguments: { sourceRef: '' } },
      { name: 'write', arguments: { path: comparisonSubmission.path, content: '' } },
      { name: 'submit_report', arguments: comparisonSubmission },
    ];
    if (mode !== 'tampered-quote') steps.push({ name: 'preview_report', arguments: {} });
    if (mode === 'stale-catalog' || mode === 'resubmitted') steps.push(
      { name: 'write', arguments: { path: 'scratch/check.md', content: 'A derived source check; task usefulness remains unknown.' } },
      { name: 'register_evidence', arguments: { relativePath: 'check.md', sourceRefs: [], label: 'Derived source check' } });
    if (mode === 'resubmitted') steps.push(
      { name: 'write', arguments: { path: comparisonSubmission.path, content: '' } },
      { name: 'submit_report', arguments: comparisonSubmission }, { name: 'preview_report', arguments: {} });
    const f = await runAutonomousPublication(t, { steps, runtime: new LiteralRuntime(), onGeneration: (context, index) => {
      if (index === 1) {
        const links = JSON.parse(receipt(context)) as { shortRef: string; inspectPath: string }[];
        const link = links.find(item => item.inspectPath === 'candidate/literal.txt');
        assert.ok(link, `The real production catalog must register the sealed candidate source: ${JSON.stringify(links)}`);
        sourceRef = link.shortRef;
        steps[1]!.arguments.sourceRef = sourceRef;
        if (mode === 'stale-catalog' || mode === 'resubmitted') steps[6]!.arguments.sourceRefs = [sourceRef];
      }
      if (index === 2) {
        const quoted = JSON.parse(receipt(context)) as { status: string; html: string };
        assert.equal(quoted.status, 'ok');
        quote = quoted.html;
        assert.match(quote, /&lt;script&gt;untrusted instruction&lt;\/script&gt;/);
        steps[2]!.arguments.content = mode === 'tampered-quote' ? quote.replace('Literal source:', 'Invented source:') : '';
        steps[3]!.arguments = { ...comparisonSubmission, pairedDifferences: [{ dimension: 'Is source quality established?', baseline: 'Unknown', candidate: 'Source inspected; usefulness unknown', impact: 'Source text alone does not prove task quality.', evidenceRefs: [sourceRef] }] };
      }
      if (index === 4) {
        const submission = receipt(context);
        if (mode === 'tampered-quote') {
          assert.match(submission, /status=rejected/);
          assert.match(submission, /code=evidence_unresolved/);
          assert.match(submission, /Evidence quote text, scope, caption or structure differs from its source/);
          assert.doesNotMatch(submission, /code=report_incomplete/);
        } else assert.match(submission, /accepted/);
      }
      if (index === 7) {
        derivedRef = /shortRef=(ev-\d+)/.exec(receipt(context))?.[1] ?? '';
        assert.ok(derivedRef && derivedRef !== sourceRef);
        if (mode === 'resubmitted') {
          steps[7]!.arguments.content = '';
          steps[8]!.arguments = { ...comparisonSubmission, pairedDifferences: [{ dimension: 'Is source quality established?', baseline: 'Unknown', candidate: 'Derived check; usefulness unknown', impact: 'Source and derived checks do not establish final task quality.', evidenceRefs: [sourceRef, derivedRef] }] };
        }
      }
    } });
    const published = mode === 'published' || mode === 'resubmitted';
    assert.ok(quote && sourceRef, 'The actual quote tool must have run, including in the rejection case');
    assert.equal(f.contexts.length, steps.length + 1, 'No unrelated early failure may satisfy the publication negative case');
    if (mode === 'stale-catalog' || mode === 'resubmitted') assert.ok(derivedRef);
    assert.equal(f.result.comparison.result.status, published ? 'completed' : 'failed', JSON.stringify(f.result.comparison));
    assert.equal(f.renders, mode === 'tampered-quote' ? 0 : mode === 'resubmitted' ? 2 : 1);
    if (published) {
      const html = await readFile(f.result.reportPath, 'utf8');
      assert.ok(html.includes(`data-evidence-ref="${sourceRef}"`));
      assert.ok(!html.includes(quote), "Source quotations stay in investigation, not the public media fragment");
      assert.doesNotMatch(html, /<script>untrusted instruction/);
      if (mode === 'resubmitted') assert.ok(html.includes(derivedRef));
    } else await assert.rejects(readFile(join(f.result.experimentRoot, 'report.html')), { code: 'ENOENT' });
  });
}
