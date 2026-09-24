import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import type { ControllerDecision } from "../agents/controller-agent.js";
import { buildComparisonContext, briefingComparisonContext, comparisonOwnedObservationRefs } from "./comparison.js";
import type { CandidateRun } from "./candidate-run.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonInvocationSchema, ComparisonReportModelSchema, type ArtifactRef, type ComparisonLinkRecord, type ComparisonMediaRecord, type ComparisonPreviewReceipt, type ComparisonReportModel, type TaskCase } from "../core/schema.js";
import type { StructuredAgentResult } from "../infrastructure/agent/host.js";
import { workspaceTools } from "../infrastructure/recovery-tools.js";
import { sanitizedEnvironment } from "../infrastructure/recovery-workspace-tools.js";
import {
  writeImmutableJson,
  type ExperimentStore,
} from "../infrastructure/store/experiment-store.js";
import type { ExperimentInput, ExperimentResult } from "./experiment.js";
import type { ExperimentPreflight } from "./experiment-preflight.js";
import { experimentAgentAuditSink, invocationFact, isMissing } from "./experiment-helpers.js";
import { inspectRun } from "./controller-queries.js";
import type { SourceRootKind } from "./replay-conditions.js";
import {
  comparisonAttemptMounts,
  comparisonCandidateMount,
  comparisonOrientation,
  newComparisonAttempt,
  writeComparisonBriefing,
} from "./comparison-briefing.js";
import { ComparisonVisualMediaError } from "./comparison-openable-media.js";
import { prepareHistoricalArtifacts } from "./prepare-historical-artifacts.js";
import { buildResultPathLinks } from "./result-paths.js";
import { controllerBriefingRoot } from "./controller-briefing.js";
import { assertComparisonResult, type ComparisonContext, type ComparisonResult } from "../agents/comparison-agent.js";
import type { AgentAuditSink, AgentInvocation, AgentToolDefinition } from "../infrastructure/agent/host.js";
import { metricsFromReportFacts, renderComparisonReportShell } from "./comparison-report-shell.js";
import { readOperatorLocale } from "./operator-locale.js";
import type { AgentLocale } from "../agents/language.js";
import { Type } from "@sinclair/typebox";
import { ComparisonEvidenceCatalog, lookupCompletedToolCall } from "./comparison-evidence.js";
import type { ComparisonCatalogSnapshot } from "./comparison-evidence.js";
import { createComparisonRenderCatalogPort } from "./comparison-render-catalog.js";
import { createPreviewReportTool, createRenderArtifactTool } from "./comparison-render-tools.js";
import { comparisonPreviewFingerprint, materializeComparisonReportPreview } from "./comparison-report-preview.js";
import { loadComparisonContentSnapshot } from "./comparison-report-content.js";
import {
  comparisonFailureDiagnostic,
  persistComparisonReportModel,
  publishComparisonArtifacts,
  preparePublishableComparisonHtml,
  verifyAndRenderComparisonReport,
} from "./comparison-publication.js";
import { withComparisonShellDeny } from "./comparison-shell-deny.js";
import { ManagedProcesses } from "../infrastructure/managed-processes.js";
import { createComparisonProcessTools } from "./comparison-process-tools.js";
import { ManagedBrowser } from "../infrastructure/managed-browser.js";
import { createComparisonBrowserTools } from "./comparison-browser-tools.js";
import { createComparisonNetworkTools } from "./comparison-network-tools.js";
import { renderFrozenArtifact } from "../infrastructure/artifact-renderer.js";

export { comparisonCandidateMount };

const MAX_COMPARISON_INPUT_BYTES = 262_144;

export async function finishExperiment(input: {
  signal?: AbortSignal;
  input: ExperimentInput;
  taskCase: TaskCase;
  preflight: ExperimentPreflight;
  store: ExperimentStore;
  run: CandidateRun;
  controller: {
    decision: StructuredAgentResult<ControllerDecision>;
    followupSubmission: boolean;
  };
  experimentRoot: string;
  targetEvents: readonly string[];
  startedAt: number;
  sourceRootKind: SourceRootKind;
  workspaceRoot: string;
  candidateSnapshotRoot: string;
  candidateSnapshotStatus: "complete" | "incomplete" | "missing";
  compare?: boolean;
  onComparisonAttempt?: (attemptId: string) => void;
}): Promise<ExperimentResult> {
  const finishedRecord = input.run.result().record;
  if (!finishedRecord)
    throw new Error("Candidate run did not produce a RunRecord.");
  const traceArtifact = await input.store.commitArtifact({
    artifactId: "host-trace.json",
    runId: input.input.runId,
    kind: "host_run_trace",
    mediaType: "application/json",
    bytes: Buffer.from(
      JSON.stringify(input.store.events(input.input.runId), null, 2),
      "utf8",
    ),
  });
  const traceRef = {
    artifactId: traceArtifact.artifactId,
    experimentId: input.input.experimentId,
    runId: input.input.runId,
  };
  const record = {
    ...finishedRecord,
    artifactRefs: [...finishedRecord.artifactRefs, traceRef],
  };
  await writeImmutableJson(
    join(input.experimentRoot, "runs", input.input.runId, "record.json"),
    record,
  );
  const inspection = await inspectExperimentRun(input, record);
  const compared = input.compare
    ? await compareExperimentOutcome(input, record, inspection)
    : skippedComparison(input.experimentRoot);
  return experimentResult(input, record, inspection, compared);
}

