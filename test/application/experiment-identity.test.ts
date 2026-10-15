import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExperiment } from '../../src/application/experiment.js';
import { createExperimentWorkflow } from '../../src/application/experiment-workflow.js';
import { readLocalHistory } from '../../src/application/experiment-history-list.js';
import { readCommittedRunEvents } from '../../src/application/experiment-run-history.js';
import { readExperimentMetadata, fixedExperimentSpec } from '../../src/application/experiment-metadata.js';
import { readRunPreflight } from '../../src/application/experiment-layout.js';
import { comparePersistedExperiment } from '../../src/application/experiment-compare-persisted.js';
import { createProductLookup } from '../../src/products/index.js';
import { codexProductPack } from '../../src/products/packs/codex/pack.js';
import { ExperimentStartup } from '../../src/application/experiment-startup.js';
import { ExperimentStore } from '../../src/infrastructure/store/experiment-store.js';
import { readTaskCase, snapshotTaskCase, taskCaseOrigin } from '../../src/products/shared/task-case-reader.js';
import { persistTaskCase } from '../../src/application/experiment-helpers.js';
import { sealTaskCase } from '../../src/core/task-case-identity.js';
import { sha256 } from '../../src/core/identity.js';
import { publishFrozenCase } from '../../src/products/shared/freeze.js';
import { renderHistoryDetail } from '../../src/tui/pages/history.js';
import { createTheme } from '../../src/tui/theme.js';
import { inspectRun } from '../../src/application/controller-queries.js';
import { isRecord } from '../../src/core/json.js';
import { OBSERVATIONS_MOUNT, observationRelativePath } from '../../src/products/history/observations-materializer.js';
import { input, VerifiedRuntime } from '../codex-experiment-support.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'reprise-fixed-experiment-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const base = { ...input(root, new VerifiedRuntime()), compare: false };
  await mkdir(base.sourceRoot, { recursive: true });
  return { root, base, experimentRoot: join(base.dataDir, 'experiments', base.experimentId) };
}

test('fixed identity rejects same legacy ID/hash with changed task before agents or new run facts and releases writer', async t => {
  const { base, experimentRoot } = await fixture(t);
  await startExperiment(base).result;
  let agents = 0;
  const workflow = createExperimentWorkflow({ dataDir: base.dataDir, runtime: base.runtime, now: () => base.now,
    lookup: createProductLookup([codexProductPack]), agents: async () => { agents++; throw new Error('must not initialize'); } });
  const taskCase = { ...base.taskCase, initialInput: { ...base.taskCase.initialInput, text: 'different initial task' } };
  await assert.rejects(workflow.start({ taskCase, sourceRoot: base.sourceRoot, candidate: base.candidate,
    experimentId: base.experimentId, runId: 'rejected-run', onEvent: () => {} }), /fixed TaskCase identity/);
  assert.equal(agents, 0);
  assert.equal((await readCommittedRunEvents(experimentRoot)).events.some(event => event.runId === 'rejected-run'), false);
  await assert.rejects(stat(join(experimentRoot, 'runs', 'rejected-run')), { code: 'ENOENT' });
  await assert.rejects(stat(join(experimentRoot, 'writer.lock')), { code: 'ENOENT' });
  const retried = await startExperiment({ ...base, runId: 'accepted-run', taskCase: { ...base.taskCase,
    provenance: { ...base.taskCase.provenance, importedAt: '2026-10-15T00:00:00.000Z' } } }).result;
  assert.equal(retried.record.attempt.runId, 'accepted-run');
});

