import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { assertComparisonResult, type ComparisonFactsContext, type ComparisonCompareOptions } from '../../src/agents/comparison-contract.js';

const context: ComparisonFactsContext = {
  task: { caseId: 'case', summary: 'Task' }, baseline: { summary: 'Baseline', evidenceRefs: [] }, candidates: [], telemetry: [],
  artifactRefs: [], allowModelText: true, replayScope: { historical: 'historical', candidate: 'candidate' }, shortEvidenceRefs: ['ev-01'],
  reportFacts: { run: { runId: 'run', outcome: 'completed', terminationCode: 'completed', initiatedBy: 'user' },
    models: { candidate: 'model' }, activity: {}, limits: { triggered: [] }, runtime: { productId: 'codex' },
    delivery: { changedPaths: [], targetArtifactStatus: 'unknown', verificationStatus: 'unknown' },
    replay: { conditions: [], baselineEvidence: 'available', candidateEvidence: 'available' } },
};

test('neutral result validation checks the original schema and current catalog', () => {
  const incomplete = { status: 'completed', evidenceRefs: ['ev-01'] };
  assert.throws(() => assertComparisonResult(incomplete, context), /schema validation failed/);
  assert.equal('reportPath' in incomplete, false, 'A type assertion cannot claim a temporary normalized copy populated the caller object');
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-01'] }, context));
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'other.html', evidenceRefs: [] }, context), /schema validation failed/);
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-99'] }, context), /unknown evidence refs/);
  const current: NonNullable<ComparisonCompareOptions['getEvidenceCatalog']> = () => ({ links: [{ shortRef: 'ev-02', side: 'baseline', inspectPath: 'history/02.txt' }], media: [] });
  assert.doesNotThrow(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-02'] }, context, current));
  assert.throws(() => assertComparisonResult({ status: 'completed', reportPath: 'report.html', evidenceRefs: ['ev-01'] }, context, current), /unknown evidence refs/);
});

test('default harness and application entrypoints load without the legacy executor even when its import is blocked', { timeout: 20_000 }, async () => {
  const legacy = new URL('../../src/agents/comparison-agent.js', import.meta.url).href;
  const entries = ['harness-agents', 'experiment-workflow', 'comparison', 'experiment-report']
    .map((name) => new URL(`../../src/application/${name}.js`, import.meta.url).href);
  const script = `
    import { registerHooks } from 'node:module';
    import { relative, sep } from 'node:path';
    import { fileURLToPath } from 'node:url';
    registerHooks({ resolve(specifier, context, next) {
      const target = specifier.startsWith('.') && context.parentURL ? new URL(specifier, context.parentURL).href : specifier;
      if (target === process.argv[1]) throw new Error('Legacy Comparison executor entered the production graph');
      const resolved = next(specifier, context);
      if (resolved.url === process.argv[1]) throw new Error('Legacy Comparison executor entered the production graph');
      return resolved;
    } });
    for (const entry of JSON.parse(process.argv[2])) await import(entry);
    const relativeLegacy = './' + relative(process.cwd(), fileURLToPath(process.argv[1])).split(sep).join('/');
    for (const specifier of [process.argv[1], relativeLegacy]) {
      let rejected = false;
      try { await import(specifier); } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Legacy Comparison executor entered')) throw error;
        rejected = true;
      }
      if (!rejected) throw new Error('The import blocker did not reject the legacy executor: ' + specifier);
    }
    process.stdout.write('production entrypoints loaded; legacy executor rejected');
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, legacy, JSON.stringify(entries)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'production entrypoints loaded; legacy executor rejected');
});
