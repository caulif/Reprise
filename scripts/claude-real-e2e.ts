import { copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCodexExperimentWorkflow, TUI_RUN_POLICY } from '../src/application/tui-workflow.js';
import { createHarnessAgents } from '../src/application/harness-agents.js';
import { historicalCwdOf } from '../src/application/replay-conditions.js';
import { readHarnessModelConfig } from '../src/infrastructure/harness-model-config.js';
import { PiModelCaller } from '../src/infrastructure/pi-model-caller.js';
import { freezeCase } from '../src/products/shared/freeze.js';
import { claudeCodeProductPack } from '../src/products/claude-code/pack.js';
import { importClaudeSession } from '../src/products/claude-code/sessions.js';
import type { SourceRootKind } from '../src/application/replay-conditions.js';

const SESSION = 'C:\\Users\\15893\\.claude\\projects\\C--obsidian-LLM---papers\\9d3832ba-ef2f-4a51-9f1c-fe2ced0a8c86.jsonl';

async function main(): Promise<void> {
  if (process.env.REPRISE_RUN_CLAUDE_E2E !== '1') {
    throw new Error('Set REPRISE_RUN_CLAUDE_E2E=1 to run the real Claude Code end-to-end check.');
  }
  const imported = await importClaudeSession(SESSION);
  const dataDir = await mkdtemp(join(tmpdir(), 'reprise-claude-e2e-'));
  await copyFile(resolve('.reprise/harness-model.json'), join(dataDir, 'harness-model.json'));
  const frozen = await freezeCase(imported, join(dataDir, 'cases'), {
    allowModelText: true,
    allowBinary: false,
    redactions: [],
  }, new Date().toISOString());
  const prepared = await resolveSourceRoot(dataDir, historicalCwdOf(frozen.taskCase));
  const workflow = createCodexExperimentWorkflow({
    dataDir,
    runtime: claudeCodeProductPack.runtime,
    pack: claudeCodeProductPack,
    now: () => new Date().toISOString(),
    defaults: {
      candidate: { candidateId: 'claude-code-default', productId: 'claude-code', requestedModel: 'default' },
      policy: TUI_RUN_POLICY,
    },
    agents: async () => {
      const config = await readHarnessModelConfig(dataDir);
      if (!config) throw new Error('Harness model configuration is missing from the e2e data dir.');
      const caller = new PiModelCaller(config);
      await caller.validate();
      return createHarnessAgents(config, caller);
    },
  });
  const handle = await workflow.start({
    taskCase: frozen.taskCase,
    sourceRoot: prepared.sourceRoot,
    sourceRootKind: prepared.sourceRootKind,
    experimentId: 'e2e-claude',
    runId: 'run-e2e-claude',
    onEvent: () => undefined,
  });
  const result = await handle.result;
  const report = await readFile(result.reportPath, 'utf8');
  const comparisonPath = join(result.experimentRoot, 'comparison.md');
  let comparison = '';
  try { comparison = await readFile(comparisonPath, 'utf8'); } catch { /* comparison agent may have failed */ }
  const body = `${report}\n${comparison}`.toLowerCase();
  const checks = {
    reportExists: /Reprise (comparison|比较)/.test(report),
    hostStrip: /class="narrative"/.test(report) && /class="files"/.test(report),
    markdownRendered: !report.includes('<pre>') || report.includes('<h1>') || report.includes('<table'),
    baselineVsCandidate: /→/.test(report) || /resolved to/.test(body) || /解析为/.test(body),
    catalogVsRan: /listing is not the same as a successful call|列入目录不等于调用成功/.test(body),
    isolation: /bypasspermissions|disallowed|no-session-persistence|croncreate|isolated replica|隔离副本/.test(body),
    sourceRootKind: prepared.sourceRootKind,
    stopLabel: /controller judged the task complete|safety limit stopped|controller stopped|判定任务已完成|安全上限停止|停止了本次运行/.test(body),
    termination: result.record.outcome.termination.kind,
    reportPath: result.reportPath,
    experimentRoot: result.experimentRoot,
    caseId: frozen.taskCase.caseId,
    initialInputChars: frozen.taskCase.initialInput.text.length,
    comparisonChars: comparison.length,
  };
  console.log(JSON.stringify(checks, null, 2));
  if (!checks.reportExists) throw new Error('report.html was not a Reprise comparison report.');
}

async function resolveSourceRoot(dataDir: string, historicalCwd: string | undefined): Promise<{ sourceRoot: string; sourceRootKind: SourceRootKind }> {
  if (historicalCwd) {
    try {
      if ((await stat(historicalCwd)).isDirectory()) {
        return { sourceRoot: historicalCwd, sourceRootKind: 'historical_cwd' };
      }
    } catch { /* fall through to stand-in */ }
  }
  const sourceRoot = join(dataDir, 'source');
  await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'note.txt'), 'Stand-in workspace for a bounded Reprise Claude e2e.\n');
  return { sourceRoot, sourceRootKind: 'stand_in' };
}

main().catch((error: unknown) => {
  console.error(`Claude e2e failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
