import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonAgent } from '../../src/agents/comparison-agent.js';
import { COMPARISON_INITIAL_FINDINGS_PROMPT } from '../../src/agents/comparison-initial-findings.js';
import { COMPARISON_AUTHOR_COMPOSE_PROMPT } from '../../src/agents/comparison-author-prompt.js';
import { startExperiment } from '../../src/application/experiment.js';
import { AgentHost, type ProviderAdapter } from '../../src/infrastructure/agent/host.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';
import { sha256 } from '../../src/core/identity.js';
import { Value } from '@sinclair/typebox/value';
import { ComparisonDiscoveryRecordSchema, type ComparisonDiscoveryRecord, type ComparisonFindingsSubmission } from '../../src/core/schema.js';

function fixtureContext(input: Parameters<ProviderAdapter['createSession']>[0], recordActual = true) {
  const messages: unknown[] = [];
  let toolSequence = 0;
  const tools = input.tools.map(tool => ({ ...tool, execute: async (params: unknown, signal: AbortSignal) => {
    const toolCallId = `fixture-${++toolSequence}`;
    messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: tool.name, arguments: structuredClone(params) }] });
    const result = await tool.execute(params, signal);
    messages.push({ role: 'toolResult', toolCallId, toolName: tool.name,
      content: structuredClone(result.contentBlocks ?? [{ type: 'text', text: result.content }]) });
    return result;
  } }));
  return { tools, request: async (content: string, allowedToolNames?: readonly string[]) => {
    messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
    const context = { systemPrompt: input.systemPrompt, messages: structuredClone(messages),
      tools: input.tools.filter(tool => !allowedToolNames || allowedToolNames.includes(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters })) };
    await input.onModelRequest?.({ model: 'fixture', scope: 'generation', digest: sha256(JSON.stringify(context)),
      messageCount: messages.length, images: [], ...(recordActual ? { generationContext: context } : {}) });
  } };
}

for (const repairable of [true, false]) test(`review revision ${repairable ? 'is previewed by a continuation' : 'cannot extend review indefinitely'}`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-review-revision-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0, checkpointVisits = 0;
  const comparison = new ComparisonAgent({ host: new AgentHost({ createSession: (sessionInput) => {
    const { tools, request } = fixtureContext(sessionInput);
    return {
    append: async ({ content, signal, allowedToolNames }) => {
      turns++;
      await request(content, allowedToolNames);
      const submit = tools.find((tool) => tool.name === 'submit_comparison_draft')!;
      const preview = tools.find((tool) => tool.name === 'preview_report')!;
      const draft = (headline: string) => ({ status: 'completed', decisionShape: 'single_difference', category: 'Results', headline,
        decisionSummary: 'The result is useful for the requested task.', decisionBoundary: '', decisionBasis: [], conclusionScope: 'supported_in_scope', findingDispositions: [], comparisonHtml: `<p>${headline}</p>` });
      if (turns === 2) await submit.execute(draft('Draft A'), signal);
      if (content.includes('This is the actual draft inspection checkpoint')) {
        checkpointVisits++;
        assert.deepEqual(allowedToolNames, ['inspect_comparison_draft']);
        await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        return '';
      }
      if (turns === 5) {
        assert.ok(!allowedToolNames?.includes('preview_report'));
        assert.match((await preview.execute({}, signal)).content, /preview_not_ready/);
        const revised = await submit.execute(draft('Draft B'), signal);
        assert.match(revised.content, /currentPhase=review/);
        assert.doesNotMatch(revised.content, /currentPhase=compose/);
      }
      if (content.includes('This is the preview-only closure')) {
        assert.deepEqual(allowedToolNames, ['preview_report']);
        const outcome = JSON.parse((await preview.execute({}, signal)).content) as { status: string };
        assert.equal(outcome.status, 'ok', JSON.stringify(outcome));
        return '';
      }
      if (turns > 5) {
        assert.match(content, /Continue the current review turn/);
        if (repairable && turns === 6) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        }
        else if (!repairable) await submit.execute(draft(`Draft ${turns}`), signal);
      }
      return '';
    }, cancel() {},
    };
  } }), timeoutMs: 0, maxRepairAttempts: 0 });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(checkpointVisits, 1, 'actual inspection-only checkpoint must execute');
  assert.equal(turns, 7, JSON.stringify(result.comparison.result));
  assert.equal(result.comparison.result.status, repairable ? 'completed' : 'failed', JSON.stringify(result.comparison.result));
  if (repairable) assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Draft B/);
  else await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});