export async function attachExperimentComparison(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
): Promise<ExperimentResult> {
  const inspection = await inspectExperimentRun(input, record);
  return await experimentResult(
    input,
    record,
    inspection,
    await compareExperimentOutcome(input, record, inspection),
  );
}

function skippedComparison(experimentRoot: string) {
  return {
    comparisonResult: { status: "skipped" as const },
    reportPath: experimentRoot,
  };
}

async function experimentResult(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
  inspection: Awaited<ReturnType<typeof inspectRun>>,
  compared: {
    comparisonResult: ExperimentResult["comparison"]["result"];
    reportPath: string;
    attemptRoot?: string;
  },
): Promise<ExperimentResult> {
  const controllerCalls = input.store
    .events(input.input.runId)
    .filter((event) => event.type === "controller.decision").length;
  return {
    taskCase: input.taskCase,
    experimentRoot: input.experimentRoot,
    reportPath: compared.reportPath,
    preflight: input.preflight,
    record,
    decision: input.controller.decision,
    comparison: { result: compared.comparisonResult },
    followupSubmission: input.controller.followupSubmission,
    targetEvents: input.targetEvents,
    facts: {
      elapsedMs: Date.now() - input.startedAt,
      turns: inspection.turns,
      controllerCalls,
      ...(inspection.wallClockMs === undefined
        ? {}
        : { wallClockMs: inspection.wallClockMs }),
      ...(inspection.tokenCount === undefined
        ? {}
        : { tokenCount: inspection.tokenCount }),
      ...(inspection.costUsd === undefined ? {} : { costUsd: inspection.costUsd }),
    },
    pathLinks: await buildResultPathLinks({
      experimentRoot: input.experimentRoot,
      runId: input.input.runId,
      ...(compared.comparisonResult.status === "skipped" ? {} : { reportPath: compared.reportPath }),
      taskCase: input.taskCase,
      inspection,
      workspaceRoot: input.workspaceRoot,
      dataDir: input.input.dataDir,
      ...(compared.attemptRoot ? { attemptRoot: compared.attemptRoot } : {}),
    }),
  };
}

async function inspectExperimentRun(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
) {
  return inspectRun(
    input.store,
    record,
    input.input.candidate.productId,
    undefined,
    {
      sourceRootKind: input.sourceRootKind,
      requestedModel: input.input.candidate.requestedModel,
      ...(record.manifest?.resolvedModel.resolved
        ? { resolvedModel: record.manifest.resolvedModel.resolved }
        : {}),
      lang: languageOf(input.taskCase.initialInput.text),
      dataDir: input.input.dataDir,
    },
  );
}

