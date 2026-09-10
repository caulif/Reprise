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
    if (rel.startsWith('products/packs/codex/')) continue;
    if (rel.startsWith('products/packs/claude-code/')) continue;
    if (rel.startsWith('products/shared/')) continue;
    if (rel === 'products/contract.ts') continue;
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*products\/packs\/(?:codex|claude-code)\//.test(source)) {
      violations.push(rel);
    }
  }
  assert.deepEqual(violations, []);
});

test('recovery stack does not import product JSONL parsers', async () => {
  const files = [
    ...(await tsFiles(join(SRC, 'agents'))).filter((file) => file.includes('recovery')),
    ...(await tsFiles(join(SRC, 'infrastructure'))).filter((file) => /recovery/.test(file)),
    ...(await tsFiles(join(SRC, 'application', 'recovery'))),
    ...(await tsFiles(join(SRC, 'application'))).filter((file) => /recovery/.test(file)),
  ];
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(?:jsonl-io|products\/packs\/(?:codex|claude-code)\/sessions)['"]/.test(source)) {
      violations.push(relative(SRC, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(violations, []);
});

test('shared pack host helpers do not import protocol or projection', async () => {
  for (const file of await tsFiles(join(SRC, 'products', 'shared'))) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /packs\/(?:codex|claude-code)\/(?:protocol|projection)/, `${relative(SRC, file)} imports protocol or projection`);
  }
});

test('packs do not import each other', async () => {
  const packs = ['codex', 'claude-code'];
  for (const pack of packs) {
    const root = join(SRC, 'products', 'packs', pack);
    try { await stat(root); } catch { continue; }
    for (const file of await tsFiles(root)) {
      const source = await readFile(file, 'utf8');
      for (const other of packs) {
        if (other === pack) continue;
        assert.equal(source.includes(`products/packs/${other}/`), false, `${relative(SRC, file)} imports ${other}`);
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
  const { recoveryTools } = await import('../../src/infrastructure/recovery-tools.js');
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
  const caller = await readFile(join(SRC, 'infrastructure/agent/providers/pi/adapter.ts'), 'utf8');
  assert.match(caller, /transformContext/);
  assert.match(caller, /compactPiMessages/);
  assert.match(caller, /working set still exceeds/);
  const runModel = await readFile(join(SRC, 'application/recovery/run-model.ts'), 'utf8');
  assert.doesNotMatch(runModel, /recoveryObservationTools/);
});

test('Recovery production path does not reintroduce candidate selection or three-state envelopes', async () => {
  const agent = await readFile(join(SRC, 'agents/recovery-agent.ts'), 'utf8');
  assert.doesNotMatch(agent, /select_recovery_candidate/);
  assert.doesNotMatch(agent, /Type\.Literal\("recovered"\)/);
  assert.doesNotMatch(agent, /insufficient_evidence/);
  assert.match(agent, /\.work\(/);
  assert.match(agent, /status: Type\.Literal\("ready"\)/);
  assert.match(agent, /status: Type\.Literal\("blocked"\)/);
  const runModel = await readFile(join(SRC, 'application/recovery/run-model.ts'), 'utf8');
  assert.doesNotMatch(runModel, /select_recovery_candidate/);
  assert.doesNotMatch(runModel, /recoveryCandidates/);
  const forensics = await readFile(join(SRC, 'application/recovery/run-forensics.ts'), 'utf8');
  assert.doesNotMatch(forensics, /materializeRecoveryCandidates/);
  assert.doesNotMatch(forensics, /decideRecoverySearch/);
  const verifier = await readFile(join(SRC, 'application/recovery/verifier.ts'), 'utf8');
  assert.doesNotMatch(verifier, /no_task_path_outcome/);
  assert.doesNotMatch(verifier, /strong_evidence_complete/);
  const provider = await readFile(join(SRC, 'environment/local-workspace-provider.ts'), 'utf8');
  assert.doesNotMatch(provider, /createRecoveryCandidate/);
  assert.doesNotMatch(provider, /selectRecoveryCandidate/);
  assert.doesNotMatch(provider, /validateManifest/);
  assert.doesNotMatch(provider, /verifiedEvidence/);
  assert.doesNotMatch(provider, /hostManifestFromFingerprint/);
  const validateBody = provider.match(/async validateRecovery[\s\S]*?\n {2}async probeRecovery/)?.[0] ?? "";
  assert.doesNotMatch(validateBody, /recovered_partial|insufficient_evidence|extraNotes/);
  const fail = await readFile(join(SRC, 'application/recovery/fail.ts'), 'utf8');
  assert.doesNotMatch(fail, /status:\s*["'](?:recovered|partial|insufficient_evidence)["']/);
  const runFinalize = await readFile(join(SRC, 'application/recovery/run-finalize.ts'), 'utf8');
  assert.doesNotMatch(runFinalize, /verifiedEvidence/);
  assert.doesNotMatch(runModel, /resetRecoveryWorkspace/);
  assert.doesNotMatch(runModel, /investigationPacket/);
  assert.doesNotMatch(runModel, /\bresolved:/);
  assert.doesNotMatch(agent, /\bresolved:/);
  assert.doesNotMatch(agent, /investigationPacket/);
  const workingSet = await readFile(join(SRC, 'agents/recovery-working-set.ts'), 'utf8');
  assert.doesNotMatch(workingSet, /investigationPacket/);
  assert.doesNotMatch(workingSet, /\bresolved:/);
  await assert.rejects(stat(join(SRC, 'application/recovery/review.ts')));
  const tools = await readFile(join(SRC, 'application/recovery/run-model.ts'), 'utf8');
  const names = [...tools.matchAll(/name:\s*["']([^"']+)["']/g)].map((match) => match[1]);
  assert.equal(names.includes('select_recovery_candidate'), false);
});

test('role write policy stays on application owners without a shared Verifier', async () => {
  const { comparisonAttemptWriteAllowed } = await import('../../src/application/experiment-report.js');
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
  const inspection = await readFile(join(SRC, 'application/controller-queries.ts'), 'utf8');
  assert.match(inspection, /pathContainedBy/);
  assert.doesNotMatch(inspection, /fullPath\.startsWith/);
});

test('history read does not import products, Host, or model callers', async () => {
  const source = await readFile(join(SRC, 'infrastructure/agent/history-read.ts'), 'utf8');
  assert.doesNotMatch(source, /products\/|pi-agent-host|pi-model-caller|LocalWorkspaceProvider/);
  const appHistory = await readFile(join(SRC, 'application/experiment-history-read.ts'), 'utf8');
  assert.doesNotMatch(appHistory, /products\/|pi-agent-host|pi-model-caller|LocalWorkspaceProvider/);
});

test('TUI timeline projection does not load product packs', async () => {
  const timeline = await readFile(join(SRC, 'tui/timeline.ts'), 'utf8');
  assert.doesNotMatch(timeline, /products\/index|productPacks/);
  assert.doesNotMatch(timeline, /TargetActivity|runtime\.public_activity|legacyProductFallback/);
  assert.match(timeline, /candidate\.user_view_persisted/);
  const experiment = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.doesNotMatch(experiment, /persistPublicActivities/);
  assert.match(experiment, /isCandidateRuntimeJournalType/);
  const journal = await readFile(join(SRC, 'application/candidate-run-events.ts'), 'utf8');
  assert.match(journal, /CandidateRuntimeEventSchema/);
  assert.match(journal, /Value\.Check\(CandidateRuntimeEventSchema, envelope\.payload\)/);
  const candidateSchema = await readFile(join(SRC, 'core/schemas/candidate.ts'), 'utf8');
  const runtimeEvent = candidateSchema.slice(
    candidateSchema.indexOf('export const CandidateRuntimeEventSchema'),
    candidateSchema.indexOf('export const UserVisibleTurnSchema'),
  );
  assert.doesNotMatch(runtimeEvent, /eventId/);
  assert.doesNotMatch(runtimeEvent, /occurredAt/);
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
  const source = await readFile(join(process.cwd(), 'test', 'products', 'third-pack-config.test.ts'), 'utf8');
  assert.doesNotMatch(source, /new IntakeTui\([\s\S]*?packs\s*:/);
  assert.doesNotMatch(source, /createExperimentWorkflow|createHarnessWorkflow|createCodexExperimentWorkflow|createCodexTuiWorkflow/);
  assert.doesNotMatch(source, /from ['"]\.\.\/src\/infrastructure\/store/);
});

test('unnamed sessionsRoot and harness stop codes do not use product-name or ledger-guard leftovers', async () => {
  const intakeState = await readFile(join(SRC, 'tui/intake-tui-state.ts'), 'utf8');
  assert.doesNotMatch(intakeState, /productId === ['"]codex['"]/);
  const candidateRun = await readFile(join(SRC, 'application/candidate-run.ts'), 'utf8');
  assert.doesNotMatch(candidateRun, /controller_completion_guard/);
  const workflow = await readFile(join(SRC, 'application/experiment-workflow.ts'), 'utf8');
  assert.doesNotMatch(workflow, /createCodexExperimentWorkflow|createCodexTuiWorkflow|CodexTuiWorkflow/);
  assert.doesNotMatch(workflow, /startCodexExperiment|preflightCodexExperiment|recoverCodexExperiment/);
  const experiment = await readFile(join(SRC, 'application/experiment.ts'), 'utf8');
  assert.doesNotMatch(experiment, /startCodexExperiment|finishCodexCandidateRun/);
  const tuiRun = await readFile(join(SRC, 'tui/controller-run.ts'), 'utf8');
  const tuiInput = await readFile(join(SRC, 'tui/controller-input.ts'), 'utf8');
  const tuiIntake = await readFile(join(SRC, 'tui/intake-tui.ts'), 'utf8');
  assert.doesNotMatch(tuiRun, /RecoveryAttempt|recoveryAttempt/);
  assert.doesNotMatch(tuiRun, /codex\.(item_|thread_started|turn_admitted|error)/);
  const replay = await readFile(join(SRC, 'application/replay-conditions.ts'), 'utf8');
  const selection = await readFile(join(SRC, 'application/recovery/selection.ts'), 'utf8');
  assert.doesNotMatch(replay, /productId === ['"]claude-code['"]/);
  assert.doesNotMatch(selection, /productId === ['"]claude-code['"]/);
  assert.doesNotMatch(tuiInput, /RecoveryAttempt|recoveryAttempt/);
  assert.doesNotMatch(tuiIntake, /RecoveryAttempt|recoveryAttempt/);
});

test('application and TUI do not keep empty forwarding modules', async () => {
  await assert.rejects(stat(join(SRC, 'application/tui-workflow.ts')));
  await assert.rejects(stat(join(SRC, 'tui/controller.ts')));
  const intakeApp = await readFile(join(SRC, 'tui/intake-app.ts'), 'utf8');
  assert.match(intakeApp, /from '\.\/intake-tui\.js'/);
  assert.doesNotMatch(intakeApp, /controller\.js/);
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
  const adapter = await readFile(join(SRC, 'infrastructure/agent/providers/pi/adapter.ts'), 'utf8');
  assert.match(adapter, /await notify\(/);
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

test('agent execution does not import experiment application', async () => {
  const files = await tsFiles(join(SRC, 'infrastructure', 'agent'));
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*application\//.test(source)) violations.push(relative(SRC, file).split(sep).join('/'));
  }
  assert.deepEqual(violations, []);
});

test('agent foundation uses sequential Pi Agent and never AgentHarness', async () => {
  await stat(join(SRC, 'infrastructure/agent/types.ts'));
  await stat(join(SRC, 'infrastructure/agent/session.ts'));
  await stat(join(SRC, 'infrastructure/agent/providers/fake/adapter.ts'));
  await stat(join(SRC, 'infrastructure/agent/providers/pi/adapter.ts'));
  const adapter = await readFile(join(SRC, 'infrastructure/agent/providers/pi/adapter.ts'), 'utf8');
  const tools = await readFile(join(SRC, 'infrastructure/agent/providers/pi/tool-adapter.ts'), 'utf8');
  assert.doesNotMatch(adapter, /AgentHarness/);
  assert.doesNotMatch(tools, /AgentHarness/);
  assert.match(tools, /toolExecution: PI_TOOL_EXECUTION/);
  const host = await readFile(join(SRC, 'infrastructure/agent/host.ts'), 'utf8');
  assert.match(host, /export class AgentHost/);
  const types = await readFile(join(SRC, 'infrastructure/agent/types.ts'), 'utf8');
  assert.match(types, /business agents must not depend on `text`/);
  for (const name of ['controller-agent.ts', 'comparison-agent.ts', 'recovery-agent.ts']) {
    const source = await readFile(join(SRC, 'agents', name), 'utf8');
    assert.doesNotMatch(source, /\.value\.text/);
  }
});

test('product packs do not import TUI or experiment workflow', async () => {
  const files = await tsFiles(join(SRC, 'products'));
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(?:tui\/|application\/experiment-workflow|application\/experiment\.js)/.test(source)) {
      violations.push(relative(SRC, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(violations, []);
});

test('TUI pages do not import run operations', async () => {
  const files = await tsFiles(join(SRC, 'tui', 'pages'));
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+['"][^'"]*(?:experiment-workflow|experiment-operations|candidate-run|recovery\/run)/.test(source)) {
      violations.push(relative(SRC, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(violations, []);
});

test('TUI and CLI do not create a candidate runner', async () => {
  const tui = await readFile(join(SRC, 'tui/controller-run.ts'), 'utf8');
  const cli = await readFile(join(SRC, 'cli/headless.ts'), 'utf8');
  assert.doesNotMatch(tui, /createRunner/);
  assert.doesNotMatch(cli, /createRunner/);
});

test('readonly queries do not import experiment assembly or CandidateRun', async () => {
  const queries = await readFile(join(SRC, 'application/experiment-queries.ts'), 'utf8');
  const history = await readFile(join(SRC, 'application/experiment-history-read.ts'), 'utf8');
  assert.doesNotMatch(queries, /from ['"]\.\/experiment\.js['"]|from ['"]\.\/candidate-run\.js['"]/);
  assert.doesNotMatch(history, /from ['"]\.\/experiment\.js['"]|from ['"]\.\/candidate-run\.js['"]/);
});

test('recovery helpers live with their owners instead of support.ts', async () => {
  await assert.rejects(stat(join(SRC, 'application/recovery/support.ts')));
  await stat(join(SRC, 'application/recovery/audit.ts'));
  await stat(join(SRC, 'application/recovery/writes.ts'));
  await stat(join(SRC, 'application/recovery/investigation.ts'));
  await stat(join(SRC, 'application/recovery/staging-diagnostic.ts'));
});

test('core schema concepts are split under schemas/', async () => {
  const schema = await readFile(join(SRC, 'core/schema.ts'), 'utf8');
  assert.match(schema, /from ['"]\.\/schemas\/ids\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/scene\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/event\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/recovery\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/task-case\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/run\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/candidate\.js['"]/);
  assert.match(schema, /from ['"]\.\/schemas\/observations\.js['"]/);
  await stat(join(SRC, 'core/schemas/ids.ts'));
  await stat(join(SRC, 'core/schemas/scene.ts'));
  await stat(join(SRC, 'core/schemas/event.ts'));
  await stat(join(SRC, 'core/schemas/recovery.ts'));
  await stat(join(SRC, 'core/schemas/task-case.ts'));
  await stat(join(SRC, 'core/schemas/run.ts'));
  await stat(join(SRC, 'core/schemas/candidate.ts'));
  await stat(join(SRC, 'core/schemas/observations.ts'));
});

test('ProductPack contract uses history, ProductRuntime, and projection without legacy aliases', async () => {
  const contract = await readFile(join(SRC, 'products/contract.ts'), 'utf8');
  const runtime = await readFile(join(SRC, 'core/runtime.ts'), 'utf8');
  const access = await readFile(join(SRC, 'products/pack-access.ts'), 'utf8');
  assert.match(contract, /export type ProductHistoryReader/);
  assert.match(contract, /readonly history: ProductHistoryReader/);
  assert.match(contract, /readonly projection: UserSurfaceProjection/);
  assert.doesNotMatch(runtime, /UserSurfaceProjection/);
  assert.doesNotMatch(contract, /CompleteProductPack|history\?: ProductHistoryReader/);
  assert.match(runtime, /export interface ProductRuntime/);
  assert.match(runtime, /launch: CandidateLaunchContext/);
  assert.match(runtime, /session\(\): CandidateSessionHandle/);
  assert.match(runtime, /close\(\): Promise<void>/);
  assert.match(contract, /projectTurn\(/);
  assert.match(contract, /PACK_API_MAJOR = 3/);
  assert.match(access, /export function packHistory/);
  assert.match(access, /export function packProjection/);
  assert.doesNotMatch(contract, /SessionSourceAdapter|TargetActivityTranslator|TargetActivity|translate\(/);
  assert.doesNotMatch(runtime, /export interface RuntimePort/);
  assert.doesNotMatch(access, /packSessions|packActivity/);
  await assert.rejects(stat(join(SRC, 'application/public-activity.ts')));
  await assert.rejects(stat(join(SRC, 'core/public-activity.ts')));
  await assert.rejects(stat(join(SRC, 'products/codex')));
  await assert.rejects(stat(join(SRC, 'products/claude-code')));
  await assert.rejects(stat(join(SRC, 'application/observation-files.ts')));
  await assert.rejects(stat(join(SRC, 'application/candidate-launch.ts')));
  await assert.rejects(stat(join(SRC, 'application/candidate-runtime-journal.ts')));
  await assert.rejects(stat(join(SRC, 'application/recovery/run-preflight.ts')));
  await stat(join(SRC, 'application/candidate-run-cleanup.ts'));
  await stat(join(SRC, 'application/candidate-run-facts.ts'));
  await stat(join(SRC, 'application/recovery/admission.ts'));
  await stat(join(SRC, 'products/history/source-refs.ts'));
  await stat(join(SRC, 'environment/snapshots.ts'));
  await stat(join(SRC, 'products/history/discover.ts'));
  await stat(join(SRC, 'products/history/read.ts'));
  await stat(join(SRC, 'products/history/normalize.ts'));
  await stat(join(SRC, 'application/controller-queries.ts'));
  await stat(join(SRC, 'application/recovery/input.ts'));
  await stat(join(SRC, 'infrastructure/process/spawn.ts'));
  await stat(join(SRC, 'infrastructure/process/terminate.ts'));
  await stat(join(SRC, 'infrastructure/process/stdio.ts'));
  await stat(join(SRC, 'products/packs/codex/runner.ts'));
  await stat(join(SRC, 'products/packs/codex/protocol.ts'));
  await stat(join(SRC, 'products/packs/claude-code/runner.ts'));
  await stat(join(SRC, 'products/packs/claude-code/protocol.ts'));
  await stat(join(SRC, 'products/shared/runtime-host.ts'));
  await stat(join(SRC, 'products/shared/turn-wait.ts'));
  await stat(join(SRC, 'products/shared/session-summaries.ts'));
  await assert.rejects(stat(join(SRC, 'application/experiment-inspection.ts')));
  await assert.rejects(stat(join(SRC, 'products/shared/process.ts')));
  await assert.rejects(stat(join(SRC, 'products/packs/codex/runtime-events.ts')));
});

test('automated tests live under core/products/application/candidate/tui/cli', async () => {
  const testRoot = join(process.cwd(), 'test');
  const files = await tsFiles(testRoot);
  const stray = files
    .map((file) => relative(testRoot, file).split(sep).join('/'))
    .filter((rel) => rel.endsWith('.test.ts') && !/^(core|products|application|candidate|tui|cli)\//.test(rel));
  assert.deepEqual(stray, []);
  for (const bucket of ['core', 'products', 'application', 'candidate', 'tui', 'cli']) {
    await stat(join(testRoot, bucket));
  }
});

test('TUI and CLI do not call HistoryReader or freeze helpers directly', async () => {
  const files = [...await tsFiles(join(SRC, 'tui')), ...await tsFiles(join(SRC, 'cli'))];
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const rel = relative(SRC, file).split(sep).join('/');
    if (/\bpackHistory\b/.test(source)) violations.push(`${rel}: packHistory`);
    if (/\bimportVerifiedSession\b/.test(source)) violations.push(`${rel}: importVerifiedSession`);
    if (/\bfreezeCase\b/.test(source)) violations.push(`${rel}: freezeCase`);
    if (/from ['"][^'"]*products\/shared\/freeze\.js['"]/.test(source)) violations.push(`${rel}: freeze import`);
  }
  assert.deepEqual(violations, []);
});

test('Controller briefing has a single current-user-view.md fact source', async () => {
  const briefing = await readFile(join(SRC, 'application/controller-briefing.ts'), 'utf8');
  const agent = await readFile(join(SRC, 'agents/controller-agent.ts'), 'utf8');
  assert.doesNotMatch(briefing, /view\.txt/);
  assert.doesNotMatch(agent, /view\.txt/);
  assert.match(briefing, /current-user-view\.md/);
  assert.match(agent, /current-user-view\.md/);
});

test('TUI and CLI only compose packs at process roots and otherwise call Application', async () => {
  const composition = new Set([
    'tui/intake-tui-state.ts',
    'cli/main.ts',
    'cli/headless.ts',
    'cli/query.ts',
  ]);
  const files = [...await tsFiles(join(SRC, 'tui')), ...await tsFiles(join(SRC, 'cli'))];
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(SRC, file).split(sep).join('/');
    const source = await readFile(file, 'utf8');
    if (/from ['"][^'"]*products\/(?:history|shared|pack-access|packs)\//.test(source)) {
      violations.push(`${rel}: product internals`);
    }
    if (/from ['"][^'"]*products\/index\.js['"]/.test(source) && !composition.has(rel)) {
      violations.push(`${rel}: products/index`);
    }
    for (const match of source.matchAll(/(?:^|\n)import\s+(type\s+)?(\{[^}]*\}|\w+)\s+from\s+['"][^'"]*products\/contract\.js['"]/g)) {
      if (!match[1] && !isTypeOnlyImportClause(match[2] ?? '')) violations.push(`${rel}: contract value`);
    }
  }
  assert.deepEqual(violations, []);
  await stat(join(SRC, 'application/intake-catalog.ts'));
  assert.equal(isTypeOnlyImportClause('type { SessionSummary }'), true);
  assert.equal(isTypeOnlyImportClause('{ type SessionSummary }'), true);
  assert.equal(isTypeOnlyImportClause('{ isEligibleSession }'), false);
  assert.equal(isTypeOnlyImportClause('{ isEligibleSession, type SessionSummary }'), false);
});

function isTypeOnlyImportClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed === 'type' || trimmed.startsWith('type ')) return true;
  if (!trimmed.startsWith('{')) return false;
  const close = trimmed.lastIndexOf('}');
  if (close < 0) return false;
  return trimmed.slice(1, close).split(',').every((part) => {
    const item = part.trim();
    return !item || item.startsWith('type ');
  });
}