for (const recordActual of [true, false]) test(`application ${recordActual ? 'publishes' : 'rejects legacy projection of'} a submitted and previewed draft after an empty final message`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-flow-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0, checkpointVisits = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: (sessionInput) => {
      const { tools, request } = fixtureContext(sessionInput, recordActual);
      return {
      append: async ({ content, signal, allowedToolNames }) => {
        turns++;
        await request(content, allowedToolNames);
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          const accepted = await submit.execute({
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'The candidate produced a usable result.',
            decisionSummary: 'The result is useful for the requested task.', decisionBoundary: '',
            decisionBasis: [], conclusionScope: 'supported_in_scope', findingDispositions: [],
            comparisonHtml: '<p>The candidate produced a usable result from the same starting task.</p>',
          }, signal);
          assert.match(accepted.content, /status=accepted/);
        }
        if (content.includes('This is the actual draft inspection checkpoint')) {
          checkpointVisits++;
          assert.deepEqual(allowedToolNames, ['inspect_comparison_draft']);
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
          return '';
        }
        if (content.includes('This is the preview-only closure')) {
          assert.deepEqual(allowedToolNames, ['preview_report']);
          const preview = tools?.find((tool) => tool.name === 'preview_report');
          assert.ok(preview);
          const result = await preview.execute({}, signal);
          assert.equal((JSON.parse(result.content) as { status: string }).status, 'ok');
        }
        if (content.includes('The initial checkpoint is not formal certification: after this full audit')) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        }
        return '';
      },
      cancel() {},
      };
    } }),
    timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(checkpointVisits, 1, 'actual inspected text must precede full audit');
  if (!recordActual) {
    assert.equal(result.comparison.result.status, 'failed');
    const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
    assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft'));
    assert.ok(events.some(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report'));
    const requests = events.filter(event => event.type === 'agent.model_request');
    assert.ok(requests.length > 0);
    assert.ok(requests.every(event => !('generationInput' in event.payload)), 'digest-only requests cannot certify delivered inspection');
    await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
    return;
  }
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result));
  assert.equal(turns, 6, 'one actual full audit is followed by preview-only generation with no post-preview generation');
  assert.deepEqual(result.facts.comparisonActivity, { modelRequests: 6, toolCalls: 4, compactions: 0 });
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /usable result/);
  const events = await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8');
  assert.match(events, /comparison.phase_completed/);
  const recorded = events.trim().split('\n').map(line => JSON.parse(line) as { sequence: number; type: string; payload: Record<string, unknown> });
  const auditStarted = recorded.find(event => event.type === 'comparison.draft_audit_started');
  assert.ok(auditStarted);
  const inspection = recorded.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft').at(-1);
  assert.ok(inspection);
  assert.ok(inspection.sequence > auditStarted.sequence, 'checkpoint inspection cannot certify the subsequent full audit');
  const generation = recorded.find(event => event.type === 'agent.model_request' && event.payload.scope === 'generation'
    && event.sequence > inspection.sequence && event.payload.sessionId === inspection.payload.sessionId && 'generationInput' in event.payload);
  const preview = recorded.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report');
  assert.ok(generation); assert.ok(preview);
  assert.ok(inspection.sequence < generation.sequence && generation.sequence < preview.sequence,
    'actual inspection must enter a later generation snapshot in the same review session before the unchanged draft is previewed');
});

