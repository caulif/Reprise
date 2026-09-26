import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComparisonDraft } from '../../src/application/comparison-draft.js';
import { ComparisonEvidenceCatalog } from '../../src/application/comparison-evidence.js';
import { experimentAgentAuditSink } from '../../src/application/experiment-helpers.js';
import { prepareComparisonArtifacts } from '../../src/application/comparison-publication.js';
import { inspectComparisonRecovery, publishRecoveredComparison } from '../../src/application/comparison-recovery.js';
import { readLocalHistory } from '../../src/application/experiment-history-list.js';
import { sha256 } from '../../src/core/identity.js';
import { ComparisonInvocationSchema } from '../../src/core/schema.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { Value } from '@sinclair/typebox/value';

const experimentId = 'experiment-1';
const attemptId = 'attempt-1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
const facts = {
  run: { runId: 'run-1', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'controller' },
  models: { candidate: 'candidate', baseline: 'baseline' },
  activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
  delivery: { changedPaths: [], targetArtifactStatus: 'available', verificationStatus: 'available' },
  replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' },
};

async function fixture(preview: boolean, visual?: 'message' | 'tool' | 'tool-artifact' | 'other-session' | 'missing') {
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-recovery-'));
  const experimentRoot = join(dataDir, 'experiments', experimentId);
  const attemptRoot = join(experimentRoot, 'comparison-attempts', attemptId);
  await mkdir(join(attemptRoot, 'facts'), { recursive: true });
  await writeFile(join(experimentRoot, 'experiment.json'), JSON.stringify({
    spec: {
      schemaVersion: 1, experimentId, taskCaseId: 'case-1',
      candidates: [{ candidateId: 'candidate', productId: 'codex', requestedModel: 'model' }],
      controller: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
      comparison: { providerId: 'provider', requestedModel: 'model', budget: { callTimeoutMs: 1, maxStructuredRepairAttempts: 0 } },
      runPolicy: { wallClockMs: 1, maxTargetTurns: 1, maxModelCalls: 1, turnTimeoutMs: 1, maxConsecutiveNoProgress: 1 },
      outputRoot: experimentRoot,
    },
    runIds: [],
  }));
  const imageHash = sha256(png);
  if (visual) {
    await mkdir(join(attemptRoot, 'media'), { recursive: true });
    await writeFile(join(attemptRoot, 'media', 'seed.png'), png);
  }
  const catalog = await ComparisonEvidenceCatalog.create({
    attemptRoot, attemptId, links: [],
    media: visual ? [{ ref: 'media:seed', side: 'candidate', inspectPath: 'media/seed.png', reportHref: 'media/seed.png', mediaType: 'image/png', available: true, contentHash: imageHash }] : [],
  });
  const context = {
    task: { caseId: 'case-1', summary: 'Compare outputs.' },
    baseline: { summary: 'Baseline.', evidenceRefs: [] }, candidates: [], telemetry: [],
    reportFacts: facts, artifactRefs: [], allowModelText: true,
    replayScope: { historical: 'baseline', candidate: 'candidate' }, media: [],
  };
  await writeFile(join(attemptRoot, 'facts', 'context.json'), JSON.stringify(context));
  const draft = new ComparisonDraft({ attemptRoot, task: context.task.summary, facts, locale: 'en', catalog, deliveredImages: new Set(visual ? [imageHash] : []) });
  const comparisonHtml = visual
    ? '<p><span data-claim="visual" data-media-ref="media-01">Candidate image is red.</span></p><img data-media-ref="media-01" alt="candidate image">'
    : '<p>Candidate differs in a verified way.</p>';
  assert.match(await draft.submit({ status: 'completed', category: 'Results', headline: 'A concrete difference.', comparisonHtml }), /status=accepted/);
  const html = await readFile(join(attemptRoot, 'report.html'), 'utf8');
  const store = await ExperimentStore.open(experimentRoot, experimentId);
  await store.acquireWriter();
  const audit = experimentAgentAuditSink(store, 'run-1');
  if (visual === 'message' || visual === 'other-session') await audit.append({
    type: 'agent.message_appended', sessionId: visual === 'other-session' ? 'another-session' : 'comparison-session-1', role: 'comparison',
    payload: { attemptId, images: [{ type: 'image', mimeType: 'image/png', contentHash: imageHash, byteLength: png.byteLength }] },
  });
  if (visual === 'tool' || visual === 'tool-artifact') await audit.append({
    type: 'agent.tool_completed', sessionId: 'comparison-session-1', role: 'comparison',
    payload: { attemptId, tool: 'read_image', nativeHook: 'after', contentTypes: ['image'], byteLength: png.byteLength, contentDigest: imageHash, isError: false },
  });
  if (visual === 'tool' || visual === 'tool-artifact') await audit.append({
    type: 'agent.tool_completed', sessionId: 'comparison-session-1', role: 'comparison',
    payload: {
      attemptId, tool: 'read_image', contentTypes: ['image'],
      body: { encoding: 'inline', schemaVersion: 1, text: JSON.stringify([
        { type: 'image', mimeType: 'image/png', contentHash: imageHash, byteLength: png.byteLength },
        ...(visual === 'tool-artifact' ? [{ type: 'text', text: 'x'.repeat(9_000) }] : []),
      ]) },
    },
  });
  if (preview) await audit.append({
    type: 'agent.tool_completed', sessionId: 'comparison-session-1', role: 'comparison',
    payload: {
      attemptId, tool: 'preview_report',
      details: { status: 'ok', revision: catalog.snapshot().revision, draftDigest: sha256(html) },
    },
  });
  await store.close();
  return { dataDir, experimentRoot, attemptRoot, html, input: { dataDir, experimentId, attemptId } };
}