test('legacy fixed metadata also rejects changed content before admission without upgrading its certification', async t => {
  const { base, experimentRoot } = await fixture(t);
  await startExperiment(base).result;
  const legacy = { spec: { experimentId: base.experimentId, taskCaseId: base.caseId, candidates: [base.candidate],
    controller: base.agentConfig, comparison: base.agentConfig, runPolicy: base.policy, outputRoot: experimentRoot } };
  const path = join(experimentRoot, 'experiment.json');
  const bytes = JSON.stringify(legacy);
  await writeFile(path, bytes);
  const taskCase = { ...base.taskCase, initialInput: { ...base.taskCase.initialInput, text: 'different task with same hash' } };
  await assert.rejects(startExperiment({ ...base, taskCase, runId: 'legacy-rejected' }).result, /immutable content/);
  assert.equal((await readCommittedRunEvents(experimentRoot)).events.some(event => event.runId === 'legacy-rejected'), false);
  assert.equal(await readFile(path, 'utf8'), bytes);
  const next = await startExperiment({ ...base, runId: 'legacy-accepted', taskCase: { ...base.taskCase,
    provenance: { ...base.taskCase.provenance, importedAt: '2026-10-15T00:00:00.000Z' } } }).result;
  assert.equal(next.record.attempt.runId, 'legacy-accepted');
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('new fixed metadata contains only scene identity while each run may choose another candidate and policy', async t => {
  const { base, experimentRoot } = await fixture(t);
  const first = await startExperiment(base).result;
  const second = await startExperiment({ ...base, runId: 'run-next', candidate: { ...base.candidate, requestedModel: 'different-model' },
    policy: { ...base.policy, maxTargetTurns: 4 } }).result;
  const metadata = await readExperimentMetadata(join(experimentRoot, 'experiment.json'), base.experimentId);
  assert.equal(metadata.kind, 'current');
  if (metadata.kind !== 'current') throw new Error('Expected current metadata.');
  assert.deepEqual(Object.keys(metadata.value.spec).sort(), ['experimentId', 'schemaVersion', 'taskCaseId', 'taskCaseIdentity']);
  assert.equal(first.record.attempt.candidate.requestedModel, base.candidate.requestedModel);
  assert.equal(second.record.attempt.candidate.requestedModel, 'different-model');
  assert.equal(second.record.attempt.policy.maxTargetTurns, 4);
  const history = (await readLocalHistory(base.dataDir)).experiments[0]!;
  assert.equal(history.taskIdentity, 'legacy-unverified');
  assert.match(renderHistoryDetail(createTheme(120, false), 120, history, 'zh').join('\n'), /旧格式；历史身份未认证/);
});

test('admission snapshots TaskCase before asynchronous initialization and retains verified frozen-byte origins', async t => {
  const { root, base } = await fixture(t);
  const text = base.taskCase.initialInput.text;
  const handle = startExperiment(base);
  base.taskCase.initialInput.text = 'caller mutation after start';
  const result = await handle.result;
  assert.equal(result.taskCase.initialInput.text, text);
  assert.ok(Object.isFrozen(result.taskCase.initialInput));
  const body = Buffer.from('bound source bytes');
  const frozen = sealTaskCase({ ...result.taskCase, initialInput: { ...result.taskCase.initialInput, role: 'user' },
    transcript: [{ ...result.taskCase.initialInput, role: 'user' }] }, [{ relativePath: 'evidence.txt', byteLength: body.length, contentHash: sha256(body) }]);
  const external = join(root, 'external-cases');
  await publishFrozenCase({ casesRoot: external, taskCase: frozen, files: [{ relativePath: 'evidence.txt', content: body }] });
  const read = await readTaskCase(join(external, frozen.caseId, 'case.json'));
  const snapshot = snapshotTaskCase(read);
  assert.equal(taskCaseOrigin(snapshot), taskCaseOrigin(read));
  await persistTaskCase(join(root, 'copied-cases', frozen.caseId, 'case.json'), snapshot);
  assert.deepEqual(await readFile(join(root, 'copied-cases', frozen.caseId, 'evidence.txt')), body);
});

test('v2 identity binds the full hash and rejects mutated in-memory content before any attempt', async t => {
  const { base, experimentRoot } = await fixture(t);
  const frozen = sealTaskCase({ ...base.taskCase, initialInput: { ...base.taskCase.initialInput, role: 'user' },
    transcript: [{ ...base.taskCase.initialInput, role: 'user' }] }, []);
  const admitted = await ExperimentStartup.admit({ ...base, caseId: frozen.caseId, taskCase: frozen });
  await admitted.close([]);
  const spec = fixedExperimentSpec(base.experimentId, frozen);
  assert.deepEqual(spec.taskCaseIdentity, { kind: 'frozen-v2', contentHash: frozen.contentHash });
  await assert.rejects(ExperimentStartup.admit({ ...base, caseId: frozen.caseId, runId: 'v2-rejected',
    taskCase: { ...frozen, initialInput: { ...frozen.initialInput, text: 'changed' } } }), /identity mismatch|not a recorded user/);
  assert.equal((await readCommittedRunEvents(experimentRoot)).events.some(event => event.runId === 'v2-rejected'), false);
});

test('metadata dispatcher isolates malformed and unsupported experiments from the History list', async t => {
  const { base, experimentRoot } = await fixture(t);
  await startExperiment(base).result;
  const parent = join(base.dataDir, 'experiments');
  for (const [name, content] of [['bad-json', '{'], ['future', JSON.stringify({ spec: { schemaVersion: 99 } })]] as const) {
    await mkdir(join(parent, name));
    await writeFile(join(parent, name, 'experiment.json'), content);
  }
  assert.equal((await readExperimentMetadata(join(parent, 'bad-json', 'experiment.json'), 'bad-json')).kind, 'corrupt');
  assert.equal((await readExperimentMetadata(join(parent, 'future', 'experiment.json'), 'future')).kind, 'unsupported');
  assert.equal((await readExperimentMetadata(join(parent, 'missing', 'experiment.json'), 'missing')).kind, 'missing');
  for (const version of [null, '2', 0, -1, 1.5]) {
    await writeFile(join(parent, 'future', 'experiment.json'), JSON.stringify({ spec: { schemaVersion: version } }));
    assert.equal((await readExperimentMetadata(join(parent, 'future', 'experiment.json'), 'future')).kind, 'corrupt');
  }
  await writeFile(join(parent, 'future', 'experiment.json'), JSON.stringify({ spec: { schemaVersion: 99 } }));
  const history = await readLocalHistory(base.dataDir);
  assert.equal(history.experiments.length, 3);
  assert.equal(history.experiments.find(item => item.experimentId === 'future')?.formatError, 'unsupported_experiment_schema');
  assert.equal(history.experiments.find(item => item.path === experimentRoot)?.runId, base.runId);
});

test('persisted comparison measures its own operation instead of charging time since the historical run', async t => {
  const { base } = await fixture(t);
  const original = await startExperiment(base).result;
  let clock = Date.parse('2030-01-01T00:00:00.000Z');
  t.mock.method(Date, 'now', () => clock);
  const compared = await comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId,
    policy: base.policy, now: base.now, agentConfig: base.agentConfig,
    comparison: { ...base.comparison, compare: async (...args) => { clock += 2500; return base.comparison.compare(...args); } } });
  assert.equal(compared.facts.elapsedMs, 2500);
  assert.deepEqual(compared.record, original.record);
});

