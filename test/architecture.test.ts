import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SRC = join(process.cwd(), 'src');
const IMPORT = /from\s+['"](\.[^'"]+)['"]/g;

test('core does not import products', async () => {
  const files = await tsFiles(join(SRC, 'core'));
  for (const file of files) {
    const imports = await relativeImports(file);
    assert.equal(imports.some((item) => item.includes(`${sep}products${sep}`) || item.includes('/products/')), false, `${relative(SRC, file)} imports products`);
  }
});

test('only the product registry may import a concrete pack', async () => {
  const files = await tsFiles(SRC);
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join('/');
    if (rel === 'products/index.ts') continue;
    if (rel.startsWith('products/codex/')) continue;
    if (rel.startsWith('products/claude-code/')) continue;
    if (rel.startsWith('products/shared/')) continue;
    if (rel === 'products/contract.ts') continue;
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*products\/(?:codex|claude-code)\//.test(source)) {
      violations.push(rel);
    }
  }
  assert.deepEqual(violations, []);
});

test('recovery stack does not import product JSONL parsers', async () => {
  const files = [
    ...(await tsFiles(join(SRC, 'agents'))).filter((file) => file.includes('recovery')),
    ...(await tsFiles(join(SRC, 'infrastructure'))).filter((file) => /recovery/.test(file)),
    ...(await tsFiles(join(SRC, 'application'))).filter((file) => /experiment-recovery|recovery-/.test(file)),
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(?:jsonl-io|products\/(?:codex|claude-code)\/sessions)['"]/.test(source)) {
      violations.push(relative(SRC, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(violations, []);
});

test('packs do not import each other', async () => {
  const packs = ['codex', 'claude-code'];
  for (const pack of packs) {
    const root = join(SRC, 'products', pack);
    try { await stat(root); } catch { continue; }
    for (const file of await tsFiles(root)) {
      const source = await readFile(file, 'utf8');
      for (const other of packs) {
        if (other === pack) continue;
        assert.equal(source.includes(`products/${other}/`), false, `${relative(SRC, file)} imports ${other}`);
      }
    }
  }
});

async function tsFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  }));
  return files.flat();
}

async function relativeImports(file: string): Promise<string[]> {
  const source = await readFile(file, 'utf8');
  return [...source.matchAll(IMPORT)].map((match) => match[1] ?? '');
}

