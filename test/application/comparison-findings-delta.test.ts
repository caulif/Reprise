import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Value } from '@sinclair/typebox/value';
import { ComparisonDiscovery } from '../../src/application/comparison-discovery.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { ComparisonFindingsDeltaSchema, ComparisonFindingsToolSubmissionSchema, ComparisonDiscoveryRecordSchema, type ComparisonDiscoveryRecord, type ComparisonFindingsDelta, type ComparisonFindingsSubmission } from '../../src/core/schema.js';
import { ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { AgentHost, type ProviderAdapter } from '../../src/infrastructure/agent/host.js';
import { sha256 } from '../../src/core/identity.js';
import { startExperiment } from '../../src/application/experiment.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, persist?: (record: ComparisonDiscoveryRecord) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-findings-delta-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scratch'));
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: 'attempt', links: [
    { side: 'baseline', inspectPath: 'baseline.txt', evidenceRef: 'artifact:baseline' }, { side: 'candidate', inspectPath: 'candidate.txt', evidenceRef: 'artifact:candidate' },
  ], media: [] });
  const [baseline, candidate] = catalog.snapshot().links.map(item => item.shortRef!);
  const submission: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: [
    { side: 'baseline', status: 'located', sourceRefs: [baseline!], description: 'Sealed baseline' }, { side: 'candidate', status: 'located', sourceRefs: [candidate!], description: 'Sealed candidate' },
  ], findings: [{ id: 'quality', criterion: 'Task usefulness', difference: 'Scoped observed difference', userConsequence: 'Could change usefulness',
    observations: (['baseline', 'candidate'] as const).map(side => ({ side, method: 'source_inspection', result: 'Actual retained observation', scope: 'Final output scope', evidenceRefs: [side === 'baseline' ? baseline! : candidate!], timing: 'comparison_check',
      supportBoundary: { relationship: 'Requested output', domain: 'Final output', supportStage: 'delivered_output', coveredInstances: ['Observed final'], uncheckedInstances: [] } })),
    limitations: ['One observed final does not cover all inputs'], counterEvidenceRefs: [],
  }], importantLimitations: ['Unchecked inputs remain unknown'], decisionQuestions: [
    { id: 'pending', question: 'Does another input change quality?', decisionImpact: 'Could change preference', status: 'pending', nextCheck: 'Check actual final with another input', evidenceRefs: [] },
    { id: 'settled', question: 'Was the final located?', decisionImpact: 'Bounds source scope', status: 'resolved', resolution: 'Located sealed sources, quality is separate', evidenceRefs: [baseline!, candidate!] },
  ] };
  const saved: ComparisonDiscoveryRecord[] = [];
  const discovery = new ComparisonDiscovery({ catalog, attemptId: 'attempt', persist: persist ?? (async record => { saved.push(record); }) });
  const delta = (): ComparisonFindingsDelta => {
    const current = discovery.snapshot()!;
    return { kind: 'delta', binding: { revision: current.revision, digest: current.digest, catalogRevision: catalog.snapshot().revision },
      findingDecisions: current.submission.findings.map(item => ({ id: item.id, action: 'retain' })), questionDecisions: current.submission.decisionQuestions.map(item => ({ id: item.id, action: 'retain' })) };
  };
  return { root, catalog, discovery, submission, saved, delta };
}

function strictFindingFixture(submission: ComparisonFindingsSubmission) {
  const finding = structuredClone(submission.findings[0]!);
  assert.ok(Value.Check(ComparisonFindingsDeltaSchema.properties.addedFindings.items, finding));
  return finding;
}

