import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComparisonAgent, type ComparisonContext } from "../../src/agents/comparison-agent.js";
import { ComparisonDraft } from "../../src/application/comparison-draft.js";
import { ComparisonEvidenceCatalog } from "../../src/application/comparison-evidence.js";
import { materializeComparisonReportPreview } from "../../src/application/comparison-report-preview.js";
import { createPreviewReportTool, type ComparisonRenderCatalogPort } from "../../src/application/comparison-render-tools.js";
import { classifyBrowserStartFailure } from "../../src/infrastructure/artifact-cdp.js";
import type { RenderResult } from "../../src/infrastructure/artifact-render-types.js";
import { AgentHost } from "../../src/infrastructure/agent/host.js";

const facts = {
  run: { runId: "run-1", outcome: "completed", terminationCode: "completed", initiatedBy: "controller" },
  models: { candidate: "candidate", baseline: "baseline" },
  activity: {}, limits: { triggered: [] }, runtime: { productId: "codex" },
  delivery: { changedPaths: [], targetArtifactStatus: "available", verificationStatus: "available" },
  replay: { conditions: [], baselineEvidence: "available", candidateEvidence: "available" },
};

const NOT_CALLED = /Call preview_report in the current review turn/;

function context(): ComparisonContext {
  return {
    task: { caseId: "case-1", summary: "Compare." },
    attemptId: "attempt-1",
    baseline: { summary: "Baseline.", evidenceRefs: [] },
    candidates: [], telemetry: [], artifactRefs: [], allowModelText: true,
    replayScope: { historical: "baseline", candidate: "candidate" },
    reportFacts: facts,
  };
}

function catalogPort(): ComparisonRenderCatalogPort {
  return {
    revision: () => 1,
    resolveSource: async () => undefined,
    registerDerivedMedia: async () => ({ ok: false, code: "unused", message: "unused" }),
    registerDerivedMediaBatch: async () => ({ ok: false, code: "unused", message: "unused" }),
  };
}

async function acceptedDraft(root: string): Promise<{ draft: ComparisonDraft; revision: number }> {
  const catalog = await ComparisonEvidenceCatalog.create({ attemptRoot: root, attemptId: "attempt-1", links: [], media: [] });
  const draft = new ComparisonDraft({ attemptRoot: root, task: "Compare outputs.", facts, locale: "en", catalog, deliveredImages: new Set() });
  const accepted = await draft.submit({
    status: "completed", category: "Results", headline: "The candidate differs.",
    comparisonHtml: "<p>A concrete difference.</p>",
  });
  assert.match(accepted, /status=accepted/);
  return { draft, revision: catalog.snapshot().revision };
}

function previewTool(root: string, draft: ComparisonDraft, revision: number, failure: RenderResult & { ok: false }) {
  return createPreviewReportTool({
    catalog: catalogPort(),
    attemptRoot: root,
    render: async () => failure,
    prepareReportHtml: () => materializeComparisonReportPreview({
      attemptRoot: root, media: [], catalogRevision: revision,
    }),
    onPreviewFinished: (prepared, outcome) => draft.recordPreviewOutcome(prepared, outcome),
  });
}

test("accepted draft preview timeout is not reported as a missing preview_report call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { draft, revision } = await acceptedDraft(root);
  const tool = previewTool(root, draft, revision, { ok: false, failure: { kind: "timeout", message: "page load timed out" }, diagnostics: [] });
  const body = JSON.parse((await tool.execute({}, new AbortController().signal)).content) as { status: string };
  assert.equal(body.status, "timeout");
  const reason = draft.failureReason();
  assert.equal(reason.code, "preview_failed");
  assert.equal(reason.kind, "timeout");
  assert.match(reason.message, /timeout/);
  assert.doesNotMatch(reason.message, NOT_CALLED);
});

test("accepted draft preview capability_unavailable is not reported as a missing preview_report call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-unavailable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { draft, revision } = await acceptedDraft(root);
  const tool = previewTool(root, draft, revision, { ok: false, failure: { kind: "capability_unavailable", message: "browser exited early with code 1" }, diagnostics: [] });
  const body = JSON.parse((await tool.execute({}, new AbortController().signal)).content) as { status: string };
  assert.equal(body.status, "capability_unavailable");
  const reason = draft.failureReason();
  assert.equal(reason.code, "preview_failed");
  assert.match(reason.message, /capability_unavailable/);
  assert.doesNotMatch(reason.message, NOT_CALLED);
});

test("accepted draft that never called preview_report still asks for a preview", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reprise-preview-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { draft } = await acceptedDraft(root);
  const reason = draft.failureReason();
  assert.equal(reason.code, "preview_failed");
  assert.match(reason.message, NOT_CALLED);
  assert.equal(reason.kind, undefined);
});

test("review publication failure keeps a timeout kind instead of protocol", async () => {
  const agent = new ComparisonAgent({
    timeoutMs: 0,
    maxRepairAttempts: 0,
    host: new AgentHost({ createSession: () => ({ append: async () => "", cancel() {} }) }),
  });
  const result = await agent.compare(context(), [], undefined, undefined, {
    getSubmittedResult: async () => undefined,
    getSubmissionFailure: () => ({
      code: "preview_failed",
      kind: "timeout",
      message: "Preview of the latest accepted draft returned timeout: digest=abc, revision=1.",
    }),
    getSubmissionState: () => "digest=abc revision=1 timeout",
  });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") return;
  assert.equal(result.failure.kind, "timeout");
  assert.match(result.failure.message, /timeout/);
  assert.doesNotMatch(result.failure.message, NOT_CALLED);
});

test("a timed-out browser start is not capability_unavailable", () => {
  const timed = AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  assert.equal(classifyBrowserStartFailure(timed).failure, "timeout");
  assert.equal(classifyBrowserStartFailure(new AbortController().signal, new Error("timed out waiting for DevToolsActivePort")).failure, "timeout");
  const cancelled = AbortSignal.abort(new Error("cancelled"));
  assert.equal(classifyBrowserStartFailure(cancelled).failure, "capability_unavailable");
});