test('internal agents share workspace tools without read_observation', async () => {
  const { recoveryTools } = await import('../src/infrastructure/recovery-tools.js');
  const seven = ['edit', 'find', 'grep', 'ls', 'read', 'shell_exec', 'write'];
  const recovery = recoveryTools('TMP').map((tool) => tool.name).sort();
  const controller = recoveryTools('TMP', { allowWrite: () => false, mounts: { project: 'REPLICA' } })
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(recovery, seven);
  assert.deepEqual(controller, seven);
  assert.equal(controller.includes('read_observation'), false);
  const registered = await readFile(join(SRC, 'infrastructure/recovery-workspace-tools.ts'), 'utf8');
  assert.doesNotMatch(registered, /name:\s*["']read_observation["']/);
  const experiment = await readFile(join(SRC, 'application/experiment-report.ts'), 'utf8');
  assert.match(experiment, /comparison\.requested/);
  assert.doesNotMatch(experiment, /write_comparison_report|read_artifact|observationTools|read_observation/);
  const loop = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.match(loop, /experimentAgentAuditSink/);
  assert.match(loop, /controllerBriefingRoot/);
  assert.match(loop, /assertBriefingOutsideReplica/);
  assert.doesNotMatch(loop, /observationTools/);
  assert.doesNotMatch(loop, /recoveryTools\(\s*input\.environment\.root/);
  const caller = await readFile(join(SRC, 'infrastructure/pi-model-caller.ts'), 'utf8');
  assert.match(caller, /transformContext/);
  assert.match(caller, /compactPiMessages/);
  assert.match(caller, /working set still exceeds/);
  const runModel = await readFile(join(SRC, 'application/experiment-recovery-run-model.ts'), 'utf8');
  assert.doesNotMatch(runModel, /recoveryObservationTools/);
});

test('role write policy stays on application owners without a shared Verifier', async () => {
  const { comparisonAttemptWriteAllowed } = await import('../src/application/experiment-report.js');
  assert.equal(comparisonAttemptWriteAllowed('scratch/a.txt'), true);
  assert.equal(comparisonAttemptWriteAllowed('scratch-evil/a.txt'), false);
  assert.equal(comparisonAttemptWriteAllowed('report.html'), true);
  const report = await readFile(join(SRC, 'application/experiment-report.ts'), 'utf8');
  assert.doesNotMatch(report, /\.plan\(|\.report\(|invokePlan|invokeReport/);
  const comparisonAgent = await readFile(join(SRC, 'agents/comparison-agent.ts'), 'utf8');
  assert.doesNotMatch(comparisonAgent, /#host\.request/);
  assert.match(comparisonAgent, /createSession/);
  const experiment = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.match(experiment, /allowWrite:\s*\(\)\s*=>\s*false/);
  assert.doesNotMatch(experiment, /interface\s+\w*Verifier/);
  const tools = await readFile(join(SRC, 'infrastructure/recovery-workspace-tools.ts'), 'utf8');
  assert.match(tools, /pathContainedBy/);
  assert.match(tools, /assertStillInside/);
  const inspection = await readFile(join(SRC, 'application/experiment-inspection.ts'), 'utf8');
  assert.match(inspection, /pathContainedBy/);
  assert.doesNotMatch(inspection, /fullPath\.startsWith/);
});

test('history read does not import products, Host, or model callers', async () => {
  const source = await readFile(join(SRC, 'infrastructure/agent-history-read.ts'), 'utf8');
  assert.doesNotMatch(source, /products\/|pi-agent-host|pi-model-caller|LocalWorkspaceProvider/);
  const appHistory = await readFile(join(SRC, 'application/experiment-history-read.ts'), 'utf8');
  assert.doesNotMatch(appHistory, /products\/|pi-agent-host|pi-model-caller|LocalWorkspaceProvider/);
});

test('TUI timeline projection does not load product packs', async () => {
  const timeline = await readFile(join(SRC, 'tui/timeline.ts'), 'utf8');
  assert.doesNotMatch(timeline, /products\/index|productPacks/);
  const experiment = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.match(experiment, /persistPublicActivities/);
  const run = await readFile(join(SRC, 'tui/controller-run.ts'), 'utf8');
  const beginRun = run.slice(run.indexOf('export async function beginRun'));
  assert.doesNotMatch(beginRun, /c\.timeline = \[\]/);
});

test('TUI and CLI recovery paths do not opt in to current-state fallback', async () => {
  const workflow = await readFile(join(SRC, 'application/experiment-workflow.ts'), 'utf8');
  assert.doesNotMatch(workflow, /allowCurrentStateFallback/);
  const cli = await readFile(join(SRC, 'cli/main.ts'), 'utf8');
  assert.doesNotMatch(cli, /allowCurrentStateFallback/);
  assert.doesNotMatch(cli, /acceptRecovery/);
  assert.doesNotMatch(cli, /from ['"]\.\.\/tui\//);
  assert.match(cli, /await import\("\.\.\/tui\/intake-app\.js"\)/);
  assert.match(cli, /products\|models\|projects\|sessions\|inspect\|import\|history\|events\|auth/);
  const operations = await readFile(join(SRC, 'application/experiment-operations.ts'), 'utf8');
  assert.match(operations, /runFullExperiment/);
  assert.match(operations, /prepareExperiment/);
  assert.match(operations, /runPreparedExperiment/);
  const compare = await readFile(join(SRC, 'application/experiment-compare-persisted.ts'), 'utf8');
  assert.doesNotMatch(compare, /findProductPack/);
  assert.doesNotMatch(workflow, /findProductPack/);
  assert.match(cli, /source-product/);
});

test('third pack proof does not inject host packs or workflow pack objects', async () => {
  const source = await readFile(join(process.cwd(), 'test', 'third-pack-config.test.ts'), 'utf8');
  assert.doesNotMatch(source, /new CodexIntakeTui\([\s\S]*?packs\s*:/);
  assert.doesNotMatch(source, /createExperimentWorkflow|createHarnessWorkflow|createCodexExperimentWorkflow|createCodexTuiWorkflow/);
  assert.doesNotMatch(source, /from ['"]\.\.\/src\/infrastructure\/store/);
});

test('unnamed sessionsRoot and harness stop codes do not use product-name or ledger-guard leftovers', async () => {
  const intakeState = await readFile(join(SRC, 'tui/intake-tui-state.ts'), 'utf8');
  assert.doesNotMatch(intakeState, /productId === ['"]codex['"]/);
  const candidateRun = await readFile(join(SRC, 'application/candidate-run.ts'), 'utf8');
  assert.doesNotMatch(candidateRun, /controller_completion_guard/);
  const workflow = await readFile(join(SRC, 'application/experiment-workflow.ts'), 'utf8');
  const tuiWorkflow = await readFile(join(SRC, 'application/tui-workflow.ts'), 'utf8');
  assert.doesNotMatch(workflow, /createCodexExperimentWorkflow|createCodexTuiWorkflow|CodexTuiWorkflow/);
  assert.doesNotMatch(tuiWorkflow, /createCodexExperimentWorkflow|createCodexTuiWorkflow|CodexTuiWorkflow/);
});

test('real-terminal TUI probe is opt-in and outside engineering gates', async () => {
  const script = await readFile(join(process.cwd(), 'scripts/tui-real-terminal-probe.ts'), 'utf8');
  assert.match(script, /REPRISE_REAL_TERMINAL/);
  assert.match(script, /isTTY/);
  const gates = await readFile(join(process.cwd(), 'scripts/run-gates.mjs'), 'utf8');
  assert.doesNotMatch(gates, /probe:tui-terminal|tui-real-terminal-probe|REPRISE_REAL_TERMINAL/);
  const { spawnSync } = await import('node:child_process');
  const denied = spawnSync(process.execPath, [join(process.cwd(), 'dist/scripts/tui-real-terminal-probe.js')], {
    encoding: 'utf8',
    env: { ...process.env, REPRISE_REAL_TERMINAL: '' },
  });
  assert.notEqual(denied.status, 0);
  assert.match(`${denied.stderr}${denied.stdout}`, /REPRISE_REAL_TERMINAL/);
  const noTty = spawnSync(process.execPath, [join(process.cwd(), 'dist/scripts/tui-real-terminal-probe.js'), join(process.cwd(), 'probe-out.json')], {
    encoding: 'utf8',
    env: { ...process.env, REPRISE_REAL_TERMINAL: '1' },
  });
  assert.notEqual(noTty.status, 0);
  assert.match(`${noTty.stderr}${noTty.stdout}`, /real TTY/);
  const caller = await readFile(join(SRC, 'infrastructure/pi-model-caller.ts'), 'utf8');
  assert.match(caller, /await notify\(/);
});

test('opt-in agent context probe stays outside engineering gates', async () => {
  const script = await readFile(join(process.cwd(), 'scripts/agent-context-probe.ts'), 'utf8');
  assert.match(script, /REPRISE_AGENT_CONTEXT_PROBE/);
  const gates = await readFile(join(process.cwd(), 'scripts/run-gates.mjs'), 'utf8');
  assert.doesNotMatch(gates, /agent-context-probe|REPRISE_AGENT_CONTEXT_PROBE/);
});

test('CI test matrix covers three operating systems', async () => {
  const workflow = await readFile(join(process.cwd(), '.github', 'workflows', 'check.yml'), 'utf8');
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /ubuntu-latest/);
});





