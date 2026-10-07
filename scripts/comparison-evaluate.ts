import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { readComparisonEvaluationSuite, evaluationVariant, assessComparisonEvaluation, comparisonMainTextCharacters } from '../src/application/comparison-evaluation.js';
import { comparePersistedExperiment } from '../src/application/experiment-compare-persisted.js';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import { sha256, writeAtomic } from '../src/core/identity.js';
import { EventEnvelopeSchema } from '../src/core/schema.js';
import { ComparisonEvaluationLedgerSchema, type ComparisonEvaluationLedger } from '../src/core/comparison-evaluation-schema.js';
import { readHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { prepareComparisonEvaluationFixture, EVALUATION_POLICY } from './comparison-evaluation-fixtures.js';
import { record } from '../src/core/json.js';
import { summarizeComparisonEvaluationUsage } from '../src/application/comparison-evaluation-usage.js';
import { loadOperatorPricingOverride } from '../src/application/model-pricing.js';
import { verifyComparisonEvaluationInputs } from './comparison-evaluation-inputs.js';
import { selectComparisonEvaluationRows } from './comparison-evaluation-selection.js';

const PlanSchema = Type.Object({ schemaVersion: Type.Literal(1), suiteHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  rows: Type.Array(Type.Object({ caseId: Type.String(), repetition: Type.Integer({ minimum: 1 }),
    variant: Type.Union([Type.Literal('original'), Type.Literal('swapped'), Type.Literal('blind')]),
    dataDir: Type.String(), experimentId: Type.String(), runId: Type.String(), inputIdentityHash: Type.String({ pattern: '^[a-f0-9]{64}$' }) })) });
const [mode, pathArg, secondArg, ...flags] = process.argv.slice(2);
if (!pathArg || !isAbsolute(pathArg) || !['prepare', 'real', 'assess', 'merge'].includes(mode ?? '')) {
  throw new Error('Usage: comparison-evaluate prepare ABS_OUTDIR [--repetitions N] | real ABS_OUTDIR ABS_CONFIGDIR [--case ID] [--repetition N] [--variant original|swapped|blind] [--max-rows N] | merge ABS_OUTDIR ABS_LEDGER... | assess ABS_OUTDIR ABS_RESULT.json');
}
const root = resolve(pathArg);
const suiteBytes = await readFile(new URL('../test/fixtures/comparison-evaluation/suite.json', import.meta.url), 'utf8');
const suite = readComparisonEvaluationSuite(JSON.parse(suiteBytes) as unknown);
const suiteHash = sha256(suiteBytes);

if (mode === 'prepare') {
  const args = [secondArg, ...flags].filter((arg): arg is string => arg !== undefined);
  if (args.length && (args.length !== 2 || args[0] !== '--repetitions')) throw new Error('Unknown prepare option.');
  const repetitions = Number(args[1] ?? 3);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw new Error('Repetitions must be a positive integer.');
  await mkdir(root, { recursive: false });
  await writeFile(join(root, 'suite.json'), suiteBytes, { flag: 'wx' });
  const rows = [];
  for (const item of suite.cases) {
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const variant of ['original', 'swapped', 'blind'] as const) {
        const location = join(root, 'inputs', item.id, String(repetition), variant);
        const prepared = await prepareComparisonEvaluationFixture(location, evaluationVariant(item, variant));
        rows.push({ caseId: item.id, repetition, variant, ...prepared });
      }
    }
  }
  const plan = { schemaVersion: 1, suiteHash, rows };
  if (!Value.Check(PlanSchema, plan)) throw new Error('Generated evaluation plan is invalid.');
  await writeFile(join(root, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  console.log(`Prepared ${rows.length} isolated synthetic inputs; no model called, no Comparison reports generated.`);
} else if (mode === 'real') {
  if (process.env.REPRISE_REAL_MODEL !== '1') throw new Error('Set REPRISE_REAL_MODEL=1 to authorize real Comparison model calls.');
  if (!secondArg || !isAbsolute(secondArg)) throw new Error('Real evaluation requires absolute config data directory.');
  const plan: unknown = JSON.parse(await readFile(join(root, 'plan.json'), 'utf8'));
  if (!Value.Check(PlanSchema, plan) || plan.suiteHash !== suiteHash || sha256(await readFile(join(root, 'suite.json'))) !== suiteHash) throw new Error('Plan/suite identity mismatch.');
  const planKeys = new Set<string>();
  for (const row of plan.rows) {
    const key = `${row.caseId}/${row.repetition}/${row.variant}`;
    if (!suite.cases.some(item => item.id === row.caseId) || planKeys.has(key) ||
      resolve(row.dataDir) !== join(root, 'inputs', row.caseId, String(row.repetition), row.variant, 'data') ||
      row.experimentId !== `eval-${row.caseId}` || row.runId !== 'fixture-run') throw new Error('Invalid isolated evaluation plan row.');
    planKeys.add(key);
  }
  const selection = selectComparisonEvaluationRows(plan.rows, flags, suite.cases.map(item => item.id));
  const selected = selection.rows;
  for (const row of selected) await verifyComparisonEvaluationInputs(dirname(row.dataDir),
    evaluationVariant(suite.cases.find(item => item.id === row.caseId)!, row.variant), row.inputIdentityHash);
  const config = await readHarnessModelConfig(secondArg);
  if (!config) throw new Error('Harness model configuration unavailable.');
  const agents = createHarnessAgents(config);
  const signal = new AbortController();
  process.once('SIGINT', () => signal.abort());
  const ledger: ComparisonEvaluationLedger = { schemaVersion: 1, suiteHash, model: config.modelId, providerId: config.providerId, rows: [] };
  const ledgerPath = join(root, selection.ledgerFile);
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`, { flag: 'wx' });
  let consecutiveFailures = 0;
  for (const row of selected) {
    signal.signal.throwIfAborted();
    await verifyComparisonEvaluationInputs(dirname(row.dataDir),
      evaluationVariant(suite.cases.find(item => item.id === row.caseId)!, row.variant), row.inputIdentityHash);
    const started = Date.now();
    const result = await comparePersistedExperiment({ dataDir: row.dataDir, experimentId: row.experimentId, runId: row.runId,
      comparison: agents.comparison, agentConfig: agents.config, policy: EVALUATION_POLICY,
      now: new Date().toISOString(), signal: signal.signal });
    const eventsPath = join(result.experimentRoot, 'events.jsonl');
    const eventsBytes = await readFile(eventsPath, 'utf8');
    const events = eventsBytes.trim().split('\n').map(line => {
      const event: unknown = JSON.parse(line);
      if (!Value.Check(EventEnvelopeSchema, event)) throw new Error('Evaluation event failed schema validation.');
      return event;
    });
    let startIndex = -1;
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]?.type === 'comparison.started') { startIndex = index; break; }
    }
    const comparisonEvents = events.slice(startIndex + 1);
    const startedSession = comparisonEvents.find(event => event.type === 'agent.session_started');
    const capabilities = record(startedSession?.payload).inputCapabilities;
    if (Array.isArray(capabilities) && capabilities.every((item): item is 'text' | 'image' => item === 'text' || item === 'image')) ledger.inputCapabilities = capabilities;
    const requestCount = comparisonEvents.filter(event => event.type === 'agent.model_request').length;
    const usageSummary = summarizeComparisonEvaluationUsage(comparisonEvents, { override: loadOperatorPricingOverride(secondArg) });
    const status = result.comparison.result.status;
    if (status === 'skipped') throw new Error('Real Comparison unexpectedly skipped.');
    const report = status === 'completed' ? await readFile(result.reportPath, 'utf8') : undefined;
    ledger.rows.push({ ...row, status, eventsPath, eventsHash: sha256(eventsBytes), elapsedMs: Date.now() - started,
      modelRequests: requestCount,
      toolCalls: new Set(comparisonEvents.filter(event => event.type === 'agent.tool_called')
        .map(event => record(event.payload).toolCallId).filter(id => typeof id === 'string')).size,
      compactions: comparisonEvents.filter(event => event.type === 'agent.context_compacted').length,
      retries: comparisonEvents.filter(event => event.type === 'agent.request_retried').length,
      previews: new Set(comparisonEvents.filter(event => event.type === 'agent.tool_called' && record(event.payload).tool === 'preview_report')
        .map(event => record(event.payload).toolCallId).filter(id => typeof id === 'string')).size,
      ...usageSummary,
      ...(report === undefined ? {} : { reportPath: result.reportPath, reportHash: sha256(report), mainTextCharacters: comparisonMainTextCharacters(report) }),
    });
    if (!Value.Check(ComparisonEvaluationLedgerSchema, ledger)) throw new Error('Evaluation ledger failed schema validation.');
    await writeAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`${row.caseId} ${row.repetition} ${row.variant}: ${status}. Semantic review pending.`);
    consecutiveFailures = status === 'completed' ? 0 : consecutiveFailures + 1;
    if (consecutiveFailures >= 3) throw new Error('Three consecutive failed/cancelled Comparisons; evaluation stopped. Inspect persisted attempts before expanding.');
  }
} else if (mode === 'merge') {
  const paths = [secondArg, ...flags].filter((path): path is string => path !== undefined);
  if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Error('Merge requires absolute ledger paths.');
  const ledgers = await Promise.all(paths.map(async path => {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!Value.Check(ComparisonEvaluationLedgerSchema, value) || value.suiteHash !== suiteHash) throw new Error('Merged ledger suite identity mismatch.');
    return value;
  }));
  const first = ledgers[0]!;
  if (ledgers.some(ledger => ledger.model !== first.model || ledger.providerId !== first.providerId ||
    JSON.stringify(ledger.inputCapabilities) !== JSON.stringify(first.inputCapabilities))) throw new Error('Cannot merge different model/provider/capability lanes.');
  const merged = { ...first, rows: ledgers.flatMap(ledger => ledger.rows) };
  assessComparisonEvaluation(merged, suite);
  await writeFile(join(root, 'ledger.json'), `${JSON.stringify(merged, null, 2)}\n`, { flag: 'wx' });
  await writeFile(join(root, 'merged-from.json'), `${JSON.stringify({ schemaVersion: 1, paths }, null, 2)}\n`, { flag: 'wx' });
  console.log(`Merged ${paths.length} saved ledgers (${merged.rows.length} generated observations).`);
} else {
  if (!secondArg || !isAbsolute(secondArg)) throw new Error('Assessment requires absolute output JSON path.');
  const ledger: unknown = JSON.parse(await readFile(join(root, 'ledger.json'), 'utf8'));
  if (!Value.Check(ComparisonEvaluationLedgerSchema, ledger) || ledger.suiteHash !== suiteHash) throw new Error('Assessment suite identity mismatch.');
  for (const row of ledger.rows) {
    if (row.inputIdentityHash) {
      const fixtureRoot = join(root, 'inputs', row.caseId, String(row.repetition), row.variant);
      const item = suite.cases.find(item => item.id === row.caseId);
      if (!item) throw new Error('Unknown assessment case.');
      await verifyComparisonEvaluationInputs(fixtureRoot, evaluationVariant(item, row.variant), row.inputIdentityHash);
    }
    if (row.reportPath && sha256(await readFile(row.reportPath)) !== row.reportHash) throw new Error('Generated report changed since ledger capture.');
    if (row.eventsHash && sha256(await readFile(row.eventsPath)) !== row.eventsHash) throw new Error('Evaluation events changed since ledger capture.');
  }
  const metrics = assessComparisonEvaluation(ledger, suite);
  await writeFile(resolve(secondArg), `${JSON.stringify(metrics, null, 2)}\n`, { flag: 'wx' });
  console.log(`Assessed ${metrics.generated} generated reports; ${metrics.reviewed} manual reviews recorded.`);
}
