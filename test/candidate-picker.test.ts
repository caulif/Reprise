import test from 'node:test';
import assert from 'node:assert/strict';
import { createTheme } from '../src/tui/theme.js';
import { confirmCanStart, renderConfirmation } from '../src/tui/pages/run.js';
import { renderCandidateModelPicker, renderCandidateProductPicker } from '../src/tui/pages/candidate.js';
import { candidateSpecFromOffer } from '../src/application/candidate-spec.js';
import { createExperimentWorkflow, TUI_RUN_POLICY } from '../src/application/tui-workflow.js';
import { fakeProductPack } from './fixtures/fake-pack/pack.js';
import { projectWorkbenchView } from '../src/tui/view-projection.js';
import { renderWorkbench } from '../src/tui/workbench.js';

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
  assert.match(text, /claude-sonnet-4-6/);
  assert.match(text, /opus/);
  assert.match(text, /suggest/);
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
  assert.match(text, /claude-sonnet-4-6/);
  assert.match(text, /different runtime|另一套 Runtime/);
  assert.doesNotMatch(text, /Maximum requests|Changed paths|未决/);
});

test('running canvas uses the candidate product not the source session product', () => {
  const view = projectWorkbenchView({
    page: 'running',
    cwd: 'C:\\repo',
    productLabel: 'Codex',
    candidateProductLabel: 'Claude Code',
    sourceProductLabel: 'Codex',
    candidate: { candidateId: 'claude-code-sonnet', productId: 'claude-code', requestedModel: 'sonnet' },
    locale: 'zh',
    message: '',
    inlineHelp: false,
    cancelling: false,
    hasSavedModelConfig: true,
    harnessAuthOk: true,
    modelConfig: { providerId: 'pi', modelId: 'gpt-5.6-terra', effort: 'medium' },
    configDraft: { kind: 'openai-compatible', providerId: 'openai-compatible', modelId: 'gpt-5.6-terra', effort: 'medium', baseUrl: '', keyRef: '', api: 'openai-completions', reasoning: false },
    composer: '',
    composerCursor: 0,
    showSuggestions: false,
    commandOverlay: false,
    configSelected: 0,
    configEditing: false,
    configBuffer: '',
    configCursor: 0,
    configDirty: false,
    configPendingToggle: false,
    historyTotalBytes: 0,
    historyTab: 'runs',
    historyItems: [],
    historySelected: 0,
    intakeLevel: 'products',
    products: [],
    visibleProjects: [],
    activeProjectKey: '',
    visibleSessions: [],
    selected: 0,
    filterEligible: false,
    searchQuery: '',
    searchCursor: 0,
    searching: false,
    privacy: { allowModelText: false, redactions: [] },
    inspectionTaskInput: 0,
    inspectionShowOutcome: false,
    sourceRoot: 'C:\\x',
    sourceCursor: 0,
    effort: 'medium',
    timeline: [],
    visibleTimeline: [],
    timelineSelected: 0,
    timelineFilterIndex: 0,
    timelineFollowing: true,
    detailExpanded: false,
    runStartedAt: 1,
  } as never);
  assert.equal(view.running?.productLabel, 'Claude Code');
  assert.equal(view.productLabel, 'Claude Code');
  const text = renderWorkbench(view, 120).join('\n');
  assert.match(text, /候选运行中 · Claude Code/);
  assert.match(text, /发给 Claude Code/);
  assert.doesNotMatch(text, /候选运行中 · Codex/);
  assert.doesNotMatch(text, /发给 Codex/);
});

test('workflow listCatalog is the selected pack catalog', async () => {
  const workflow = createExperimentWorkflow({
    dataDir: 'unused',
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