test('strict delta retains unchanged content explicitly and persists only model-supplied changes through the original full contract', async t => {
  const { discovery, submission, saved, delta } = await fixture(t); const signal = new AbortController().signal;
  await discovery.tool().execute(submission, signal); const before = discovery.snapshot()!;
  assert.match((await discovery.tool().execute(delta(), signal)).content, /^status=accepted\n/);
  assert.deepEqual(discovery.snapshot(), before); assert.equal(saved.length, 1); assert.equal(discovery.readyToCompose(), false, 'retaining pending is not completion');
  const changes = delta(), replacement = structuredClone(submission.decisionQuestions[0]!);
  replacement.status = 'unavailable'; replacement.resolution = 'Independent review did not verify another input; retain the decision-changing uncertainty.';
  changes.questionDecisions[0] = { id: replacement.id, action: 'replace', replacement };
  changes.importantLimitations = ['Independent review still cannot establish other inputs'];
  assert.match((await discovery.tool().execute(changes, signal)).content, /^status=accepted\n/);
  const after = discovery.snapshot()!; assert.equal(after.revision, 2); assert.equal(discovery.readyToCompose(), true);
  assert.deepEqual(after.submission.findings, before.submission.findings); assert.deepEqual(after.submission.finals, before.submission.finals);
  assert.deepEqual(after.submission.decisionQuestions[1], before.submission.decisionQuestions[1]); assert.deepEqual(after.submission.decisionQuestions[0], replacement);
  assert.deepEqual(after.submission.importantLimitations, changes.importantLimitations); assert.ok(Value.Check(ComparisonDiscoveryRecordSchema, after));
  const state = JSON.parse(discovery.state()) as { binding: unknown; findingIds: unknown; questionIds: unknown };
  assert.deepEqual(state.binding, { revision: 2, digest: after.digest, catalogRevision: after.catalogRevision });
  assert.deepEqual(state.findingIds, ['quality']); assert.deepEqual(state.questionIds, ['pending', 'settled']);
});

for (const deltaOnly of [false, true]) test(`bound additions use ${deltaOnly ? 'the dedicated delta tool' : 'the compatible original tool'} and preserve historical objects`, async t => {
  const { discovery, submission, saved, delta } = await fixture(t), signal = new AbortController().signal;
  submission.decisionQuestions[0]!.status = 'unavailable'; submission.decisionQuestions[0]!.resolution = 'No additional input was checked'; delete submission.decisionQuestions[0]!.nextCheck;
  await discovery.tool().execute(submission, signal); const before = discovery.snapshot()!;
  assert.equal(discovery.readyToCompose(), true);
  const change = delta(), finding = strictFindingFixture(submission);
  finding.id = 'new-difference'; finding.difference = 'An additional actual source observation';
  change.addedFindings = [finding];
  change.addedQuestions = [{ id: 'new-question', question: 'Could a distinct input reverse the preference?', decisionImpact: 'Could reverse the choice',
    status: 'pending', evidenceRefs: [], nextCheck: 'Check the actual final under that input' }];
  const tool = deltaOnly ? discovery.deltaTool() : discovery.tool();
  assert.equal(tool.name, deltaOnly ? 'update_comparison_findings_delta' : 'update_comparison_findings');
  if (deltaOnly) { assert.equal('anyOf' in tool.parameters, false); assert.equal(tool.parameters, ComparisonFindingsDeltaSchema); }
  assert.match((await tool.execute(change, signal)).content, /^status=accepted\n/);
  const after = discovery.snapshot()!;
  assert.equal(saved.length, 2); assert.equal(after.revision, 2); assert.ok(Value.Check(ComparisonDiscoveryRecordSchema, after));
  assert.deepEqual(after.submission.findings, [...before.submission.findings, finding]);
  assert.deepEqual(after.submission.decisionQuestions, [...before.submission.decisionQuestions, ...change.addedQuestions]);
  assert.equal(discovery.readyToCompose(), false, 'adding a pending question never certifies a ready decision');
  const state = JSON.parse(discovery.state()) as { deltaAdditionFields: { findings: string; questions: string } };
  assert.deepEqual(state.deltaAdditionFields, { findings: 'addedFindings', questions: 'addedQuestions' });
});