for (const bounded of [false, true]) test(`production requireFindings ${bounded ? 'Host deadline closure preserves pending identities and independent review' : 'uses an actual accepted review update'} before the full publication chain`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-review-findings-publication-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  const findings: ComparisonFindingsSubmission = { criteria: ['Task usefulness'], finals: (['baseline', 'candidate'] as const).map(side => ({ side, status: 'unavailable', sourceRefs: [], description: 'Final not independently located by this fixture' })),
    findings: [], importantLimitations: ['Final sources remain unverified'], decisionQuestions: bounded ? [{ id: 'quality', question: 'Is the final useful?', decisionImpact: 'Could change model preference', status: 'pending', nextCheck: 'Inspect both actual final outputs', evidenceRefs: [] }] : [] };
  let reviewFindings = findings;
  let turns = 0, reviewUpdates = 0;
  const comparison = new ComparisonAgent({ requireFindings: true, timeoutMs: 0, maxRepairAttempts: 0, resources: { investigationMs: 120_000 },
    host: new AgentHost({ createSession: sessionInput => {
      const { tools, request } = fixtureContext(sessionInput);
      const call = (name: string, params: unknown, signal: AbortSignal) => tools.find(tool => tool.name === name)!.execute(params, signal);
      return { append: async ({ content, signal, allowedToolNames, yieldAfterTurn, yieldDeadline }) => {
        turns++; await request(content, allowedToolNames);
        if (content.includes(COMPARISON_INITIAL_FINDINGS_PROMPT)) {
          assert.deepEqual(allowedToolNames, ['update_comparison_findings']);
          assert.match((await call('update_comparison_findings', findings, signal)).content, /^status=accepted/);
          if (bounded) { assert.equal(yieldDeadline?.reason, 'bounded_investigation_timeout'); return { status: 'yielded' as const, reason: 'bounded_investigation_timeout' }; }
        }
        else if (content.includes(COMPARISON_AUTHOR_COMPOSE_PROMPT)) {
          if (bounded) {
            assert.match(content, /Host may have marked saved pending questions unavailable only because the actual investigation deadline ended/);
            const state = JSON.parse(content.split('Saved findings (provenance checked, semantics still require review): ')[1]!.split('\n\nCurrent Host-owned metric pair:')[0]!) as { record: ComparisonDiscoveryRecord };
            assert.ok(Value.Check(ComparisonDiscoveryRecordSchema, state.record)); reviewFindings = state.record.submission;
            assert.equal(reviewFindings.decisionQuestions[0]!.status, 'unavailable');
            assert.equal(reviewFindings.decisionQuestions[0]!.decisionImpact, findings.decisionQuestions[0]!.decisionImpact);
            assert.match(reviewFindings.decisionQuestions[0]!.resolution!, /not a semantic answer/);
          }
          assert.match((await call('submit_comparison_draft', {
          status: 'insufficient_evidence', decisionShape: 'single_difference', category: 'Results', headline: 'Outputs remain unverified.',
          decisionSummary: 'Both outcomes still need task-quality assessment.', decisionBoundary: 'Final source checks are unavailable.',
          decisionBasis: [], conclusionScope: 'undetermined', findingDispositions: [], comparisonHtml: '<p>No supported replacement choice.</p>',
        }, signal)).content, /status=accepted/);
        }
        else if (content.includes('This is the actual draft inspection checkpoint') || content.includes('The initial checkpoint is not formal certification: after this full audit')) await call('inspect_comparison_draft', {}, signal);
        else if (content.includes('This is the independent review findings closure')) {
          reviewUpdates++; assert.deepEqual(allowedToolNames, ['read', 'update_comparison_findings']);
          assert.match((await call('update_comparison_findings', reviewFindings, signal)).content, /^status=accepted/);
        } else if (content.includes('This is the preview-only closure')) {
          assert.deepEqual(allowedToolNames, ['preview_report']);
          const receipt = JSON.parse((await call('preview_report', {}, signal)).content) as { status: string }; assert.equal(receipt.status, 'ok');
        }
        const reason = await yieldAfterTurn?.(); return reason ? { status: 'yielded' as const, reason } : '';
      }, cancel() {} };
    } }),
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'completed', JSON.stringify(result.comparison.result)); assert.equal(reviewUpdates, 1); assert.equal(turns, bounded ? 7 : 8);
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { sequence: number; type: string; payload: Record<string, unknown> });
  const closure = events.find(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'review-findings');
  assert.equal(closure?.payload.yieldReason, 'review_findings_ready');
  const acceptedUpdates = events.filter(event => event.type === 'comparison.findings_updated');
  assert.equal(acceptedUpdates.length, bounded ? 2 : 1, 'Host closure gets a revision; unchanged independent review does not force another');
  const hostClosure = events.filter(event => event.type === 'comparison.investigation_closed');
  assert.equal(hostClosure.length, bounded ? 1 : 0);
  if (bounded) {
    assert.deepEqual(hostClosure[0]!.payload.questionIds, ['quality']);
    assert.equal(hostClosure[0]!.payload.semanticAssessment, 'not_certified');
    assert.ok(acceptedUpdates[1]!.sequence < hostClosure[0]!.sequence);
    assert.equal(events.filter(event => event.type === 'comparison.phase_completed' && event.payload.pass === 'findings').length, 0, 'Host deadline closure does not create paid snapshot calls');
  }
  const actualUpdates = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'update_comparison_findings');
  assert.equal(actualUpdates.length, 2, 'author and independent review both actually execute the update tool');
  assert.ok(actualUpdates[1]!.sequence < closure.sequence);
  const audit = events.find(event => event.type === 'comparison.draft_audit_started'); assert.ok(audit && audit.sequence > closure.sequence);
  const inspection = events.filter(event => event.type === 'agent.tool_completed' && event.payload.tool === 'inspect_comparison_draft').at(-1);
  const preview = events.find(event => event.type === 'agent.tool_completed' && event.payload.tool === 'preview_report')!;
  const generation = events.find(event => event.type === 'agent.model_request' && event.sequence > inspection!.sequence && event.sequence < preview.sequence && 'generationInput' in event.payload);
  assert.ok(inspection && inspection.sequence > audit.sequence && generation && preview.sequence > generation.sequence);
  assert.match(await readFile(join(result.experimentRoot, 'report.html'), 'utf8'), /Outputs remain unverified/);
});