async function compareExperimentOutcome(
  input: Parameters<typeof finishExperiment>[0],
  record: NonNullable<ReturnType<CandidateRun["result"]>["record"]>,
  inspection: Awaited<ReturnType<typeof inspectRun>>,
) {
  const { attemptId, attemptRoot } = newComparisonAttempt(input.experimentRoot);
  input.onComparisonAttempt?.(attemptId);
  await input.store.append({
    type: "comparison.started",
    runId: input.input.runId,
    operationId: `comparison-started-${attemptId}`,
    payload: {
      attemptId,
      model: (input.input.comparisonAgentConfig ?? input.input.agentConfig)
        .requestedModel,
    },
  });
  await materializeComparisonSandbox(input.store, record.artifactRefs, attemptRoot);
  if (input.candidateSnapshotStatus !== "complete") {
    await mkdir(comparisonCandidateMount({
      candidateSnapshotStatus: input.candidateSnapshotStatus,
      candidateSnapshotRoot: input.candidateSnapshotRoot,
      attemptRoot,
    }), { recursive: true });
  }
  const preparedHistory = await prepareHistoricalArtifacts({
    taskCase: input.taskCase,
    caseDir: join(input.input.dataDir, "cases", input.taskCase.caseId),
    attemptRoot,
    ...(input.input.extractHistoricalArtifacts
      ? { extract: input.input.extractHistoricalArtifacts }
      : {}),
  });
  await mkdir(preparedHistory.finalsRoot, { recursive: true });
  const events = input.store.events(input.input.runId);
  const locale = await readOperatorLocale(input.input.dataDir);
  const comparisonModel = (input.input.comparisonAgentConfig ?? input.input.agentConfig).requestedModel;
  const context: ComparisonContext = {
    ...buildComparisonContext(input.taskCase, [record], [inspection], {
      dataDir: input.input.dataDir,
      comparisonModel,
    }),
    attemptId,
    ownedEvidenceRefs: comparisonOwnedObservationRefs(input.taskCase, events),
  };
  let comparisonResult: AgentInvocation<ComparisonResult>;
  try {
    const briefingContext = briefingComparisonContext(context);
    const materializedIds = new Set(record.artifactRefs.map((ref) => ref.artifactId));
    const briefing = await writeComparisonBriefing({
      attemptRoot, experimentRoot: input.experimentRoot, workspaceRoot: comparisonWorkspaceRoot(input),
      dataDir: input.input.dataDir,
      openableBaselineNames: preparedHistory.openableNames,
      taskCase: input.taskCase, record, context: briefingContext, events,
      artifacts: (await input.store.listArtifacts(input.input.runId)).filter((artifact) => materializedIds.has(artifact.artifactId)),
      snapshotStatus: input.candidateSnapshotStatus,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const compareFacts = {
      ...context,
      media: briefing.media,
      shortEvidenceRefs: briefing.links.flatMap((link) => link.shortRef ? [link.shortRef] : []),
    };
    await persistComparisonRequest(input.store, input.input.runId, attemptId, { ...briefingContext, media: briefing.media, capabilities: briefing.capabilities });
    comparisonResult = await runComparisonAttempt({
      host: input, attemptId, attemptRoot, briefing, compareFacts, locale,
    });
  } catch (error) {
    comparisonResult = mapBriefingErrorToComparisonResult(error);
  } finally {
    await input.input.comparison.release?.(attemptId);
  }
  return persistComparisonInvocation({
    store: input.store,
    runId: input.input.runId,
    experimentRoot: input.experimentRoot,
    attemptId,
    attemptRoot,
    comparisonResult,
    facts: context.reportFacts,
    task: context.task.summary,
    locale,
  });
}

async function runComparisonAttempt(input: {
  host: Parameters<typeof finishExperiment>[0];
  attemptId: string;
  attemptRoot: string;
  briefing: { links: readonly ComparisonLinkRecord[]; media: readonly ComparisonMediaRecord[]; indexMarkdown: string;
    capabilities: import("../core/tool-schema.js").ToolCapabilityManifest; browserPath?: string;
    toolConfig: import("../core/tool-schema.js").ToolConfig };
  compareFacts: ComparisonContext;
  locale: AgentLocale;
}): Promise<AgentInvocation<ComparisonResult>> {
  const compareContext = withOrientation(input.compareFacts, input.host, input.attemptId, input.attemptRoot, input.briefing.indexMarkdown);
  const catalog = await createComparisonAttemptCatalog(input);
  const getEvidenceCatalog = (): ComparisonCatalogSnapshot => catalog.snapshot();
  const processMounts = comparisonAttemptMounts({
    experimentRoot: input.host.experimentRoot,
    runId: input.host.input.runId,
    attemptRoot: input.attemptRoot,
    candidateSnapshotStatus: input.host.candidateSnapshotStatus,
    candidateSnapshotRoot: input.host.candidateSnapshotRoot,
  });
  const processes = new ManagedProcesses(join(input.attemptRoot, "scratch", "process"),
    join(input.attemptRoot, "scratch"), {
      ...sanitizedEnvironment(join(input.attemptRoot, ".home")),
      ...comparisonShellVariables(input.host, input.attemptRoot, processMounts),
    });
  const browser = input.briefing.browserPath ? new ManagedBrowser(input.briefing.browserPath) : undefined;
  let resourcesClosed = false;
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    const outcomes = await Promise.allSettled([processes.close(), browser?.close()]);
    const errors: unknown[] = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason as unknown] : []);
    if (errors.length) throw new AggregateError(errors,
      `Comparison attempt resource cleanup failed: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`);
  };
  try {
    let deliveredImageContentHashes = new Set<string>();
    let previewReceipt: ComparisonPreviewReceipt | undefined;
    let comparisonResult: AgentInvocation<ComparisonResult> = input.host.signal?.aborted
      ? { status: "cancelled" }
      : await (async () => {
        const invoked = await invokeCompare(
          input.host,
          compareContext,
          input.attemptRoot,
          input.attemptId,
          input.host.taskCase.privacy.allowBinary,
          catalog,
          processes,
          browser,
          input.briefing.browserPath,
          input.briefing.toolConfig,
          input.locale,
        );
        deliveredImageContentHashes = invoked.deliveredImageContentHashes;
        previewReceipt = invoked.previewReceipt;
        return invoked.result;
      })();
    if (input.host.signal?.aborted) comparisonResult = { status: "cancelled" };
    comparisonResult = remapInvalidEnvelope(comparisonResult, await reportExists(input.attemptRoot, "work/report/body.html"));
    if (comparisonResult.status === "completed") {
      try {
        assertComparisonResult(comparisonResult.value, input.compareFacts, getEvidenceCatalog);
      } catch (error) {
        comparisonResult = comparisonFailed("invalid_envelope", error, comparisonResult.sessionId);
      }
    }
    if (comparisonResult.status === "completed") {
      const finalCatalog = catalog.snapshot();
      comparisonResult = await enforcePublishedReport(
        comparisonResult,
        input.attemptRoot,
        input.compareFacts,
        { links: finalCatalog.links, media: finalCatalog.media, revision: finalCatalog.revision },
        input.locale,
        deliveredImageContentHashes,
        previewReceipt,
      );
    }
    await closeResources();
    if (comparisonResult.status === "completed") await publishCompletedComparison(input, catalog);
    return comparisonResult;
  } catch (error) {
    try { await closeResources(); }
    catch (cleanupError) {
      const original = error instanceof Error ? error.message : String(error);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return comparisonFailed("agent_failure", new AggregateError([error, cleanupError], `${original}; ${cleanup}`));
    }
    return comparisonFailed("agent_failure", error);
  }
}