for (const mode of ['finding_collision', 'finding_duplicate', 'question_collision', 'question_duplicate', 'omit_old_finding', 'omit_old_question',
  'finding_total', 'question_total', 'side_refs', 'support_missing', 'criterion', 'next_check', 'stale_binding'] as const) test(`delta addition rejects ${mode} without mutating persisted state`, async t => {
  const { discovery, submission, saved, delta } = await fixture(t), signal = new AbortController().signal;
  await discovery.tool().execute(submission, signal); const before = discovery.snapshot()!, change = delta();
  const finding = strictFindingFixture(submission); finding.id = 'new-finding';
  const question = { id: 'new-question', question: 'Is a distinct input checked?', decisionImpact: 'Could reverse preference', status: 'pending' as const, evidenceRefs: [], nextCheck: 'Inspect the distinct actual output' };
  change.addedFindings = [finding]; change.addedQuestions = [question];
  if (mode === 'finding_collision') finding.id = submission.findings[0]!.id;
  if (mode === 'finding_duplicate') change.addedFindings.push(structuredClone(finding));
  if (mode === 'question_collision') question.id = submission.decisionQuestions[0]!.id;
  if (mode === 'question_duplicate') change.addedQuestions.push(structuredClone(question));
  if (mode === 'omit_old_finding') change.findingDecisions = [];
  if (mode === 'omit_old_question') change.questionDecisions = [];
  if (mode === 'finding_total') change.addedFindings = Array.from({ length: 12 }, (_, index) => ({ ...structuredClone(finding), id: `new-${index}` }));
  if (mode === 'question_total') change.addedQuestions = Array.from({ length: 15 }, (_, index) => ({ ...structuredClone(question), id: `new-${index}` }));
  if (mode === 'side_refs') finding.observations[0]!.evidenceRefs = finding.observations[1]!.evidenceRefs;
  if (mode === 'support_missing') delete (finding.observations[0]! as { supportBoundary?: unknown }).supportBoundary;
  if (mode === 'criterion') finding.criterion = 'Unregistered criterion';
  if (mode === 'next_check') delete change.addedQuestions[0]!.nextCheck;
  if (mode === 'stale_binding') change.binding.revision++;
  assert.match((await discovery.deltaTool().execute(change, signal)).content, /^status=rejected\n/);
  assert.deepEqual(discovery.snapshot(), before); assert.equal(saved.length, 1);
});

test('the dedicated delta tool shares schema rejection, binding protection and the original persistence queue', async t => {
  let block = false, entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const { discovery, submission, delta } = await fixture(t, async () => { if (block) { entered(); await released; } });
  const signal = new AbortController().signal;
  assert.match((await discovery.deltaTool().execute(submission, signal)).content, /code=invalid_findings/);
  assert.match((await discovery.deltaTool().execute({ kind: 'delta', binding: { revision: 1, digest: 'a'.repeat(64), catalogRevision: 0 }, findingDecisions: [], questionDecisions: [] }, signal)).content, /delta_snapshot_missing/);
  await discovery.tool().execute(submission, signal);
  const change = delta(); change.addedQuestions = [{ id: 'added', question: 'Was another output checked?', decisionImpact: 'Could change preference', status: 'unavailable', evidenceRefs: [], resolution: 'No additional check was performed' }];
  block = true;
  const pending = discovery.deltaTool().execute(change, signal); await entry;
  const queued = discovery.tool().execute(change, signal); release();
  assert.match((await pending).content, /^status=accepted\n/);
  assert.match((await queued).content, /delta_binding_stale/);
  assert.equal(discovery.snapshot()!.revision, 2);
});

test('dedicated delta addition persistence failure remains fatal and does not accept a materialized record', async t => {
  let fail = false;
  const { discovery, submission, delta } = await fixture(t, async () => { if (fail) throw new Error('Actual delta persistence failure'); });
  const signal = new AbortController().signal; await discovery.tool().execute(submission, signal); const before = discovery.snapshot();
  const change = delta(); change.addedFindings = [{ ...strictFindingFixture(submission), id: 'new-finding' }]; fail = true;
  await assert.rejects(discovery.deltaTool().execute(change, signal), /Actual delta persistence failure/);
  assert.deepEqual(discovery.snapshot(), before);
});

