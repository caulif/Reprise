import { access, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { codexSessionAdapter } from '../dist/src/products/codex/sessions.js';
import { claudeSessionAdapter } from '../dist/src/products/claude-code/sessions.js';
import { freezeCase } from '../dist/src/products/shared/freeze.js';
import { readHarnessModelConfig } from '../dist/src/infrastructure/harness-model-config.js';
import { createHarnessAgents } from '../dist/src/application/harness-agents.js';
import { PiModelCaller } from '../dist/src/infrastructure/agent/model-caller.js';
import { recoverExperiment } from '../dist/src/application/recovery/recover.js';
import { LocalWorkspaceProvider } from '../dist/src/environment/local-workspace-provider.js';
import { isEligibleSession } from '../dist/src/products/contract.js';
import { persistRecoveryPreflight, runRecoveryPreflight } from '../dist/src/application/recovery/preflight.js';
import { createRecoveryEvaluationFileSink, evaluateRecoveryCases, RecoveryEvaluationError, runRecoveryEvaluationBatch, assertRecoveryEvaluationLifecycleIntegrity } from '../dist/src/application/recovery/evaluation.js';
import { createRecoverySelectionManifest, prepareRecoverySelectionExecution } from '../dist/src/application/recovery/selection.js';
import { Value } from '@sinclair/typebox/value';
import { RecoveryEvaluationCaseSchema, RecoveryEvaluationPreflightSchema, RecoverySelectionDiagnosticsSchema } from '../dist/src/core/schema.js';
import { recoveryEvaluationFailureCode } from '../dist/src/application/recovery/failure-classification.js';
import { ExperimentStore } from '../dist/src/infrastructure/store/experiment-store.js';

const ROOT = resolve('.reprise');
const RUN_ID = process.env.REPRISE_RECOVERY_EVAL_RUN_ID ?? `recovery-sample-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const RUN_ROOT = join(ROOT, RUN_ID);
const CASES_ROOT = join(RUN_ROOT, 'cases');
const FREEZE_ROOT = join(ROOT, 'recovery-evaluation-frozen-cases');
const WORK_ROOT = join(tmpdir(), 'reprise-recovery-evaluation', RUN_ID);
const SEED = '20260817';
const SAMPLE_LIMIT = Number.parseInt(process.env.REPRISE_RECOVERY_EVAL_LIMIT ?? '5', 10);
const SAMPLE_OFFSET = Number.parseInt(process.env.REPRISE_RECOVERY_EVAL_OFFSET ?? '0', 10);
const PRODUCT_FILTER = process.env.REPRISE_RECOVERY_EVAL_PRODUCT;
const RESUME = process.env.REPRISE_RECOVERY_EVAL_RESUME === '1';
const PRODUCTS = [
  { id: 'codex', adapter: codexSessionAdapter },
  { id: 'claude-code', adapter: claudeSessionAdapter },
];

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const operation = error && typeof error === 'object' && typeof error.operation === 'string' ? error.operation : '';
  const name = error && typeof error === 'object' && typeof error.name === 'string' ? error.name : '';
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  const category = error && typeof error === 'object' && typeof error.exitCategory === 'string' ? error.exitCategory : '';
  if (/insufficient_candidates|selection_source_changed|source_unavailable|not a directory|does not exist|ENOENT/i.test(message)) return 'source_unavailable';
  if (code === 'source_tripwire_failed' || /source tripwire/i.test(message)) return 'source_tripwire_failed';
  if (/snapshot limit|unexpectedly large|source budget/i.test(message)) return 'preflight_failed';
  if (/preflight|harness_config|opt_in_required/i.test(message)) return 'preflight_failed';
  if (name === 'AbortError' || code === 'cancelled' || /cancelled|canceled/i.test(message)) return 'cancelled';
  if (operation === 'staging_shell' || /tool/i.test(operation)) return 'agent_tool_failed';
  if (category === 'timed_out' || /agent timeout|timed out/i.test(message)) return 'agent_timeout';
  if (code === 'agent_invalid_output' || /invalid output|protocol/i.test(message)) return 'agent_invalid_output';
  if (code === 'provider_validation_failed' || /candidate was rejected|provider validation/i.test(message)) return 'provider_validation_failed';
  return 'runner_error';
}
function stratum(item) {
  if (item.signals.toolCalls > 0 && item.signals.completedTurns > 0) return 'completed-with-tools';
  if (item.signals.completedTurns > 0) return 'completed-no-tools';
  return 'incomplete';
}
async function discoverAll(adapter) {
  const items = [];
  let cursor;
  do {
    const page = await adapter.discover({ limit: 100, cursor, refresh: !cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
async function usableSource(root) {
  try { return (await stat(root)).isDirectory(); } catch { return false; }
}
async function select(product) {
  const all = await discoverAll(product.adapter);
  const candidates = [];
  for (const item of all) {
    if (!item.cwd || !isEligibleSession(item)) continue;
    if (await usableSource(item.cwd)) candidates.push(item);
  }
  const byStratum = new Map();
  for (const item of candidates) {
    const bucket = byStratum.get(stratum(item)) ?? [];
    bucket.push(item);
    byStratum.set(stratum(item), bucket);
  }
  for (const bucket of byStratum.values()) bucket.sort((a, b) => digest(`${SEED}:${a.sessionId}`).localeCompare(digest(`${SEED}:${b.sessionId}`)));
  const orderedBuckets = [...byStratum.keys()].sort();
  const selected = [];
  const sourceEligibility = { inspected: 0, isolated: 0, notIsolated: 0, inspectionFailed: 0 };
  const cursors = new Map(orderedBuckets.map((key) => [key, 0]));
  while (selected.length < 5 + SAMPLE_OFFSET) {
    let advanced = false;
    for (const key of orderedBuckets) {
      const bucket = byStratum.get(key) ?? [];
      const cursor = cursors.get(key) ?? 0;
      if (cursor >= bucket.length || selected.length >= 5 + SAMPLE_OFFSET) continue;
      cursors.set(key, cursor + 1); advanced = true;
      const candidate = bucket[cursor];
      sourceEligibility.inspected += 1;
      try {
        const snapshot = await sourceSnapshot(candidate.cwd, `select-${digest(candidate.sessionId).slice(0, 16)}`);
        if (snapshot.readiness === 'isolated') {
          sourceEligibility.isolated += 1;
          selected.push(candidate);
        } else sourceEligibility.notIsolated += 1;
      } catch {
        // A stale or unsupported local source is ineligible; keep the deterministic scan moving.
        sourceEligibility.inspectionFailed += 1;
      }
    }
    if (!advanced) break;
  }
  return { all, candidates, selected, sourceEligibility };
}
async function sourceSnapshot(sourceRoot, caseId) {
  const inspector = new LocalWorkspaceProvider(join(WORK_ROOT, '.source-inspection', caseId));
  const baseline = await inspector.inspectBaseline({ caseId, sourceRoot }, [], {});
  return {
    mode: baseline.mode,
    readiness: baseline.readiness.runnable,
    digest: baseline.fingerprint.digest,
    fileCount: baseline.fingerprint.resources.filter((entry) => entry.kind === 'file').length,
    warningCount: baseline.warnings.length,
  };
}
/** Hash the exact imported payload so history locators and transcript files share the same immutable binding check. */
async function importedSessionContentHash(product, item) {
  const imported = await product.adapter.import({ productId: item.productId, sessionId: item.sessionId, sourcePath: item.sourcePath });
  return digest(imported.raw.text);
}
async function readEvaluationRow(experimentRoot) {
  try {
    const report = JSON.parse(await readFile(join(experimentRoot, 'artifacts', 'recovery-evaluation'), 'utf8'));
    const row = report && typeof report === 'object' && Array.isArray(report.rows) ? report.rows[0] : undefined;
    return row && Value.Check(RecoveryEvaluationCaseSchema, row) ? row : undefined;
  } catch {
    // The persisted artifact is optional for the independent audit; missing or malformed data stays unobserved.
    return undefined;
  }
}
function outcome(attempt, before, after, evaluationRow) {
  const recovery = attempt.baseline.recovery;
  const sourceUnchanged = before.digest === after.digest;
  const agentStatus = attempt.recovery.status;
  const stagingSucceeded = evaluationRow?.stagingSucceeded ?? Boolean(attempt.staging);
  const forensicsStarted = evaluationRow?.forensicsStarted ?? Boolean(attempt.staging);
  const forensicsCompleted = evaluationRow?.forensicsCompleted ?? (!['preflight_failed', 'source_unavailable'].includes(recovery?.failureStage ?? ''));

  const declaredStatus = agentStatus === 'completed' ? attempt.recovery.value.status : 'failed';
  const failureStage = recovery?.failureStage ?? (agentStatus === 'failed' ? 'agent_failure' : undefined);
  const hardFailure = !sourceUnchanged || failureStage === 'source_tripwire_failed';
  let classification = '证据不足，无法判断';
  let confidence = '低';
  let rationale = '独立审计仅使用宿主指纹、Provider 验证和结构化状态，未读取 Recovery 报告或模型文本，无法对任务语义恢复作出肯定判断。';
  if (hardFailure) {
    classification = '错误恢复'; confidence = '高'; rationale = '源目录指纹变化或 source tripwire 触发，属于硬失败。';
  } else if (declaredStatus === 'insufficient_evidence') {
    classification = '证据不足，无法判断'; confidence = '高'; rationale = 'Recovery 明确受控降级，且独立机械事实没有反证。';
  } else if (agentStatus !== 'completed' || failureStage) {
    classification = '错误恢复'; confidence = '中'; rationale = 'Recovery 未通过 Host/Provider 的完成与验证路径。';
  } else if (declaredStatus === 'partial') {
    classification = '基本可用但不完整'; confidence = '低'; rationale = 'Provider 接受了隔离 staging 的结构化部分恢复；语义可用性未独立验证。';
  }
  const failureDetail = recovery?.failureDetail;
  const providerFailureRetryable = failureDetail?.retryable ?? evaluationRow?.providerFailureRetryable;
  const pathBoundaryRejected = evaluationRow?.pathBoundaryRejected;
  const taskOutcome = evaluationRow?.taskOutcome ?? recovery?.taskOutcome ?? null;
  return { sourceUnchanged, stagingSucceeded, forensicsStarted, forensicsCompleted, agentStatus, declaredStatus, failureStage: failureStage ?? null, classification, confidence, rationale, ...(providerFailureRetryable === undefined ? {} : { providerFailureRetryable }), ...(pathBoundaryRejected === undefined ? {} : { pathBoundaryRejected }), taskOutcome, ...(evaluationRow ? { evaluationRow } : {}) };
}
function reportHonesty(result, preview) {
  if (result.agentStatus !== 'completed') return '无法评估：没有可验证的完成结果。';
  if (result.declaredStatus === 'insufficient_evidence') return '一致：受控降级未声称已恢复。';
  if (result.declaredStatus === 'partial') return '部分一致：已声明 unresolved；独立语义效果仍未评估。';
  return preview ? '结构化声明已通过 Provider 验证；独立语义效果未评估，不能据此断言实际恢复正确。' : '不一致：缺少 Provider preview。';
}
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function readLifecycleEvents(experimentsRoot, experimentId, runId, evaluationCaseId) {
  const store = await ExperimentStore.open(join(experimentsRoot, experimentId), experimentId);
  try {
    return store.events(runId)
      .filter(({ type }) => type.startsWith('recovery.'))
      .map(({ type, payload }) => ({
        type,
        // Recovery events use the frozen task-case ID; the evaluation sink uses its stable alias.
        // Re-key only the in-memory audit view so raw append-only evidence remains unchanged.
        payload: evaluationCaseId && typeof payload === 'object' && payload !== null && 'caseId' in payload
          ? { ...payload, caseId: evaluationCaseId }
          : payload,
      }));
  } finally { await store.close(); }
}
async function executeOne(product, item, ordinal, agents, alias, expectedSessionContentHash) {
  const caseDir = join(CASES_ROOT, alias);
  const recoveryDir = join(caseDir, 'recovery');
  await mkdir(recoveryDir, { recursive: true });
  const imported = await product.adapter.import({ productId: item.productId, sessionId: item.sessionId, sourcePath: item.sourcePath });
  if (digest(imported.raw.text) !== expectedSessionContentHash) throw new Error('selection_source_changed');
  const frozen = await freezeCase(imported, FREEZE_ROOT, { allowModelText: true, allowBinary: false, redactions: [] }, new Date().toISOString(), { reuseExisting: true, errorLabel: 'Recovery evaluation' });
  const sourceRoot = imported.taskContext?.historicalCwd;
  if (typeof sourceRoot !== 'string' || !(await usableSource(sourceRoot))) throw new Error('source_unavailable');
  const before = await sourceSnapshot(sourceRoot, frozen.taskCase.caseId);
  await writeJson(join(caseDir, 'baseline-dossier.json'), {
    alias, product: product.id, stratum: stratum(item), sessionContentHash: digest(imported.raw.text),
    evidenceLevel: frozen.taskCase.evidenceLevel, signalCounts: item.signals,
    source: before, frozenCaseHash: digest(JSON.stringify({ caseId: frozen.taskCase.caseId, contentHash: frozen.taskCase.contentHash })),
  });
  const executionDataDir = join(WORK_ROOT, 'cases', alias);
  let attempt;
  try {
    attempt = await recoverExperiment({
      dataDir: executionDataDir, caseId: frozen.taskCase.caseId, experimentId: `eval-${alias}`, runId: `recovery-${alias}`,
      sourceRoot, taskCase: frozen.taskCase, recovery: agents.recovery, executeReadinessCommands: process.env.REPRISE_RUN_RECOVERY_CONTINUATION_CHECKS === '1',
      now: new Date().toISOString(),
    });
  } catch (error) {
      await cp(join(executionDataDir, 'experiments'), join(recoveryDir, 'experiments'), { recursive: true, force: true }).catch(() => undefined);
  const after = await sourceSnapshot(sourceRoot, frozen.taskCase.caseId);
    const audit = { alias, sourceBefore: before, sourceAfter: after, sourceUnchanged: before.digest === after.digest, executionError: safeError(error) };
    await writeJson(join(caseDir, 'mechanical-audit.json'), audit);
    await writeFile(join(caseDir, 'independent-evaluation.md'), `# ${alias}\n\n- 最终分类：错误恢复\n- 置信度：中\n- 独立评估：运行器在调用边界失败；未读取模型文本。\n- 源目录未变：${audit.sourceUnchanged}\n`, 'utf8');
    return { alias, product: product.id, ...audit, classification: '错误恢复', confidence: '中', failureStage: audit.executionError, lifecycleEvents: await readLifecycleEvents(join(executionDataDir, 'experiments'), `eval-${alias}`, `recovery-${alias}`, alias).catch(() => []) };
  }
  await cp(join(executionDataDir, 'experiments'), join(recoveryDir, 'experiments'), { recursive: true, force: true });
  const after = await sourceSnapshot(sourceRoot, frozen.taskCase.caseId);
  const evaluationRow = await readEvaluationRow(attempt.experimentRoot);
  const result = outcome(attempt, before, after, evaluationRow);
  const preview = attempt.providerPreview;
  const audit = {
    alias, sourceBefore: before, sourceAfter: after, ...result,
    providerPreview: preview ? { accepted: preview.accepted, changedPathCount: preview.changedPaths.length, baselineRecoveryStatus: preview.baseline.recovery?.status ?? null } : null,
    recoveryArtifactRoot: 'recovery/experiments',
  };
  await writeJson(join(caseDir, 'mechanical-audit.json'), audit);
  await writeFile(join(caseDir, 'independent-evaluation.md'), `# ${alias}\n\n- 最终分类：${result.classification}\n- 置信度：${result.confidence}\n- 源目录未变：${result.sourceUnchanged}\n- Recovery 报告诚实性：${reportHonesty(result, preview)}\n- 独立评估边界：${result.rationale}\n`, 'utf8');
  return { alias, product: product.id, ...audit, lifecycleEvents: await readLifecycleEvents(join(executionDataDir, 'experiments'), `eval-${alias}`, `recovery-${alias}`, alias).catch(() => []) };
}
async function readPersistedTerminalCase(alias) {
  const path = join(CASES_ROOT, alias, 'case.terminal.json');
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw new Error(`persisted_terminal_unreadable: ${alias}`, { cause: error });
  }
  if (!Value.Check(RecoveryEvaluationCaseSchema, value))
    throw new Error(`persisted_terminal_invalid: ${alias}`);
  const inferredTaskOutcome = value.taskOutcome
    ?? (value.terminal?.failureCode === 'verifier_rejected'
      ? 'unrecoverable'
      : value.terminal?.failureCode
        ? 'runner_failed'
        : value.verification === 'insufficient_evidence'
          ? 'unrecoverable'
          : undefined);
  const inferredVerification = inferredTaskOutcome === 'ready_for_task'
    ? 'verified'
    : inferredTaskOutcome === 'unrecoverable' || inferredTaskOutcome === 'runner_failed' || inferredTaskOutcome === 'blocked_by_safety'
      ? 'insufficient_evidence'
      : value.verification;
  const normalized = inferredTaskOutcome === value.taskOutcome && inferredVerification === value.verification
    ? value
    : { ...value, verification: inferredVerification, ...(inferredTaskOutcome === undefined ? {} : { taskOutcome: inferredTaskOutcome }) };
  if (normalized !== value) await writeJson(path, normalized);
  return normalized;
}

