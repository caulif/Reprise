import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComparisonReportFacts } from '../../src/agents/comparison-contract.js';
import { renderComparisonReportShell, agentContentFromDraft, hostMetricsMismatch, missingComparisonSlots, extractInner } from '../../src/application/comparison-report-shell.js';
import { comparisonCompactTextBudgetError } from '../../src/application/comparison-report-text.js';

const facts: ComparisonReportFacts = {
  run: { runId: 'run', outcome: 'completed', terminationCode: 'done', initiatedBy: 'controller' },
  models: { baseline: 'historical-model', candidate: 'current-model', comparison: 'analysis-model' },
  activity: {}, limits: { triggered: [] }, runtime: { productId: 'fixture' },
  delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'unknown' },
  replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' },
};
const slots = { category: '文档修订任务', headline: '当前版保留批注，内容落实仍需复核。', boundary: '', comparison: '<p>当前版已开启修订记录，历史版缺少可核对的实物。</p>' };
const metrics = { baseline: { elapsedMs: 104785, tokens: { total: 70480 }, costUsd: 0.446 }, candidate: { elapsedMs: 5222174, tokens: { total: 17248371 }, costUsd: 1.12 } };
const render = (overrides = {}) => renderComparisonReportShell({ formatVersion: 4, task: 'Revise C:\\Users\\Alice\\private-application.docx for Alice at Private Lab', facts, metrics, slots: { ...slots, ...overrides } });

test('shareable report omits private task, brand, large model cards and duplicate summary through rebuild', () => {
  const html = render();
  assert.doesNotMatch(html, /Alice|Private Lab|private-application|REPRISE|class="models"|data-agent-slot="task"|data-agent-zone="differences"/);
  assert.equal(missingComparisonSlots(html), undefined);
  assert.equal(comparisonCompactTextBudgetError(html), undefined);
  assert.equal(hostMetricsMismatch(html, metrics), undefined);
  assert.equal(extractInner(html, 'data-agent-zone', 'comparison'), slots.comparison);
  assert.doesNotMatch(extractInner(html, 'data-agent-zone', 'comparison'), /<table/);
  assert.match(html, /font-size:19px/);
  const content = agentContentFromDraft(html);
  assert.ok('slots' in content);
  assert.equal(content.formatVersion, 4);
  const rebuilt = renderComparisonReportShell({ task: 'Another private task', facts, metrics, ...content });
  assert.equal(rebuilt, html);
});

test('shareable metrics use adaptive units and retain zero, missing, small costs and integrity checks', () => {
  const html = render();
  for (const text of ['1m45s', '1h27m', '70.48k', '17.25M', '$0.446', '$1.12']) assert.ok(html.includes(text), text);
  assert.equal(hostMetricsMismatch(html.replace('17.25M</td>', '17M</td>'), metrics), 'Host metrics numbers were modified.');
  const small = renderComparisonReportShell({ formatVersion: 4, task: 'Task', facts, locale: 'en', metrics: { baseline: { tokens: { total: 0 }, costUsd: 0 }, candidate: { tokens: { total: 1 }, costUsd: 0.00001 } }, slots });
  assert.match(small, />0<\/td>/);
  assert.match(small, />1<\/td>/);
  assert.match(small, /\$&lt;0\.001/);
  assert.match(small, /Timing is not comparable/);
});

test('shareable publication rejects obvious identifiers in every author slot, quotes and image labels', () => {
  for (const secret of ['C:\\Users\\Alice\\report', '/home/example/work', 'private.docx', 'person@example.org', '+86 138 1234 5678']) {
    for (const override of [{ headline: secret }, { category: secret }, { boundary: secret }, { comparison: `<p>${secret}</p>` }, { comparison: `<img alt="${secret}" data-media-ref="media-01">` }]) {
      assert.match(comparisonCompactTextBudgetError(render(override))!, /Shareable report/, secret);
    }
  }
  assert.match(comparisonCompactTextBudgetError(render({ comparison: `<figure data-component="evidence-quote"><pre>private.docx</pre></figure>` }))!, /possible path/);
  assert.match(comparisonCompactTextBudgetError(render({ comparison: '<p>C:<span>\\Users</span>\\Alice</p>' }))!, /possible path/);
  assert.match(comparisonCompactTextBudgetError(render({ comparison: '<p>private<span>.docx</span></p>' }))!, /possible path/);
  assert.match(comparisonCompactTextBudgetError(render({ headline: '字'.repeat(61) }))!, /60 characters/);
  assert.match(comparisonCompactTextBudgetError(render({ category: '字'.repeat(33) }))!, /32 characters/);
  assert.match(comparisonCompactTextBudgetError(render({ comparison: `<p>${'字'.repeat(501)}</p>` }))!, /500/);
});