for (const mode of ['missing', 'revision', 'digest', 'catalog', 'omit_finding', 'extra_finding', 'duplicate_finding', 'omit_question', 'extra_question', 'duplicate_question', 'replacement_id', 'question_identity', 'reopen', 'support', 'side_refs', 'criterion'] as const) test(`delta ${mode} rejection preserves the actual saved snapshot`, async t => {
  const { discovery, submission, delta } = await fixture(t); const signal = new AbortController().signal;
  await discovery.tool().execute(submission, signal); const before = discovery.snapshot()!, change = delta();
  if (mode === 'revision') change.binding.revision++;
  if (mode === 'digest') change.binding.digest = '0'.repeat(64);
  if (mode === 'catalog') change.binding.catalogRevision++;
  if (mode === 'omit_finding') change.findingDecisions = [];
  if (mode === 'extra_finding') change.findingDecisions.push({ id: 'extra', action: 'retain' });
  if (mode === 'duplicate_finding') change.findingDecisions.push(change.findingDecisions[0]!);
  if (mode === 'omit_question') change.questionDecisions.pop();
  if (mode === 'extra_question') change.questionDecisions.push({ id: 'extra', action: 'retain' });
  if (mode === 'duplicate_question') change.questionDecisions[1] = change.questionDecisions[0]!;
  if (mode === 'question_identity' || mode === 'reopen') {
    const replacement = structuredClone(submission.decisionQuestions[1]!);
    if (mode === 'question_identity') replacement.decisionImpact = 'Changed old identity';
    else { replacement.status = 'pending'; replacement.nextCheck = 'Retry without new grounds'; }
    change.questionDecisions[1] = { id: 'settled', action: 'replace', replacement };
  }
  if (mode === 'replacement_id' || mode === 'support' || mode === 'side_refs' || mode === 'criterion') {
    const replacement = structuredClone(submission.findings[0]!);
    if (mode === 'replacement_id') replacement.id = 'different';
    if (mode === 'support') { replacement.observations[0]!.method = 'self_report'; }
    if (mode === 'side_refs') replacement.observations[0]!.evidenceRefs = replacement.observations[1]!.evidenceRefs;
    if (mode === 'criterion') replacement.criterion = 'Unknown criterion';
    change.findingDecisions[0] = { id: 'quality', action: 'replace', replacement: replacement as Extract<ComparisonFindingsDelta['findingDecisions'][number], { action: 'replace' }>['replacement'] };
  }
  const target = mode === 'missing' ? (await fixture(t)).discovery : discovery;
  const receipt = (await target.tool().execute(change, signal)).content;
  assert.match(receipt, /^status=rejected\n/); assert.deepEqual(target.snapshot(), mode === 'missing' ? undefined : before);
});

test('delta schema rejects omissions, delete actions and malformed support instead of silently retaining data', () => {
  const base = { kind: 'delta', binding: { revision: 1, digest: 'a'.repeat(64), catalogRevision: 0 }, findingDecisions: [], questionDecisions: [] };
  assert.equal(Value.Check(ComparisonFindingsDeltaSchema, base), true);
  assert.equal(ComparisonFindingsToolSubmissionSchema.type, 'object'); assert.equal(Value.Check(ComparisonFindingsToolSubmissionSchema, base), true);
  for (const invalid of [{ ...base, questionDecisions: undefined }, { ...base, findingDecisions: [{ id: 'quality', action: 'delete' }] },
    { ...base, findingDecisions: [{ id: 'quality', action: 'replace' }] }, { ...base, binding: { ...base.binding, revision: 0 } },
    { ...base, unexpected: 'ignored input' }]) assert.equal(Value.Check(ComparisonFindingsDeltaSchema, invalid), false);
});

test('delta binds the current source catalog without rewriting retained observations', async t => {
  const { root, catalog, discovery, submission, delta } = await fixture(t); const signal = new AbortController().signal;
  await discovery.tool().execute(submission, signal); const before = discovery.snapshot()!, stale = delta();
  await writeFile(join(root, 'scratch', 'independent.txt'), 'Independent source observation retained separately.');
  const registered = await catalog.registerEvidence({ relativePath: 'independent.txt', sourceRefs: submission.finals[0]!.sourceRefs, label: 'Independent check' }, signal);
  assert.equal(registered.status, 'registered'); assert.ok(catalog.snapshot().revision > before.catalogRevision);
  assert.match((await discovery.tool().execute(stale, signal)).content, /delta_binding_stale/);
  assert.match((await discovery.tool().execute(delta(), signal)).content, /^status=accepted\n/);
  const after = discovery.snapshot()!; assert.equal(after.revision, before.revision + 1); assert.equal(after.catalogRevision, catalog.snapshot().revision);
  assert.deepEqual(after.submission, before.submission); assert.equal(after.digest, before.digest);
});