test('preflight projects known Runtime fields without persisting structural extensions or credential-like values', async t => {
  const { base, experimentRoot } = await fixture(t);
  const runtime = new VerifiedRuntime();
  const resolved = await runtime.resolve(base.candidate);
  t.mock.method(runtime, 'validateCandidate', async () => ({ ...resolved, candidateId: 'extension-candidate',
    apiKey: 'fixture-not-a-real-key', headers: { Authorization: 'fixture-not-a-real-header' } }));
  const result = await startExperiment({ ...base, runtime }).result;
  assert.deepEqual(result.preflight.resolved, resolved);
  const bytes = await readFile(join(experimentRoot, 'runs', base.runId, 'preflight.json'), 'utf8');
  assert.doesNotMatch(bytes, /candidateId|apiKey|Authorization|fixture-not-a-real/);
});

test('a current fixed binding detects a replaced legacy case instead of certifying its new title', async t => {
  const { base, experimentRoot } = await fixture(t);
  await startExperiment(base).result;
  const changed = { ...base.taskCase, initialInput: { ...base.taskCase.initialInput, text: 'replaced legacy bytes' } };
  await writeFile(join(base.dataDir, 'cases', base.caseId, 'case.json'), JSON.stringify(changed));
  const item = (await readLocalHistory(base.dataDir)).experiments.find(entry => entry.path === experimentRoot)!;
  assert.equal(item.formatError, 'fixed_task_identity_mismatch');
  assert.equal(item.taskTitle, undefined);
  assert.equal(item.runId, base.runId);
  await assert.rejects(comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId,
    policy: base.policy, now: base.now, comparison: base.comparison, agentConfig: base.agentConfig }), /fixed TaskCase identity/);
});