async function createComparisonAttemptCatalog(input: Parameters<typeof runComparisonAttempt>[0]): Promise<ComparisonEvidenceCatalog> {
  return ComparisonEvidenceCatalog.create({
    attemptRoot: input.attemptRoot,
    attemptId: input.attemptId,
    links: input.briefing.links,
    media: input.briefing.media,
    emitRegistered: async (payload) => {
      await input.host.store.append({
        type: "comparison.evidence_registered",
        runId: input.host.input.runId,
        operationId: `comparison-evidence-${input.attemptId}-${payload.revision}-${payload.shortRef}`,
        payload,
      });
    },
    emitRegisteredBatch: async (payloads) => {
      await input.host.store.appendBatch(payloads.map((payload) => ({
        type: "comparison.evidence_registered",
        runId: input.host.input.runId,
        operationId: `comparison-evidence-${input.attemptId}-${payload.revision}-${payload.shortRef}`,
        payload,
      })));
    },
    lookupToolCall: async (toolCallId) => lookupCompletedToolCall(
      input.host.store.events(input.host.input.runId),
      input.attemptId,
      toolCallId,
    ),
  });
}

async function publishCompletedComparison(input: Parameters<typeof runComparisonAttempt>[0], catalog: ComparisonEvidenceCatalog): Promise<void> {
  const publishedHtml = await readFile(join(input.attemptRoot, "report.html"), "utf8");
  const publishedModel = readReportModel(await readFile(join(input.attemptRoot, "report-model.json"), "utf8"));
  if (!publishedModel) throw new Error("Validated comparison report model is missing or invalid.");
  await publishComparisonArtifacts({
    attemptRoot: input.attemptRoot,
    experimentRoot: input.host.experimentRoot,
    html: publishedHtml,
    media: catalog.snapshot().media,
    evidence: catalog.snapshot().links,
    model: publishedModel,
  });
}

async function persistComparisonInvocation(input: {
  store: ExperimentStore;
  runId: string;
  experimentRoot: string;
  attemptId: string;
  attemptRoot: string;
  comparisonResult: AgentInvocation<ComparisonResult>;
  facts: ComparisonContext["reportFacts"];
  task: string;
  locale: AgentLocale;
}) {
  await input.store.append({
    type: "comparison.completed",
    runId: input.runId,
    operationId: `comparison-completed-${input.attemptId}`,
    payload: { attemptId: input.attemptId, ...invocationFact(input.comparisonResult) },
  });
  const status = input.comparisonResult.status;
  if (!Value.Check(ComparisonInvocationSchema, input.comparisonResult)) throw new Error("Comparison result does not satisfy ComparisonInvocationSchema.");
  await writeAtomic(join(input.experimentRoot, "comparison.json"), `${JSON.stringify(input.comparisonResult)}\n`);
  const completed = status === "completed";
  const reportPath = completed
    ? join(input.experimentRoot, "report.html")
    : join(input.experimentRoot, "comparison-failure.html");
  if (!completed) {
    await writeComparisonFailurePage({
      reportPath,
      result: input.comparisonResult,
      facts: input.facts,
      task: input.task,
      attemptId: input.attemptId,
      attemptRoot: input.attemptRoot,
      locale: input.locale,
    });
  }
  await input.store.append({
    type: "report.created",
    runId: input.runId,
    operationId: `report-created-${input.attemptId}`,
    payload: { path: reportPath, attemptId: input.attemptId },
  });
  return { comparisonResult: input.comparisonResult, reportPath, attemptRoot: input.attemptRoot };
}