test('application refuses to publish an accepted draft without preview', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-unpreviewed-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0, checkpointVisits = 0;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: sessionInput => {
      const { tools, request } = fixtureContext(sessionInput);
      return {
      append: async ({ content, signal, allowedToolNames }) => {
        turns++;
        await request(content, allowedToolNames);
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          assert.match((await submit.execute({
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'A difference.',
            decisionSummary: 'One outcome better meets the requested task.', decisionBoundary: '',
            decisionBasis: [], conclusionScope: 'supported_in_scope', findingDispositions: [],
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        if (content.includes('This is the actual draft inspection checkpoint')) {
          checkpointVisits++;
          assert.deepEqual(allowedToolNames, ['inspect_comparison_draft']);
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        }
        if (content.includes('The initial checkpoint is not formal certification: after this full audit')) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        }
        return '';
      }, cancel() {},
    }; } }), timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(checkpointVisits, 1);
  assert.equal(result.comparison.result.status, 'failed');
  if (result.comparison.result.status === 'failed') assert.equal(result.comparison.result.failure.code, 'preview_failed');
  await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});

test('a provider failure after preview does not publish the draft', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-submission-provider-failed-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true });
  await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0, checkpointVisits = 0, previewRan = false;
  const comparison = new ComparisonAgent({
    host: new AgentHost({ createSession: sessionInput => {
      const { tools, request } = fixtureContext(sessionInput);
      return {
      append: async ({ content, signal, allowedToolNames }) => {
        turns++;
        await request(content, allowedToolNames);
        if (turns === 2) {
          const submit = tools?.find((tool) => tool.name === 'submit_comparison_draft');
          assert.ok(submit);
          assert.match((await submit.execute({
            status: 'completed', decisionShape: 'single_difference', category: 'Results', headline: 'A difference.',
            decisionSummary: 'One outcome better meets the requested task.', decisionBoundary: '',
            decisionBasis: [], conclusionScope: 'supported_in_scope', findingDispositions: [],
            comparisonHtml: '<p>One outcome differs from the other.</p>',
          }, signal)).content, /status=accepted/);
        }
        if (content.includes('This is the actual draft inspection checkpoint')) {
          checkpointVisits++;
          assert.deepEqual(allowedToolNames, ['inspect_comparison_draft']);
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
          return '';
        }
        if (content.includes('This is the preview-only closure')) {
          assert.deepEqual(allowedToolNames, ['preview_report']);
          const preview = tools?.find((tool) => tool.name === 'preview_report');
          assert.ok(preview);
          assert.equal((JSON.parse((await preview.execute({}, signal)).content) as { status: string }).status, 'ok');
          previewRan = true;
          throw Object.assign(new Error('Provider unavailable during review'), { status: 503 });
        }
        if (content.includes('The initial checkpoint is not formal certification: after this full audit')) {
          await tools.find(tool => tool.name === 'inspect_comparison_draft')!.execute({}, signal);
        }
        return '';
      }, cancel() {},
    }; } }), timeoutMs: 0, maxRepairAttempts: 0,
  });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(checkpointVisits, 1); assert.equal(previewRan, true, 'Provider failure must actually occur after successful preview');
  assert.equal(result.comparison.result.status, 'failed');
  if (result.comparison.result.status === 'failed') {
    assert.equal(result.comparison.result.failure.code, 'provider_failure');
    assert.equal(result.comparison.result.failure.kind, 'transient_upstream');
  }
  await assert.rejects(readFile(join(result.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
  assert.match(await readFile(join(result.experimentRoot, 'comparison-failure.html'), 'utf8'), /data-failure-phase="review"/);
});

test('production failure page reports compose when a Provider fails before submitting the preexisting Host shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'reprise-compose-failure-phase-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = input(root, new VerifiedRuntime());
  await mkdir(base.sourceRoot, { recursive: true }); await writeFile(join(base.sourceRoot, 'README.md'), '# source\n');
  let turns = 0;
  const comparison = new ComparisonAgent({ timeoutMs: 0, maxRepairAttempts: 0, host: new AgentHost({ createSession: sessionInput => {
    const { request } = fixtureContext(sessionInput);
    return { append: async ({ content, allowedToolNames }) => {
      turns++; await request(content, allowedToolNames);
      if (turns === 2) throw Object.assign(new Error('Stream ended without finish_reason'), { status: 503 });
      return '';
    }, cancel() {} };
  } }) });
  const result = await startExperiment({ ...base, comparison }).result;
  assert.equal(result.comparison.result.status, 'failed'); assert.equal(turns, 2);
  const events = (await readFile(join(result.experimentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
  const failed = events.filter(event => event.type === 'comparison.phase_completed').at(-1);
  assert.equal(failed?.payload.phase, 'compose'); assert.equal(failed?.payload.outcome, 'failed');
  assert.equal(events.filter(event => event.type === 'comparison.draft_accepted').length, 0);
  const attempt = events.find(event => event.type === 'comparison.started')!.payload.attemptId as string;
  assert.ok((await readFile(join(result.experimentRoot, 'comparison-attempts', attempt, 'report.html'), 'utf8')).includes('data-agent-zone="comparison"'));
  assert.match(await readFile(join(result.experimentRoot, 'comparison-failure.html'), 'utf8'), /data-failure-phase="compose"/);
});