async function writeBlockedCase(alias, product, error) {
  const failureStage = safeError(error);
  const result = { alias, product, classification: '证据不足，无法判断', confidence: '低', failureStage, sourceUnchanged: null, stagingSucceeded: false, forensicsStarted: false, forensicsCompleted: false };
  const caseDir = join(CASES_ROOT, alias);
  await mkdir(caseDir, { recursive: true });
  await writeJson(join(caseDir, 'baseline-dossier.json'), { alias, product, executionStatus: 'blocked_before_recovery', failureStage });
  await writeJson(join(caseDir, 'mechanical-audit.json'), { alias, sourceBefore: null, sourceAfter: null, sourceUnchanged: null, agentStatus: 'not_started', declaredStatus: null, failureStage, classification: result.classification, confidence: result.confidence });
  await writeFile(join(caseDir, 'independent-evaluation.md'), ['# ' + alias, '', '- 最终分类：证据不足，无法判断', '- 置信度：低', '- 独立评估：受控阻塞发生在 Recovery 开始前，未产生模型调用；源目录变更状态未评估。', ''].join('\\n'), 'utf8');
  return { ...result, lifecycleEvents: [] };
}
function failureCodeFor(stage) {
  return recoveryEvaluationFailureCode(stage);
}
function evaluationDraft(alias, result) {
  const declared = result.declaredStatus;
  const taskOutcome = result.taskOutcome
    ?? result.evaluationRow?.taskOutcome
    ?? (result.failureStage ? 'runner_failed' : declared === 'insufficient_evidence' ? 'unrecoverable' : null);
  const verification = taskOutcome === 'ready_for_task'
    ? 'verified'
    : taskOutcome === 'unrecoverable' || taskOutcome === 'runner_failed' || taskOutcome === 'blocked_by_safety'
      ? 'insufficient_evidence'
      : declared === 'recovered' || declared === 'partial' ? 'pending_user_review'
      : 'insufficient_evidence';
  return {
    schemaVersion: 2, caseId: alias, layer: 'history_completed',
    stagingSucceeded: result.stagingSucceeded, forensicsStarted: result.forensicsStarted, forensicsCompleted: result.forensicsCompleted,
    ...(result.providerFailureRetryable === undefined ? {} : { providerFailureRetryable: result.providerFailureRetryable }),
    ...(result.pathBoundaryRejected === undefined ? {} : { pathBoundaryRejected: result.pathBoundaryRejected }),
    ...(taskOutcome === null || taskOutcome === undefined ? {} : { taskOutcome }),
    ...(result.evaluationRow?.evidenceSourcesAttempted === undefined ? {} : { evidenceSourcesAttempted: result.evaluationRow.evidenceSourcesAttempted }),
    ...(result.evaluationRow?.evidenceSourcesAvailable === undefined ? {} : { evidenceSourcesAvailable: result.evaluationRow.evidenceSourcesAvailable }),
    ...(result.evaluationRow?.hypothesisCount === undefined ? {} : { hypothesisCount: result.evaluationRow.hypothesisCount }),
    ...(result.evaluationRow?.candidateCount === undefined ? {} : { candidateCount: result.evaluationRow.candidateCount }),
    ...(Array.isArray(result.evaluationRow?.verifierRejectionReasons) && result.evaluationRow.verifierRejectionReasons.length ? { verifierRejectionReasons: result.evaluationRow.verifierRejectionReasons } : {}),
    candidateCreated: result.evaluationRow?.candidateCreated ?? Boolean(result.providerPreview),
    ...(result.evaluationRow?.candidateAcceptedByUser === undefined ? {} : { candidateAcceptedByUser: result.evaluationRow.candidateAcceptedByUser }),
    ...(result.evaluationRow?.candidateReplayPassed === undefined ? {} : { candidateReplayPassed: result.evaluationRow.candidateReplayPassed }),
    verification,
    recoveredPaths: result.evaluationRow?.recoveredPaths ?? [],
    modelCalls: result.evaluationRow?.modelCalls ?? 0,
    durationMs: result.evaluationRow?.durationMs ?? 0,
    ...(result.evaluationRow?.timings === undefined ? {} : { timings: result.evaluationRow.timings }),
  };
}