function withOrientation(
  context: ComparisonContext,
  input: Parameters<typeof finishExperiment>[0],
  attemptId: string,
  attemptRoot: string,
  indexMarkdown: string,
): ComparisonContext {
  return {
    ...context,
    attemptId,
    promptContent: comparisonOrientation({
      briefingRoot: join(attemptRoot, "briefing"),
      indexMarkdown,
      baselineAvailable: input.taskCase.baseline.status === "available",
      candidateAvailable: context.candidates.length > 0,
    }),
  };
}

async function enforcePublishedReport(
  result: AgentInvocation<ComparisonResult>,
  attemptRoot: string,
  context: ComparisonContext,
  briefing: { links: readonly ComparisonLinkRecord[]; media: readonly ComparisonMediaRecord[]; revision: number },
  locale: AgentLocale,
  deliveredImageContentHashes: ReadonlySet<string>,
  previewReceipt?: ComparisonPreviewReceipt,
): Promise<AgentInvocation<ComparisonResult>> {
  if (result.status !== "completed") return result;
  if (!(await reportExists(attemptRoot, "work/report/body.html"))) {
    return {
      status: "failed",
      sessionId: result.sessionId,
      failure: {
        code: "agent_failure",
        message: "Comparison agent completed without writing work/report/body.html.",
        attempts: 1,
      },
    };
  }
  let content: Awaited<ReturnType<typeof loadComparisonContentSnapshot>>;
  try {
    content = await loadComparisonContentSnapshot(attemptRoot);
  } catch (error) {
    return { status: "failed", sessionId: result.sessionId, failure: {
      code: "report_incomplete", message: error instanceof Error ? error.message : String(error), attempts: 1,
    } };
  }
  const verified = await verifyAndRenderComparisonReport({
    content,
    hostTask: context.task.summary,
    facts: context.reportFacts,
    result: result.value,
    attemptRoot,
    media: briefing.media,
    evidence: briefing.links,
    locale,
    deliveredImageContentHashes,
  });
  if ("failureClass" in verified) {
    return {
      status: "failed",
      sessionId: result.sessionId,
      failure: {
        code: verified.code,
        message: verified.message,
        attempts: 1,
      },
    };
  }
  const prepared = await preparePublishableComparisonHtml({
    html: verified.html, attemptRoot, media: briefing.media, evidence: briefing.links,
  });
  const fingerprint = comparisonPreviewFingerprint({
    contentDigest: content.digest, facts: context.reportFacts, hostTask: context.task.summary,
    locale, preparedDigest: sha256(prepared.html),
    media: briefing.media, evidence: briefing.links, catalogRevision: briefing.revision,
  });
  if (!previewReceipt?.publishable || !previewReceipt.contractValid
    || previewReceipt.contentDigest !== content.digest
    || previewReceipt.validationDigest !== fingerprint
    || previewReceipt.evidenceRevision !== briefing.revision) {
    return { status: "failed", sessionId: result.sessionId, failure: {
      code: "report_incomplete", message: "The final content or evidence changed after preview_report; preview the current version again.", attempts: 1,
    } };
  }
  await writeAtomic(join(attemptRoot, "report.html"), verified.html);
  await persistComparisonReportModel(attemptRoot, verified.model);
  return result;
}

function remapInvalidEnvelope(result: AgentInvocation<ComparisonResult>, reportPresent: boolean): AgentInvocation<ComparisonResult> {
  if (result.status !== "failed" || !reportPresent) return result;
  const message = result.failure.message;
  if (result.failure.code !== "invalid_output" && message !== "invalid JSON" && !message.includes("schema validation failed")) return result;
  return { ...result, failure: { ...result.failure, code: "invalid_envelope" } };
}

