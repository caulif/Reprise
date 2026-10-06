import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import { ComparisonDecisionDraftSubmissionSchema, ComparisonDraftSubmissionSchema, type ComparisonDecisionDraftSubmission } from '../../src/core/schema.js';
import { materializeComparisonDecisionDraft } from '../../src/application/comparison-decision-draft.js';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { comparisonVisibleMainText } from '../../src/application/comparison-report-text.js';

const base: ComparisonDecisionDraftSubmission = { kind: 'decision', status: 'insufficient_evidence', category: 'Results', headline: 'Unknown',
  decisionShape: 'single_difference', decisionSummary: 'Output quality remains unchecked.', decisionBoundary: 'Quality could change the choice.',
  conclusionScope: 'undetermined', findingDispositions: [] };
const facts = { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
  models: { candidate: 'candidate' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
  delivery: { changedPaths: [], targetArtifactStatus: 'unavailable', verificationStatus: 'unavailable' },
  replay: { conditions: [], baselineEvidence: 'unavailable', candidateEvidence: 'unavailable' } };
async function fixture(t: { after(fn: () => Promise<void>): void }, withFinding = false) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-decision-draft-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [], media: [] });
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: async () => {} });
  if (withFinding) assert.match(await discovery.update({ criteria: ['Quality'],
    finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Unchecked final' })),
    importantLimitations: ['Quality unknown'], decisionQuestions: [],
    findings: [{ id: 'quality', criterion: 'Quality', difference: 'Unchecked', userConsequence: 'Could change choice', limitations: [], counterEvidenceRefs: [],
      observations: (['baseline', 'candidate'] as const).map(side => ({ side, method: 'unavailable', timing: 'comparison_check',
        result: 'Unchecked', scope: 'Final', evidenceRefs: [], supportBoundary: { relationship: 'Quality', domain: 'Final',
          supportStage: 'unavailable', coveredInstances: [], uncheckedInstances: ['Quality'] } })) }] }), /status=accepted/);
  const draft = new ComparisonDraft({ attemptRoot: root, task: 'Compare outputs', facts, locale: 'en', catalog, deliveredImages: new Set(),
    ...(withFinding ? { discovery } : {}) });
  return { root, draft, tool: draft.tool(), signal: new AbortController().signal };
}

test('decision input is a strict object; canonical materialization derives only basis IDs and empty markup', () => {
  const input = { ...base, findingDispositions: [
    { findingId: 'a', disposition: 'basis' as const, explanation: 'Task use' },
    { findingId: 'b', disposition: 'boundary' as const, explanation: 'Unknown could reverse choice' },
    { findingId: 'c', disposition: 'not_decisive' as const, explanation: 'Outside requested relation' },
  ] };
  assert.equal(ComparisonDecisionDraftSubmissionSchema.type, 'object');
  assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, input), true);
  const canonical = materializeComparisonDecisionDraft(input);
  assert.equal(Value.Check(ComparisonDraftSubmissionSchema, canonical), true);
  assert.deepEqual(canonical.decisionBasis, ['a']);
  assert.equal(canonical.comparisonHtml, '<p></p>');
  assert.equal(canonical.detailsHtml, undefined);
  assert.equal('kind' in canonical, false);
  assert.deepEqual(canonical.findingDispositions, input.findingDispositions);
  assert.equal(canonical.decisionSummary, input.decisionSummary);
  assert.equal(canonical.decisionBoundary, input.decisionBoundary);
  for (const extra of [{ comparisonHtml: '<p>Duplicate</p>' }, { detailsHtml: '<p>Hidden</p>' }, { decisionBasis: ['other'] }, { ignored: 'extra' }]) {
    assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, { ...input, ...extra }), false);
  }
  for (const key of Object.keys(base)) {
    const missing = { ...base } as Record<string, unknown>; delete missing[key];
    assert.equal(Value.Check(ComparisonDecisionDraftSubmissionSchema, missing), false, key);
  }
});

test('live tool renders one escaped summary and boundary and retains exact legacy full compatibility', async t => {
  const f = await fixture(t);
  assert.equal(f.tool.parameters.type, 'object');
  assert.equal(Value.Check(f.tool.parameters, base), true);
  const submitted = { ...base, decisionSummary: 'Choice <script> & task use', decisionBoundary: 'Unknown <img> may change choice' };
  assert.match((await f.tool.execute(submitted, f.signal)).content, /status=accepted/);
  const html = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.equal(comparisonVisibleMainText(html).split(submitted.decisionSummary).length - 1, 1);
  assert.match(html, /Choice &lt;script&gt; &amp; task use/);
  assert.match(html, /Unknown &lt;img&gt; may change choice/);
  const inspection = JSON.parse((await f.draft.inspectTool().execute({}, f.signal)).content) as { comparisonHtml: string };
  assert.match(inspection.comparisonHtml, /Choice &lt;script&gt;/);
  for (const extra of [{ comparisonHtml: '<p>Injected</p>' }, { detailsHtml: '<p>Ignored</p>' }, { decisionBasis: [] }, { arbitrary: true }]) {
    const invalid = { ...base, ...extra };
    assert.equal(Value.Check(f.tool.parameters, invalid), false);
    assert.match((await f.tool.execute(invalid, f.signal)).content, /invalid_submission/);
    assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), html);
  }
  const full = { ...materializeComparisonDecisionDraft(base), comparisonHtml: '<p>Legacy necessary detail</p>', detailsHtml: '<p>Legacy method</p>' };
  assert.equal(Value.Check(f.tool.parameters, full), true);
  assert.match((await f.tool.execute(full, f.signal)).content, /status=accepted/);
  assert.match(await readFile(join(f.root, 'report.html'), 'utf8'), /Legacy necessary detail/);
});

test('lean submissions cannot omit current findings or erase important boundaries and preserve original length gates', async t => {
  const f = await fixture(t, true);
  assert.match((await f.tool.execute(base, f.signal)).content, /decision_findings_invalid/);
  const valid: ComparisonDecisionDraftSubmission = { ...base,
    findingDispositions: [{ findingId: 'quality', disposition: 'basis', explanation: 'Uncertainty affects use' }] };
  assert.match((await f.tool.execute({ ...valid, findingDispositions: [...valid.findingDispositions, ...valid.findingDispositions] }, f.signal)).content, /invalid_submission/);
  assert.match((await f.tool.execute({ ...valid, decisionBoundary: '' }, f.signal)).content, /decision_boundary_missing/);
  assert.match((await f.tool.execute({ ...valid, status: 'completed', conclusionScope: 'supported_in_scope' }, f.signal)).content, /decision_scope_incomplete/);
  assert.match((await f.tool.execute(valid, f.signal)).content, /status=accepted/);
  const before = await readFile(join(f.root, 'report.html'), 'utf8');
  assert.match(before, /delivered-output support unverified|delivered output has not been verified/);
  for (const [decisionShape, limit] of [['single_difference', 250], ['multiple_differences', 600]] as const) {
    assert.match((await f.tool.execute({ ...valid, decisionShape, decisionSummary: 'x'.repeat(limit) }, f.signal)).content, /draft_too_long/);
    assert.equal(await readFile(join(f.root, 'report.html'), 'utf8'), before);
  }
});