async function main() {
  if (process.env.REPRISE_RUN_REAL_RECOVERY_EVALUATION !== '1') throw new Error('opt_in_required');
  const config = await readHarnessModelConfig(ROOT);
  if (!config) throw new Error('harness_config_missing');
  // P0-1: persist the one real model preflight before discovery, freezing, or source inspection.
  const caller = new PiModelCaller(config);
  await mkdir(RUN_ROOT, { recursive: true });
  const preflightPath = join(RUN_ROOT, 'preflight.json');
  let preflight;
  if (RESUME) {
    try {
      const persisted = JSON.parse(await readFile(preflightPath, 'utf8'));
      if (!Value.Check(RecoveryEvaluationPreflightSchema, persisted)) throw new Error('invalid_persisted_preflight');
      if (persisted.providerId !== config.providerId || persisted.modelId !== config.modelId)
        throw new Error('persisted_preflight_identity_mismatch');
      preflight = persisted;
    } catch (error) {
      throw new Error(`resume_preflight_unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  } else {
    preflight = await runRecoveryPreflight({ providerId: config.providerId, modelId: config.modelId, caller });
    await persistRecoveryPreflight(preflightPath, preflight);
  }
  if (preflight.status !== 'passed') throw new Error('preflight_failed');
  const agents = createHarnessAgents(config, caller);
  await mkdir(CASES_ROOT, { recursive: true });
  const picks = [];
  for (const product of PRODUCTS.filter(({ id }) => !PRODUCT_FILTER || id === PRODUCT_FILTER)) {
    try {
      const selected = await select(product);
      picks.push({ product, ...selected });
    } catch (error) {
      await writeJson(join(RUN_ROOT, 'selection-failure.json'), {
        schemaVersion: 1,
        productId: product.id,
        failureCode: safeError(error),
        errorDigest: error instanceof Error ? digest(error.message).slice(0, 12) : null,
      });
      throw error;
    }
  }
  const selectionDiagnostics = {
    schemaVersion: 1,
    products: picks.map(({ product, all, candidates, selected, sourceEligibility }) => ({
      productId: product.id,
      discoveredCount: all.length,
      eligibleMetadataCount: candidates.length,
      selectedCount: selected.length,
      sourceEligibility,
    })),
  };
  if (!Value.Check(RecoverySelectionDiagnosticsSchema, selectionDiagnostics))
    throw new Error('Recovery selection diagnostics are invalid.');
  await writeJson(join(RUN_ROOT, 'selection-diagnostics.json'), selectionDiagnostics);
  const insufficient = picks.find(({ selected }) => selected.length < 5);
  if (insufficient) throw new Error(`insufficient_candidates_${insufficient.product.id}`);
  const selectedBindings = [];
  for (const pick of picks) {
    for (const item of pick.selected.slice(SAMPLE_OFFSET, SAMPLE_OFFSET + SAMPLE_LIMIT)) {
      const source = await sourceSnapshot(item.cwd, `manifest-${digest(item.sessionId).slice(0, 16)}`);
      const sessionContentHash = await importedSessionContentHash(pick.product, item);
      selectedBindings.push({
        candidate: { product: pick.product, item },
        metadata: {
          productId: pick.product.id,
          evidenceLayer: item.evidenceLevel ?? 'transcript',
          sessionContentHash,
          sourceState: { readiness: source.readiness, fingerprint: source.digest, fileCount: source.fileCount, warningCount: source.warningCount },
          signalCounts: item.signals,
        },
      });
    }
  }
  const selection = createRecoverySelectionManifest({ runId: RUN_ID, seed: SEED, selectedAt: new Date().toISOString(), entries: selectedBindings });
  await writeJson(join(RUN_ROOT, 'selection.json'), selection.manifest);
  const summaries = [];
  const persistedRows = [];
  const persistedLifecycleEvents = [];

  const evaluationCases = [];
  const productByEvaluationCase = new Map();
  for (const [index, frozen] of prepareRecoverySelectionExecution(selection.manifest, selection.bindings).entries()) {
    const { product, item } = frozen.candidate;
    const { alias, selection: entry } = frozen;
    productByEvaluationCase.set(alias, product.id);
    if (RESUME) {
      const persisted = await readPersistedTerminalCase(alias);
      if (persisted) {
        const lifecycleEvents = await readLifecycleEvents(join(CASES_ROOT, alias, 'recovery', 'experiments'), `eval-${alias}`, `recovery-${alias}`, alias).catch(() => []);
        persistedRows.push(persisted);
        persistedLifecycleEvents.push(...lifecycleEvents);
        continue;
      }
    }
    evaluationCases.push({
      caseId: alias,
      async run() {
        let result;
        try {
          result = await executeOne(product, item, index + 1, agents, alias, entry.sessionContentHash);
        } catch (error) {
          result = await writeBlockedCase(alias, product.id, error);
        }
        summaries.push(result);
        evaluationCases.find((entry) => entry.caseId === alias).lifecycleEvents = result.lifecycleEvents ?? [];
        console.log(JSON.stringify({ alias, status: result.declaredStatus ?? 'failed', classification: result.classification, sourceUnchanged: result.sourceUnchanged }));
        const draft = evaluationDraft(alias, result);
        if (result.failureStage) throw new RecoveryEvaluationError(failureCodeFor(result.failureStage), 'recovery.execute', draft);
        return draft;
      },
      async auditSource() {
        const result = summaries.find((row) => row.alias === alias);
        return result?.sourceUnchanged === true ? 'passed' : result?.sourceUnchanged === false ? 'failed' : 'unavailable';
      },
    });
  }
  const terminalRows = await runRecoveryEvaluationBatch(evaluationCases, createRecoveryEvaluationFileSink(RUN_ROOT));
  const allRows = [...persistedRows, ...terminalRows];
  assertRecoveryEvaluationLifecycleIntegrity(allRows, [...persistedLifecycleEvents, ...evaluationCases.flatMap((entry) => entry.lifecycleEvents ?? [])]);
  await writeJson(join(RUN_ROOT, 'evaluation-metrics.json'), evaluateRecoveryCases(allRows));
  const summary = {
    runId: RUN_ID,
    sampleCount: allRows.length,
    resumedCount: persistedRows.length,
    products: Object.fromEntries(PRODUCTS.map(({ id }) => {
      const rows = allRows.filter((row) => productByEvaluationCase.get(row.caseId) === id);
      return [id, {
        count: rows.length,
        classifications: Object.groupBy(rows, (row) => row.classification ?? row.terminal?.failureCode ?? row.verification ?? 'unavailable'),
        failureStages: Object.groupBy(rows, (row) => row.failureStage ?? row.terminal?.failureCode ?? 'none'),
        sourceUnchanged: rows.length === 0 ? null : rows.every((row) => row.sourceAudit === 'passed' || row.sourceUnchanged === true),
      }];
    })),
  };
  await writeJson(join(RUN_ROOT, 'summary.json'), summary);
  await writeFile(join(RUN_ROOT, 'summary.md'), `# Recovery 真实样本评估\n\n- 运行：${RUN_ID}\n- 样本数：${allRows.length}
- 恢复跳过已持久化终态：${persistedRows.length > 0 ? '是' : '否'}\n- 说明：仅在隔离 staging 中执行 Recovery；没有接受或写回任何用户源目录。\n- 结果详情见 sample alias 的机械审计与独立评估。\n`, 'utf8');
}
main().catch((error) => { console.error(JSON.stringify({ status: 'failed', reason: safeError(error), errorName: error instanceof Error ? error.name : 'unknown', errorLength: error instanceof Error ? error.message.length : 0, errorDigest: error instanceof Error ? digest(error.message).slice(0, 12) : null })); process.exitCode = 1; });