async function invokeCompare(
  input: Parameters<typeof finishExperiment>[0],
  context: ComparisonContext,
  attemptRoot: string,
  attemptId: string,
  allowBinary: boolean,
  catalog: ComparisonEvidenceCatalog,
  processes: ManagedProcesses,
  browser?: ManagedBrowser,
  browserPath?: string,
  toolConfig?: import("../core/tool-schema.js").ToolConfig,
  locale: AgentLocale = "zh",
): Promise<{ result: AgentInvocation<ComparisonResult>; deliveredImageContentHashes: Set<string>; previewReceipt?: ComparisonPreviewReceipt }> {
  const deliveredImageContentHashes = new Set<string>();
  let previewReceipt: ComparisonPreviewReceipt | undefined;
  let phase: "understand" | "investigate" | "compose" | "review" = "compose";
  if (input.signal?.aborted) {
    return { result: { status: "cancelled" }, deliveredImageContentHashes };
  }
  const validateCurrentContent = async () => {
    const snap = catalog.snapshot();
    try {
      return { prepared: await materializeComparisonReportPreview({ attemptRoot, experimentRoot: input.experimentRoot, media: snap.media,
        evidence: snap.links, catalogRevision: snap.revision, hostTask: context.task.summary,
        facts: context.reportFacts, locale, deliveredImageContentHashes }) };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  };
  const result = await input.input.comparison.compare(
    context,
    comparisonTools(input, attemptRoot, allowBinary, catalog, context, deliveredImageContentHashes, processes, browser,
      browserPath, toolConfig ?? { schemaVersion: 1 }, locale, (receipt) => { previewReceipt = receipt; }, () => phase),
    comparisonAudit(input, attemptId, deliveredImageContentHashes),
    input.signal,
    { getEvidenceCatalog: () => catalog.snapshot(),
      onPhase: async (next) => {
        if (next === "investigate" || next === "compose") {
          for (const path of ["work/report/content.json", "work/report/body.html", "work/report/details.html"]) {
            if (await reportExists(attemptRoot, path)) throw new Error(`Report content was written before compose: ${path}`);
          }
        }
        phase = next;
      },
      validateContent: async () => (await validateCurrentContent()).error,
      validateReview: async () => {
        const checked = await validateCurrentContent();
        if (checked.error) return checked.error;
        const prepared = checked.prepared;
        if (!prepared || !previewReceipt?.publishable || !previewReceipt.contractValid
          || previewReceipt.contentDigest !== prepared.draftDigest
          || previewReceipt.validationDigest !== prepared.validationDigest
          || previewReceipt.preparedDigest !== prepared.preparedDigest
          || previewReceipt.evidenceRevision !== prepared.catalogRevision) {
          return "The final content or evidence changed after preview_report; preview the current version again.";
        }
        return undefined;
      } },
  );
  return { result, deliveredImageContentHashes, ...(previewReceipt ? { previewReceipt } : {}) };
}

function comparisonWorkspaceRoot(input: Parameters<typeof finishExperiment>[0]): string {
  return input.candidateSnapshotStatus === "complete"
    ? input.candidateSnapshotRoot
    : join(input.experimentRoot, "comparison-attempts", "candidate-snapshot-unavailable");
}

function comparisonTools(
  input: Parameters<typeof finishExperiment>[0],
  attemptRoot: string,
  allowBinary: boolean,
  catalog: ComparisonEvidenceCatalog,
  context: ComparisonContext,
  deliveredImageContentHashes: ReadonlySet<string>,
  processes: ManagedProcesses,
  browser: ManagedBrowser | undefined,
  browserPath: string | undefined,
  toolConfig: import("../core/tool-schema.js").ToolConfig,
  locale: AgentLocale,
  onPreviewReceipt: (receipt: ComparisonPreviewReceipt) => void,
  currentPhase: () => "understand" | "investigate" | "compose" | "review",
): AgentToolDefinition[] {
  const scratchRoot = join(attemptRoot, "scratch");
  const mounts = comparisonAttemptMounts({
    experimentRoot: input.experimentRoot,
    runId: input.input.runId,
    attemptRoot,
    candidateSnapshotStatus: input.candidateSnapshotStatus,
    candidateSnapshotRoot: input.candidateSnapshotRoot,
  });
  const renderCatalog = createComparisonRenderCatalogPort({
    catalog,
    attemptRoot,
    mounts: {
      finals: mounts.finals,
      candidate: mounts.candidate,
      history: mounts.history,
      evidence: mounts.evidence,
    },
  });
  const render = (request: Parameters<typeof renderFrozenArtifact>[0]) => renderFrozenArtifact({
    ...request, ...(browserPath ? { browserPath } : {}),
  });
  return withComparisonShellDeny([
    ...workspaceTools(attemptRoot, {
      role: "comparison",
      allowBinary,
      mounts,
      allowWrite: (path) => comparisonAttemptWriteAllowed(path, currentPhase()),
      completionPaths: new Set(["work/comparison-plan.md", "work/report/content.json", "work/report/body.html"]),
      denyDestructiveOnPrefix: ["candidate", "evidence", "history", "finals", "turns", "run", "observations"],
      allowShell: true,
      shellCwd: scratchRoot,
      shellEnv: comparisonShellVariables(input, attemptRoot, mounts),
      homeRoot: join(attemptRoot, ".home"),
    }),
    registerEvidenceTool(catalog),
    ...createComparisonProcessTools(processes),
    ...createComparisonNetworkTools({ attemptRoot, config: toolConfig }),
    ...createComparisonBrowserTools({ ...(browser ? { browser } : {}), catalog: renderCatalog, attemptRoot, allowBinary }),
    createRenderArtifactTool({
      catalog: renderCatalog,
      attemptRoot,
      allowBinary,
      render,
    }),
    createPreviewReportTool({
      catalog: renderCatalog,
      attemptRoot,
      allowBinary,
      render,
      onReceipt: onPreviewReceipt,
      prepareReportHtml: async () => {
        const snap = catalog.snapshot();
        return materializeComparisonReportPreview({
          attemptRoot,
          experimentRoot: input.experimentRoot,
          media: snap.media,
          evidence: snap.links,
          catalogRevision: snap.revision,
          hostTask: context.task.summary,
          facts: context.reportFacts,
          locale,
          deliveredImageContentHashes,
        });
      },
    }),
  ]);
}

function comparisonShellVariables(
  input: Parameters<typeof finishExperiment>[0],
  attemptRoot: string,
  mounts: ReturnType<typeof comparisonAttemptMounts>,
): Record<string, string> {
  return {
    REPRISE_BASELINE_ROOT: join(controllerBriefingRoot(input.experimentRoot, input.input.runId), "history"),
    REPRISE_FINALS_ROOT: mounts.finals,
    REPRISE_CANDIDATE_ROOT: mounts.candidate,
    REPRISE_EVIDENCE_ROOT: join(attemptRoot, "evidence"),
    REPRISE_SCRATCH_ROOT: join(attemptRoot, "scratch"),
    REPRISE_CLI_PATH: fileURLToPath(new URL("../cli/main.js", import.meta.url)),
    REPRISE_NODE_PATH: process.execPath,
    REPRISE_DATA_DIR: input.input.dataDir,
  };
}

const RegisterEvidenceParamsSchema = Type.Object({
  relativePath: Type.String({ minLength: 1, maxLength: 512 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 32 }),
  label: Type.String({ minLength: 1, maxLength: 200 }),
  toolCallId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

function registerEvidenceTool(catalog: ComparisonEvidenceCatalog): AgentToolDefinition {
  return {
    name: "register_evidence",
    description: "Seal derived analysis from scratch/ into the attempt evidence catalog with source references. Host sets origin=derived_analysis; registration does not verify your interpretation.",
    parameters: RegisterEvidenceParamsSchema,
    async execute(params, signal) {
      if (!Value.Check(RegisterEvidenceParamsSchema, params)) {
        return { content: "status=rejected\ncode=path_invalid\nmessage=invalid register_evidence parameters" };
      }
      const result = await catalog.registerEvidence({
        relativePath: params.relativePath,
        sourceRefs: params.sourceRefs,
        label: params.label,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
      }, signal);
      if (result.status === "rejected") {
        return {
          content: [
            `status=rejected`,
            `code=${result.code}`,
            `message=${result.message}`,
          ].join("\n"),
        };
      }
      return {
        content: [
          `status=registered`,
          `revision=${result.revision}`,
          `shortRef=${result.shortRef}`,
          `contentHash=${result.contentHash}`,
          `inspectPath=${result.inspectPath}`,
          `origin=${result.origin}`,
          `deduplicated=${result.deduplicated ? "true" : "false"}`,
          "Re-read facts/evidence-index.json after successful registration.",
        ].join("\n"),
        details: result,
      };
    },
  };
}

function comparisonAudit(
  input: Parameters<typeof finishExperiment>[0],
  attemptId: string,
  deliveredImageContentHashes: Set<string>,
): AgentAuditSink {
  const sink = experimentAgentAuditSink(input.store, input.input.runId);
  return {
    append: async (event) => {
      recordDeliveredImageContentHashes(event, deliveredImageContentHashes);
      await sink.append({ ...event, payload: { attemptId, ...event.payload } });
    },
    ...(sink.commitModelInput ? { commitModelInput: (bytes) => sink.commitModelInput!(bytes) } : {}),
  };
}

function recordDeliveredImageContentHashes(
  event: { type: string; payload: Record<string, unknown> },
  delivered: Set<string>,
): void {
  if (event.type === "agent.message_appended") {
    const images = event.payload.images;
    if (!Array.isArray(images)) return;
    for (const image of images) {
      if (image && typeof image === "object" && typeof (image as { contentHash?: unknown }).contentHash === "string") {
        delivered.add((image as { contentHash: string }).contentHash);
      }
    }
    return;
  }
  if (event.type !== "agent.tool_completed") return;
  const types = event.payload.contentTypes;
  if (!Array.isArray(types) || !types.includes("image")) return;
  const body = event.payload.body;
  if (!body || typeof body !== "object" || (body as { encoding?: unknown }).encoding !== "inline") return;
  const text = (body as { text?: unknown }).text;
  if (typeof text !== "string") return;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const block of parsed) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: unknown }).type === "image"
        && typeof (block as { contentHash?: unknown }).contentHash === "string"
      ) {
        delivered.add((block as { contentHash: string }).contentHash);
      }
    }
  } catch {
    // Tool body is not JSON image blocks; nothing to record for visual-claim delivery.
  }
}