test('offline recovery requires the frozen preview digest and never overwrites a prior report', async (t) => {
  const good = await fixture(true);
  t.after(() => rm(good.dataDir, { recursive: true, force: true }));
  assert.equal((await inspectComparisonRecovery(good.input)).ready, true);
  await writeFile(join(good.experimentRoot, 'report.html'), 'previous success');
  await assert.rejects(publishRecoveredComparison({ ...good.input, status: 'completed' }), /already exists/);
  assert.equal(await readFile(join(good.experimentRoot, 'report.html'), 'utf8'), 'previous success');
  await writeFile(join(good.attemptRoot, 'report.html'), `${good.html}\n<!-- changed -->`);
  assert.equal((await inspectComparisonRecovery(good.input)).ready, false);

  const missing = await fixture(false);
  t.after(() => rm(missing.dataDir, { recursive: true, force: true }));
  assert.equal((await inspectComparisonRecovery(missing.input)).ready, false);
});

test('recovery accepts visual claims only when the preview Session received the image', async (t) => {
  for (const source of ['message', 'tool', 'tool-artifact'] as const) {
    const ready = await fixture(true, source);
    t.after(() => rm(ready.dataDir, { recursive: true, force: true }));
    assert.equal((await inspectComparisonRecovery(ready.input)).ready, true);
    await publishRecoveredComparison({ ...ready.input, status: 'completed' });
    assert.match(await readFile(join(ready.experimentRoot, 'report.html'), 'utf8'), /Candidate image is red/);
  }
  for (const source of ['missing', 'other-session'] as const) {
    const unproven = await fixture(true, source);
    t.after(() => rm(unproven.dataDir, { recursive: true, force: true }));
    const checked = await inspectComparisonRecovery(unproven.input);
    assert.equal(checked.ready, false);
    assert.match(checked.reason ?? '', /session-delivered media/);
  }
});

test('recovery rejects an image tool completion without an audit body', async (t) => {
  const ready = await fixture(true, 'tool');
  t.after(() => rm(ready.dataDir, { recursive: true, force: true }));
  const store = await ExperimentStore.open(ready.experimentRoot, experimentId);
  await store.acquireWriter();
  await store.append({
    type: 'agent.tool_completed', runId: 'run-1',
    payload: { attemptId, sessionId: 'comparison-session-1', tool: 'read_image', contentTypes: ['image'] },
  });
  await store.close();
  await assert.rejects(inspectComparisonRecovery(ready.input), /invalid audit body/);
});

