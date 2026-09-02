import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme } from '../src/tui/theme.js';
import { confirmCanStart, renderConfirmation } from '../src/tui/pages/run.js';
import { renderCandidateModelPicker, renderCandidateProductPicker } from '../src/tui/pages/candidate.js';
import { candidateSpecFromOffer } from '../src/application/candidate-spec.js';
import { createCodexExperimentWorkflow, TUI_RUN_POLICY } from '../src/application/tui-workflow.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';

test('candidate spec id follows product and catalog value', () => {
  const spec = candidateSpecFromOffer('claude-code', { value: 'sonnet', displayName: 'sonnet', resolvedModel: 'claude-sonnet-4-6' });
  assert.equal(spec.productId, 'claude-code');
  assert.equal(spec.requestedModel, 'sonnet');
  assert.equal(spec.candidateId, 'claude-code-sonnet');
});

test('product picker lists registered packs without historical models', () => {
  const text = renderCandidateProductPicker(createTheme(120, false), 120, {
    taskTitle: 'Draw two slides',
    sourceProductLabel: 'Codex',
    selected: 1,
    products: [
      { productId: 'codex', displayName: 'Codex', sourceSession: true, availability: 'available' },
      { productId: 'claude-code', displayName: 'Claude Code', sourceSession: false, availability: 'available' },
    ],
  }).join('\n');
  assert.match(text, /choose candidate product|Run · choose candidate product/);
  assert.match(text, /Claude Code/);
  assert.match(text, /source session/);
  assert.doesNotMatch(text, /historical model|history used/i);
});

test('model picker shows the selected pack catalog', () => {
  const text = renderCandidateModelPicker(createTheme(120, false), 120, {
    sourceProductLabel: 'Codex',
    candidateProductLabel: 'Claude Code',
    status: 'ready',
    selected: 0,
    suggestedValue: 'sonnet',
    offers: [
      { value: 'sonnet', displayName: 'sonnet', resolvedModel: 'claude-sonnet-4-6' },
      { value: 'opus', displayName: 'opus', resolvedModel: 'claude-opus-4-6' },
    ],
  }).join('\n');
  assert.match(text, /sonnet/);
  assert.match(text, /opus/);
  assert.match(text, /suggested/);
});

test('empty catalog cannot be confirmed', () => {
  const text = renderCandidateModelPicker(createTheme(120, false), 120, {
    sourceProductLabel: 'Codex',
    candidateProductLabel: 'Claude Code',
    status: 'error',
    selected: 0,
    offers: [],
    error: 'No models were listed.',
  }).join('\n');
  assert.match(text, /No models were listed/);
});

test('recovered confirmation without a selected candidate cannot start', () => {
  const model = {
    candidate: undefined,
    step: 3 as const,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessAuthOk: true,
    productLabel: 'Codex',
    preflight: { sourceBaseline: 'available', resolved: { executable: 'codex', resolvedModel: 'pending' }, limitations: [], comparisonClass: 'recovered' },
    recovery: { status: 'recovered' as const, unresolved: [], changedPathCount: 1 },
  };
  assert.equal(confirmCanStart(model as never), false);
});

test('cross-product confirmation names source and candidate', () => {
  const text = renderConfirmation(createTheme(120, false), 120, {
    candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' },
    step: 3,
    sourceRoot: String.raw`C:\workspace`,
    effort: 'high',
    harnessAuthOk: true,
    productLabel: 'Claude Code',
    sourceProductLabel: 'Codex',
    preflight: { sourceBaseline: 'available', resolved: { executable: 'claude', resolvedModel: 'claude-sonnet-4-6' }, limitations: [], comparisonClass: 'recovered' },
    recovery: { status: 'recovered', unresolved: [], changedPathCount: 1 },
  } as never).join('\n');
  assert.match(text, /Codex/);
  assert.match(text, /sonnet/);
  assert.match(text, /different product|另一套 Runtime/);
});

test('workflow listCatalog is the selected pack catalog', async () => {
  const workflow = createCodexExperimentWorkflow({
    dataDir: 'unused',
    runtime: fakeProductPack.runtime,
    pack: fakeProductPack,
    now: () => '2026-08-14T00:00:00.000Z',
    defaults: { candidate: fakeProductPack.defaultCandidate(), policy: TUI_RUN_POLICY },
    agents: async () => {
      throw new Error('agents should not be created for this assertion');
    },
  });
  const catalog = await workflow.listCatalog('fake');
  assert.equal(catalog[0]?.value, 'fake-model');
  const verified = await workflow.verifyCandidate(fakeProductPack.defaultCandidate());
  assert.equal(verified.requestedModel, 'fake-model');
});