async function persistComparisonRequest(store: ExperimentStore, runId: string, attemptId: string, context: unknown): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(context), "utf8");
  const truncated = bytes.byteLength > MAX_COMPARISON_INPUT_BYTES;
  const stored = truncated ? bytes.subarray(0, MAX_COMPARISON_INPUT_BYTES) : bytes;
  const digest = sha256(stored);
  const artifact = await store.commitArtifact({
    artifactId: `comparison-model-input-${digest.slice(0, 16)}`,
    runId,
    kind: "comparison_model_input",
    mediaType: "application/json",
    bytes: stored,
  });
  await store.append({
    type: "comparison.requested",
    runId,
    operationId: `comparison-requested-${attemptId}`,
    payload: {
      schemaVersion: 1,
      requestId: "comparison-requested",
      runId,
      inputDigest: digest,
      artifactId: artifact.artifactId,
      byteLength: stored.byteLength,
      truncated,
    },
  });
}

async function materializeComparisonSandbox(
  store: ExperimentStore,
  refs: readonly ArtifactRef[],
  sandboxRoot: string,
): Promise<void> {
  await mkdir(join(sandboxRoot, "evidence"), { recursive: true });
  for (const ref of refs) {
    if (!("experimentId" in ref)) continue;
    const bytes = await store.readArtifact(ref);
    await writeFile(join(sandboxRoot, "evidence", ref.artifactId), bytes);
  }
}