test('retained legacy observations cannot bypass the complete strict tool schema', async t => {
  const { discovery, submission, delta } = await fixture(t);
  for (const observation of submission.findings[0]!.observations) delete observation.supportBoundary;
  await discovery.update(submission); const before = discovery.snapshot();
  assert.match((await discovery.tool().execute(delta(), new AbortController().signal)).content, /delta_materialized_invalid/);
  assert.deepEqual(discovery.snapshot(), before);
});

for (const mode of ['cancel', 'persist', 'catalog_change', 'queued_stale'] as const) test(`delta fails closed for ${mode} without accepting a stale materialization`, async t => {
  let stopPersistence = false, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const { root, discovery, submission, catalog, delta } = await fixture(t, async () => { if (stopPersistence) { enter(); await released; if (mode === 'persist') throw new Error('Actual persist failure'); } });
  const controller = new AbortController(); await discovery.tool().execute(submission, controller.signal); const before = discovery.snapshot()!;
  const change = delta(); change.importantLimitations = ['New independent uncertainty'];
  stopPersistence = true;
  const executing = discovery.tool().execute(change, controller.signal);
  const rejected = mode === 'queued_stale' ? undefined : assert.rejects(executing);
  await entered;
  let queued: ReturnType<ReturnType<ComparisonDiscovery['tool']>['execute']> | undefined;
  if (mode === 'cancel') controller.abort();
  if (mode === 'catalog_change') {
    await writeFile(join(root, 'scratch', 'concurrent.txt'), 'A concurrent independent source check.');
    assert.equal((await catalog.registerEvidence({ relativePath: 'concurrent.txt', sourceRefs: submission.finals[0]!.sourceRefs, label: 'Concurrent check' })).status, 'registered');
  }
  if (mode === 'queued_stale') queued = discovery.tool().execute(change, controller.signal);
  release();
  if (rejected) { await rejected; assert.deepEqual(discovery.snapshot(), before); }
  else {
    assert.match((await executing).content, /^status=accepted\n/);
    assert.match((await queued!).content, /delta_binding_stale/); assert.equal(discovery.snapshot()!.revision, before.revision + 1);
  }
});

function actualRequests(session: Parameters<ProviderAdapter['createSession']>[0]) {
  const messages: unknown[] = []; let callId = 0;
  const tools = session.tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    const id = `delta-call-${++callId}`;
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: tool.name, arguments: structuredClone(params) }] });
    const result = await tool.execute(params, signal);
    messages.push({ role: 'toolResult', toolCallId: id, toolName: tool.name, content: result.contentBlocks ?? [{ type: 'text', text: result.content }] });
    return result;
  } }));
  return { tools, request: async (content: string, allowedToolNames?: readonly string[]) => {
    messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
    const context = { systemPrompt: session.systemPrompt, messages: structuredClone(messages),
      tools: session.tools.filter(tool => !allowedToolNames || allowedToolNames.includes(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })) };
    await session.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(JSON.stringify(context)), messageCount: messages.length, images: [], generationContext: context });
  } };
}

