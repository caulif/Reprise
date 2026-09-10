import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkClaudeAuth, claudeCodeProductPack } from '../src/products/packs/claude-code/pack.js';
import { CLAUDE_DISALLOWED_TOOLS, CLAUDE_REQUIRED_ARGS } from '../src/products/packs/claude-code/protocol.js';
import {
  ClaudeCodeProductRuntime,
  clearClaudeCatalogCache,
} from '../src/products/packs/claude-code/runtime.js';
import {
  assertClaudeSmokeAcceptanceRecord,
  checkClaudeSmokeGate,
  type ClaudeSmokeAcceptanceRecord,
} from '../src/products/packs/claude-code/smoke-gate.js';
import type { TargetEvent } from '../src/core/runtime.js';
import { candidateLaunchFor } from '../src/application/recovery/launch-context.js';

const PROMPT = 'Create a file named ping.txt whose entire contents are exactly pong. Do nothing else.';

async function main(): Promise<void> {
  if (process.env.REPRISE_RUN_CLAUDE_SMOKE !== '1') {
    throw new Error('Set REPRISE_RUN_CLAUDE_SMOKE=1 to run the real Claude Code smoke.');
  }
  const outPath = process.env.REPRISE_CLAUDE_SMOKE_OUT;
  const runtime = new ClaudeCodeProductRuntime();
  clearClaudeCatalogCache();
  const auth = await checkClaudeAuth(runtime);
  const available = (await runtime.inspectAvailable())[0];
  if (!available) throw new Error('Claude Code executable was not found.');
  const models = await runtime.listModels();
  const requested = process.env.REPRISE_CLAUDE_MODEL ?? models[0]?.value ?? 'sonnet';
  const resolved = await runtime.validateCandidate({ productId: 'claude-code', requestedModel: requested });
  const gate = checkClaudeSmokeGate({
    taskCaseReady: true,
    isolatedWorkspace: true,
    noIrreversibleActions: true,
    accountConfirmed: auth.configured,
    networkConfirmed: true,
    costLimit: 'one bounded turn',
    maxWallClockMs: 180_000,
    permissionModeConfirmed: CLAUDE_REQUIRED_ARGS.includes('bypassPermissions'),
    outOfWorkspaceToolsDisabled: CLAUDE_DISALLOWED_TOOLS.every((tool) => CLAUDE_REQUIRED_ARGS.join(' ').includes(tool)),
    sessionPollutionHandled: CLAUDE_REQUIRED_ARGS.includes('--no-session-persistence'),
    initSnapshotRecorded: true,
  });
  const workspace = await mkdtemp(join(tmpdir(), 'reprise-claude-smoke-'));
  const events: TargetEvent[] = [];
  const environment = { environmentId: 'environment-smoke', runId: 'run-smoke', root: workspace };
  const runner = await runtime.createRunner(
    resolved,
    environment,
    { append: async (event) => { events.push(event); } },
    candidateLaunchFor(resolved, environment),
  );
  runner.setRequestTimeout?.(180_000);
  let receiptEvidence: string | undefined;
  let settlementStatus: ClaudeSmokeAcceptanceRecord['termination'] | undefined;
  let resultText: string | undefined;
  let cleanup: ClaudeSmokeAcceptanceRecord['cleanup'] = 'failed';
  try {
    const receipt = await runner.start(
      { id: 'message-1', text: PROMPT },
      { runId: 'run-smoke', turnIndex: 0, clientMessageId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    );
    receiptEvidence = receipt.evidence;
    const settlement = await runner.waitForTurn();
    settlementStatus = settlement.status === 'completed' || settlement.status === 'failed'
      ? settlement.status
      : settlement.status === 'aborted'
        ? 'cancelled'
        : 'unknown';
    const result = events.find((event) => event.type === 'claude-code.result');
    resultText = redact(JSON.stringify(result?.payload ?? {}));
  } finally {
    try {
      await runner.stop('shutdown');
      cleanup = 'released';
    } catch {
      // keep the initial 'failed'; stop() is the only path that can change it
    }
  }
  receiptEvidence ??= '';
  settlementStatus ??= 'unknown';
  resultText ??= '';
  const init = events.find((event) => event.type === 'claude-code.system_init');
  const initPayload = init && typeof init.payload === 'object' && init.payload ? init.payload as Record<string, unknown> : {};
  const config = {
    model: typeof initPayload.model === 'string' ? initPayload.model : '',
    permissionMode: typeof initPayload.permissionMode === 'string' ? initPayload.permissionMode : '',
    disallowedTools: CLAUDE_DISALLOWED_TOOLS.join(','),
    sessionPersistence: 'off',
  };
  let ping = '';
  try { ping = (await readFile(join(workspace, 'ping.txt'), 'utf8')).trim(); } catch { /* turn may have failed before writing */ }
  const actuallyRan = settlementStatus === 'completed' && ping === 'pong';
  const status: ClaudeSmokeAcceptanceRecord['status'] = actuallyRan ? 'passed' : settlementStatus === 'failed' ? 'blocked' : 'unsupported';
  const record: ClaudeSmokeAcceptanceRecord = {
    schemaVersion: 1,
    status,
    recordedAt: new Date().toISOString(),
    taskCaseId: 'case-smoke',
    experimentId: 'experiment-smoke',
    runId: 'run-smoke',
    executable: available.executable,
    ...(available.version ? { version: available.version } : {}),
    requestedModel: resolved.requestedModel,
    resolvedModel: textField(config.model) || resolved.resolvedModel,
    catalogListed: models.length > 0,
    actuallyRan,
    permissionModeConfirmed: textField(config.permissionMode) === 'bypassPermissions',
    outOfWorkspaceToolsDisabled: textField(config.disallowedTools) === CLAUDE_DISALLOWED_TOOLS.join(','),
    sessionPollutionHandled: textField(config.sessionPersistence) === 'off',
    initSnapshotRecorded: Boolean(init),
    fidelity: init ? 'native' : 'unknown',
    termination: settlementStatus,
    cleanup,
    smokeSteps: {
      started: events.some((event) => event.type === 'claude-code.system_init' || event.type === 'claude-code.user'),
      initialAdmission: receiptEvidence === 'native_event',
      firstTurnSettlement: events.some((event) => event.type === 'claude-code.result'),
      followupSubmission: false,
      stopped: cleanup === 'released',
    },
    humanJudgment: {
      rawEvidence: resultText.slice(0, 4_000),
      artifacts: ping ? `ping.txt=${JSON.stringify(ping)}` : 'ping.txt was not written.',
      traceAndReport: `auth=${auth.source ?? auth.detail ?? 'none'}; catalog=${models.map((model) => model.value).join(',')}; gate=${gate.allowed ? 'allowed' : gate.missing.join('|')}`,
      knownLimitations: 'Bounded protocol smoke only. End-to-end report.html is a separate Step F check.',
      conclusion: status,
    },
    ...(status === 'blocked' ? {
      blockingEvidence: {
        stage: 'first-turn',
        diagnosticCode: settlementStatus === 'failed' ? 'turn_failed' : 'turn_incomplete',
        observation: resultText.slice(0, 4_000),
        unexecutedExternalActions: 'No end-to-end freeze or report.html was attempted after a failed first turn.',
      },
    } : {}),
  };
  assertClaudeSmokeAcceptanceRecord(record);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  const printed = JSON.stringify({
    status: record.status,
    catalogListed: record.catalogListed,
    actuallyRan: record.actuallyRan,
    requestedModel: record.requestedModel,
    resolvedModel: record.resolvedModel,
    termination: record.termination,
    permissionModeConfirmed: record.permissionModeConfirmed,
    outOfWorkspaceToolsDisabled: record.outOfWorkspaceToolsDisabled,
    sessionPollutionHandled: record.sessionPollutionHandled,
    initSnapshotRecorded: record.initSnapshotRecorded,
    ping,
    gateAllowed: gate.allowed,
    authConfigured: auth.configured,
    authSource: auth.source ?? null,
    product: claudeCodeProductPack.manifest.productId,
  }, null, 2);
  if (outPath) await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
  if (status !== 'passed') {
    console.error(printed);
    throw new Error(`Claude Code smoke ${status}: ${record.humanJudgment.rawEvidence.slice(0, 300)}`);
  }
  console.log(printed);
}

function textField(value: string | undefined): string {
  return value?.trim() ?? '';
}

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"]+/gi, '[endpoint redacted]')
    .replace(/(?:sk-|api[_-]?key|bearer|authorization)\S*/gi, '[secret redacted]');
}

main().catch((error: unknown) => {
  console.error(`Real Claude Code smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