test('preflight dispatcher checks full content, version and owner without falling back from corrupt nested data', async t => {
  const { base, experimentRoot } = await fixture(t);
  const result = await startExperiment(base).result;
  const path = join(experimentRoot, 'runs', base.runId, 'preflight.json');
  const valid = await readFile(path, 'utf8');
  await writeFile(join(experimentRoot, 'preflight.json'), JSON.stringify(result.preflight));
  assert.equal((await readRunPreflight(experimentRoot, base.runId)).kind, 'current');
  for (const [value, kind] of [
    ['{', 'corrupt'],
    [JSON.stringify({ sourceBaseline: 'available', resolved: {} }), 'corrupt'],
    [JSON.stringify({ schemaVersion: 99 }), 'unsupported'],
    [JSON.stringify({ schemaVersion: '1' }), 'corrupt'],
    [JSON.stringify({ schemaVersion: null }), 'corrupt'],
    [JSON.stringify({ schemaVersion: 0 }), 'corrupt'],
    [JSON.stringify({ schemaVersion: 1, experimentId: 'foreign', runId: base.runId, preflight: result.preflight }), 'corrupt'],
  ] as const) {
    await writeFile(path, value);
    assert.equal((await readRunPreflight(experimentRoot, base.runId)).kind, kind);
    let initialized = 0;
    await assert.rejects(comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId, policy: base.policy, now: base.now,
      resolveAgents: async () => { initialized++; throw new Error('must not initialize'); } }), /Cannot load run preflight/);
    assert.equal(initialized, 0);
  }
  await rm(path);
  assert.equal((await readRunPreflight(experimentRoot, base.runId)).kind, 'legacy');
  await rm(join(experimentRoot, 'preflight.json'));
  assert.equal((await readRunPreflight(experimentRoot, base.runId)).kind, 'missing');
  const store = await ExperimentStore.open(experimentRoot, base.experimentId);
  await store.acquireWriter();
  let lateRef: string;
  let originalTurns: number;
  try {
    const originalInspection = await inspectRun(store, result.record, base.candidate.productId);
    originalTurns = originalInspection.turns;
    const prior = store.events(base.runId).find(event => event.type === 'runtime.visible_output')!;
    assert.ok(prior);
    assert.ok(isRecord(prior.payload));
    const late = await store.append({ type: prior.type, runId: base.runId,
      payload: { ...prior.payload, item: { type: 'agentMessage', text: 'Post-trace text must not replace the completed run answer.' } } });
    assert.ok(late.sequence > result.record.trace.lastSequence);
    lateRef = `event:${late.eventId}`;
    const settlement = store.events(base.runId).find(event => event.type === 'runtime.turn_settled')!;
    assert.ok(settlement && isRecord(settlement.payload));
    await store.append({ type: settlement.type, runId: base.runId, payload: { ...settlement.payload, turnId: 'post-trace-turn' } });
    const bounded = await inspectRun(store, result.record, base.candidate.productId);
    assert.equal(bounded.finalMessage, originalInspection.finalMessage);
    assert.equal(bounded.turns, originalInspection.turns);
    assert.equal(bounded.tokenCount, originalInspection.tokenCount);
  } finally { await store.close(); }
  let comparisonAttemptId: string | undefined;
  const compare = base.comparison.compare.bind(base.comparison);
  t.mock.method(base.comparison, 'compare', async (...args: Parameters<typeof base.comparison.compare>) => {
    comparisonAttemptId = args[0].attemptId;
    assert.equal(args[0].ownedEvidenceRefs?.includes(lateRef), false);
    assert.ok(args[0].ownedEvidenceRefs?.includes(result.targetEvents[0]!));
    return compare(...args);
  });
  const unknown = await comparePersistedExperiment({ dataDir: base.dataDir, experimentId: base.experimentId,
    policy: base.policy, now: base.now, comparison: base.comparison, agentConfig: base.agentConfig });
  assert.equal(unknown.preflight.sourceBaseline, 'unknown');
  assert.ok(unknown.preflight.limitations.some(limitation => limitation.includes('no recorded preflight')));
  assert.deepEqual(unknown.record, result.record);
  assert.deepEqual(unknown.decision, { status: 'not_reconstructed' });
  assert.equal(unknown.followupSubmission, undefined);
  assert.equal(unknown.facts.turns, originalTurns);
  assert.ok(result.targetEvents.length > 0);
  assert.ok(result.targetEvents.every(ref => unknown.targetEvents.includes(ref)));
  assert.equal(unknown.targetEvents.includes(lateRef), false);
  assert.ok(comparisonAttemptId);
  assert.equal(unknown.comparison.result.status, 'completed');
  const attemptRoot = join(experimentRoot, 'comparison-attempts', comparisonAttemptId);
  for (const path of ['briefing/candidate/process-index.tsv', 'briefing/decision-map.md', `${OBSERVATIONS_MOUNT}/INDEX.tsv`]) {
    assert.doesNotMatch(await readFile(join(attemptRoot, path), 'utf8'), new RegExp(lateRef));
  }
  await assert.rejects(stat(join(attemptRoot, OBSERVATIONS_MOUNT, observationRelativePath(lateRef, 'run_events'))), { code: 'ENOENT' });
  assert.ok((await stat(join(attemptRoot, OBSERVATIONS_MOUNT, observationRelativePath(result.targetEvents[0]!, 'run_events')))).isFile());
  const committedEvents = (await readCommittedRunEvents(experimentRoot)).events;
  for (const ref of unknown.targetEvents) {
    const event = committedEvents.find(entry => `event:${entry.eventId}` === ref);
    assert.ok(event);
    assert.equal(event.runId, base.runId);
    assert.ok(event.type.startsWith('runtime.'));
    assert.ok(event.sequence >= result.record.trace.firstSequence && event.sequence <= result.record.trace.lastSequence);
  }
  await writeFile(path, valid);
});
