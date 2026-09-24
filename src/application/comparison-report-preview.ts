import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import { writeAtomic } from "../core/identity.js";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import type { ComparisonReportFacts } from "../agents/comparison-agent.js";
import type { AgentLocale } from "../agents/language.js";
import { preparePublishableComparisonHtml, readRegisteredEvidenceBytes, readRegisteredMediaBytes } from "./comparison-publication.js";
import { readRegisteredOriginalLinkBytes } from "./comparison-publication-assets.js";
import { verifyAndRenderComparisonReport } from "./comparison-publication.js";
import { loadComparisonContentSnapshot } from "./comparison-report-content.js";
import type { PreparedReportPreview } from "./comparison-render-tools.js";

/**
 * Materialize a browser-loadable preview copy of the attempt draft using the current catalog.
 * Writes under attempt `review/preview/` and never overwrites report.html or published assets.
 */
export async function materializeComparisonReportPreview(input: {
  attemptRoot: string;
  experimentRoot?: string;
  media: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
  catalogRevision: number;
  hostTask: string;
  facts: ComparisonReportFacts;
  locale?: AgentLocale;
  deliveredImageContentHashes?: ReadonlySet<string>;
}): Promise<PreparedReportPreview> {
  const content = await loadComparisonContentSnapshot(input.attemptRoot);
  const checked = await verifyAndRenderComparisonReport({
    content, hostTask: input.hostTask, facts: input.facts,
    attemptRoot: input.attemptRoot, media: input.media,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    ...(input.deliveredImageContentHashes ? { deliveredImageContentHashes: input.deliveredImageContentHashes } : {}),
  });
  if ("failureClass" in checked) throw new Error(`${checked.code}: ${checked.message}`);
  const draftHtml = checked.html;
  const draftDigest = content.digest;
  const prepared = await preparePublishableComparisonHtml({
    html: draftHtml,
    attemptRoot: input.attemptRoot,
    media: input.media,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  const preparedDigest = sha256(prepared.html);
  const outputRoot = join(input.attemptRoot, "review", "preview");
  await mkdir(outputRoot, { recursive: true });
  const [attemptReal, outputReal] = await Promise.all([realpath(input.attemptRoot), realpath(outputRoot)]);
  if (!pathContainedBy(attemptReal, outputReal)) throw new Error("Preview root escapes attempt root.");
  for (const item of input.media) {
    if (!item.available || !item.reportHref) continue;
    const to = join(outputRoot, item.reportHref);
    if (!pathContainedBy(outputRoot, to)) throw new Error(`Preview media path escapes review root: ${item.reportHref}`);
    await mkdir(dirname(to), { recursive: true });
    if (!pathContainedBy(outputReal, await realpath(dirname(to)))) throw new Error(`Preview media path escapes review root: ${item.reportHref}`);
    const bytes = await readRegisteredMediaBytes(input.attemptRoot, item.reportHref, item);
    await writeAtomic(to, bytes);
  }
  for (const link of input.evidence ?? []) {
    if (!link.reportHref) continue;
    const bytes = link.origin === "derived_analysis"
      ? await readRegisteredEvidenceBytes(input.attemptRoot, link)
      : await readRegisteredOriginalLinkBytes(input.experimentRoot ?? input.attemptRoot, link);
    const to = join(outputRoot, ...link.reportHref.split("/"));
    if (!pathContainedBy(outputRoot, to)) throw new Error("Preview evidence path escapes review root.");
    await mkdir(dirname(to), { recursive: true });
    if (!pathContainedBy(outputReal, await realpath(dirname(to)))) throw new Error("Preview evidence path escapes review root.");
    await writeAtomic(to, bytes);
  }
  await writeAtomic(join(outputRoot, "preview.html"), prepared.html);
  return {
    htmlPath: join(outputRoot, "preview.html"),
    html: prepared.html,
    draftDigest,
    preparedDigest,
    catalogRevision: input.catalogRevision,
    outputRoot,
    validationDigest: comparisonPreviewFingerprint({
      contentDigest: content.digest, facts: input.facts, hostTask: input.hostTask,
      media: input.media, evidence: input.evidence ?? [], catalogRevision: input.catalogRevision,
      locale: input.locale ?? "zh", preparedDigest,
    }),
  };
}

export function comparisonPreviewFingerprint(input: {
  contentDigest: string;
  facts: ComparisonReportFacts;
  hostTask: string;
  media: readonly ComparisonMediaRecord[];
  evidence: readonly ComparisonLinkRecord[];
  catalogRevision: number;
  locale: AgentLocale;
  preparedDigest: string;
}): string {
  return sha256(JSON.stringify({
    shellVersion: 2, contentDigest: input.contentDigest, task: input.hostTask,
    locale: input.locale, preparedDigest: input.preparedDigest,
    facts: input.facts, revision: input.catalogRevision,
    evidence: input.evidence.map((item) => [item.shortRef, item.contentHash, item.inspectPath]),
    media: input.media.map((item) => [item.shortRef, item.contentHash, item.reportHref, item.available]),
  }));
}