function languageOf(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

function comparisonFailed(
  code: "publication_failed" | "agent_failure" | "invalid_envelope" | "media_unavailable",
  error: unknown,
  sessionId?: string,
): AgentInvocation<ComparisonResult> {
  const message = error instanceof Error ? error.message : "Comparison host failed.";
  return {
    status: "failed",
    ...(sessionId ? { sessionId } : {}),
    failure: { code, message, attempts: 0 },
  };
}

/** Maps briefing/openable-media failures; AbortError stays cancelled, not publication_failed. */
export function mapBriefingErrorToComparisonResult(
  error: unknown,
): AgentInvocation<ComparisonResult> {
  if (error instanceof Error && error.name === "AbortError") return { status: "cancelled" };
  if (error instanceof ComparisonVisualMediaError) return comparisonFailed("media_unavailable", error);
  return comparisonFailed("publication_failed", error);
}

function readReportModel(raw: string): ComparisonReportModel {
  const value = JSON.parse(raw) as unknown;
  if (!Value.Check(ComparisonReportModelSchema, value)) throw new Error("Comparison report model does not satisfy ComparisonReportModelSchema.");
  return value;
}

async function writeComparisonFailurePage(input: {
  reportPath: string;
  result: StructuredAgentResult<unknown>;
  facts: ComparisonContext["reportFacts"];
  task: string;
  attemptId: string;
  attemptRoot: string;
  locale: AgentLocale;
}): Promise<void> {
  const reportPresent = await reportExists(input.attemptRoot, "report.html");
  const html = renderComparisonReportShell({
    title: "Comparison unavailable",
    task: input.task,
    facts: input.facts,
    metrics: metricsFromReportFacts(input.facts),
    locale: input.locale,
    diagnostic: comparisonFailureDiagnostic({
      result: input.result,
      facts: input.facts,
      reportPresent,
      attemptId: input.attemptId,
      locale: input.locale,
    }),
  });
  await writeFile(input.reportPath, html, "utf8");
}

/** Comparison may write only this attempt's scratch tree, working notes, and content fragments. */
export function comparisonAttemptWriteAllowed(relativePath: string, phase: "understand" | "investigate" | "compose" | "review" = "compose"): boolean {
  const posix = relativePath.replaceAll("\\", "/");
  if (posix === "work/comparison-plan.md") return phase === "understand" || phase === "investigate";
  if (["work/report/content.json", "work/report/body.html", "work/report/details.html"].includes(posix)) return phase === "compose" || phase === "review";
  return posix.split("/").filter(Boolean)[0] === "scratch";
}

async function reportExists(
  experimentRoot: string,
  reportPath: string,
): Promise<boolean> {
  try {
    await readFile(join(experimentRoot, reportPath), "utf8");
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