for (const changed of [false, true]) test(`production ${changed ? 'replacement' : 'retained'} delta uses actual accepted receipt and the full independent publication chain`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-delta-publication-')); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime()); await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  const initial: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final remains unchecked' })),
    findings: [], importantLimitations: ['Quality remains unverified'], decisionQuestions: [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'Could change preference', status: 'unavailable', evidenceRefs: [], resolution: 'Author did not verify final quality' }] };
  const draft = { status: 'insufficient_evidence', decisionShape: 'single_difference', category: 'Results', headline: 'Quality remains unverified.',
    decisionSummary: 'The usefulness of both final outputs remains unknown.', decisionBoundary: 'Final quality could change model preference.', decisionBasis: [], conclusionScope: 'undetermined', findingDispositions: [], comparisonHtml: '<p>No supported replacement choice.</p>' };
  let turns = 0, actualDelta = false;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0, host: new AgentHost({ createSession: session => {
    const { tools, request } = actualRequests(session);
    const call = (name: string, params: unknown, signal: AbortSignal) => tools.find(tool => tool.name === name)!.execute(params, signal);
    return { append: async ({ content, signal, allowedToolNames, yieldAfterTurn }) => {
      turns++; await request(content, allowedToolNames);
      if (content.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
        assert.deepEqual(allowedToolNames, ['update_comparison_findings']);
        assert.match((await call('update_comparison_findings', initial, signal)).content, /^status=accepted\n/);
      } else if (content.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) assert.match((await call('submit_comparison_draft', draft, signal)).content, /^status=accepted\n/);
      else if (content.includes('This is the actual draft inspection checkpoint')) await call('inspect_comparison_draft', {}, signal);
      else if (content.includes('This is the independent review findings closure')) {
        const state = JSON.parse(content.split('Current saved findings (hypotheses only): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { record: ComparisonDiscoveryRecord; binding: ComparisonFindingsDelta['binding'] };
        assert.ok(Value.Check(ComparisonDiscoveryRecordSchema, state.record));
        assert.match(content, /kind="delta"/); assert.match(content, /binding=the exact current state.binding object/);
        assert.match(content, /findingDecisions=/); assert.match(content, /questionDecisions=/);
        assert.match(content, /Both arrays are required even when empty; their entries are objects, never strings/);
        const delta: ComparisonFindingsDelta = { kind: 'delta', binding: state.binding, findingDecisions: state.record.submission.findings.map(item => ({ id: item.id, action: 'retain' })),
          questionDecisions: state.record.submission.decisionQuestions.map(item => changed ? { id: item.id, action: 'replace', replacement: { ...item, resolution: 'Independent review still cannot establish final quality; retain its effect on preference.' } } : { id: item.id, action: 'retain' }) };
        assert.ok(Value.Check(ComparisonFindingsDeltaSchema, delta)); assert.deepEqual(allowedToolNames, ['read', 'update_comparison_findings', 'update_comparison_findings_delta']);
        assert.match((await call('update_comparison_findings_delta', delta, signal)).content, /^status=accepted\n/); actualDelta = true;
      } else if (content.includes('The initial checkpoint is not formal certification: after this full audit')) {
        assert.ok(actualDelta); if (changed) assert.match((await call('submit_comparison_draft', draft, signal)).content, /^status=accepted\n/);
        await call('inspect_comparison_draft', {}, signal);
      } else if (content.includes('This is the preview-only closure')) {
        assert.ok(actualDelta); assert.deepEqual(allowedToolNames, ['preview_report']);
        const receipt = JSON.parse((await call('preview_report', {}, signal)).content) as { status: string }; assert.equal(receipt.status, 'ok');
      }
      const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : '';
    }, cancel() {} };
  } }) });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result)); assert.equal(turns, 8); assert.ok(actualDelta);
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { sequence: number; type: string; payload: Record<string, unknown> });
  assert.equal(events.filter(event => event.type === 'comparison.findings_updated').length, changed ? 2 : 1);
  const updates = events.filter(event => event.type === 'agent.tool_completed' && ['update_comparison_findings', 'update_comparison_findings_delta'].includes(String(event.payload.tool)) && !event.payload.nativeHook);
  assert.equal(updates.length, 2, 'initial snapshot and independent delta must both actually execute');
  assert.equal(updates[0]!.payload.tool, 'update_comparison_findings'); assert.equal(updates[1]!.payload.tool, 'update_comparison_findings_delta');
  const closure = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings')!;
  assert.equal(closure.payload.yieldReason, 'review_findings_ready'); assert.ok(updates[1]!.sequence < closure.sequence);
  const audit = events.find(event => event.type === 'comparison.draft_audit_started')!;
  const inspection = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft').at(-1)!;
  const preview = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report')!;
  assert.ok(audit.sequence > closure.sequence && inspection.sequence > audit.sequence && preview.sequence > inspection.sequence);
  assert.ok(events.some(event => event.type === 'agent.model_request' && event.sequence > inspection.sequence && event.sequence < preview.sequence && 'generationInput' in event.payload));
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Quality remains unverified/);
});