test('a preview event without a session ID cannot publish a recovered report', async (t) => {
  const missing = await fixture(false);
  t.after(() => rm(missing.dataDir, { recursive: true, force: true }));
  const store = await ExperimentStore.open(missing.experimentRoot, experimentId);
  await store.acquireWriter();
  await store.append({
    type: 'agent.tool_completed', payload: {
      attemptId, tool: 'preview_report',
      details: { status: 'ok', revision: 0, draftDigest: sha256(missing.html) },
    },
  });
  await store.close();

  assert.equal((await inspectComparisonRecovery(missing.input)).ready, false);
  await assert.rejects(publishRecoveredComparison({ ...missing.input, status: 'completed' }), /session ID/);
  await assert.rejects(readFile(join(missing.experimentRoot, 'report.html'), 'utf8'), { code: 'ENOENT' });
});

test('explicit recovery publishes a validated legacy attempt without model calls', async (t) => {
  const ready = await fixture(true);
  t.after(() => rm(ready.dataDir, { recursive: true, force: true }));
  const published = await publishRecoveredComparison({ ...ready.input, status: 'completed' });
  assert.equal(await realpath(published.reportPath), await realpath(join(ready.experimentRoot, 'report.html')));
  assert.match(await readFile(published.reportPath, 'utf8'), /Candidate differs/);
  const comparison: unknown = JSON.parse(await readFile(join(ready.experimentRoot, 'comparison.json'), 'utf8'));
  assert.equal(Value.Check(ComparisonInvocationSchema, comparison), true);
  assert.equal((comparison as { sessionId: string }).sessionId, 'comparison-session-1');
  assert.equal((comparison as { status: string }).status, 'completed');
  const history = (await readLocalHistory(ready.dataDir)).experiments[0]!;
  assert.equal(history.comparisonStatus, 'completed');
  assert.equal(await realpath(history.reportPath!), await realpath(published.reportPath));
  assert.equal(history.reportAttemptUnconfirmed, undefined);
  assert.match(await readFile(join(ready.experimentRoot, 'events.jsonl'), 'utf8'), /comparison.recovered/);
  const retried = await publishRecoveredComparison({ ...ready.input, status: 'completed' });
  assert.deepEqual(retried, published);
  const events = (await ExperimentStore.open(ready.experimentRoot, experimentId)).events();
  assert.equal(events.filter((event) => event.type === 'comparison.recovery_started').length, 1);
  assert.equal(events.filter((event) => event.type === 'comparison.recovered').length, 1);
  await assert.rejects(publishRecoveredComparison({ ...ready.input, status: 'insufficient_evidence' }), /different draft or status/);
});

test('recovery finishes an interrupted publication of the same draft', async (t) => {
  const ready = await fixture(true);
  t.after(() => rm(ready.dataDir, { recursive: true, force: true }));
  const checked = await inspectComparisonRecovery(ready.input);
  assert.equal(checked.ready, true);
  const prepared = await prepareComparisonArtifacts({
    attemptRoot: checked.attemptRoot, experimentRoot: checked.experimentRoot,
    html: checked.html, media: checked.media, ...(checked.model ? { model: checked.model } : {}),
  });
  const store = await ExperimentStore.open(ready.experimentRoot, experimentId);
  await store.acquireWriter();
  await store.append({
    type: 'comparison.recovery_started', operationId: `comparison-recovery-started-${attemptId}`,
    payload: {
      attemptId, draftDigest: checked.draftDigest, publishedDigest: sha256(prepared.html),
      revision: checked.revision, status: 'completed',
    },
  });
  await store.close();
  await writeFile(join(ready.experimentRoot, 'report.html'), prepared.html);

  await publishRecoveredComparison({ ...ready.input, status: 'completed' });
  assert.match(await readFile(join(ready.experimentRoot, 'comparison.json'), 'utf8'), /"status":"completed"/);
  assert.equal((await ExperimentStore.open(ready.experimentRoot, experimentId)).events()
    .filter((event) => event.type === 'comparison.recovered').length, 1);
});
