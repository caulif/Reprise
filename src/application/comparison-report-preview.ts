import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256 } from "../core/identity.js";
import { writeAtomic } from "../core/identity.js";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import { preparePublishableComparisonHtml } from "./comparison-publication.js";
import type { PreparedReportPreview } from "./comparison-render-tools.js";

/**
 * Materialize a browser-loadable preview copy of the attempt draft using the current catalog.
 * Writes under attempt `review/preview/` and never overwrites report.html or published assets.
 */
export async function materializeComparisonReportPreview(input: {
  attemptRoot: string;
  draftHtml?: string;
  media: readonly ComparisonMediaRecord[];
  evidence?: readonly ComparisonLinkRecord[];
  catalogRevision: number;
}): Promise<PreparedReportPreview> {
  const draftPath = join(input.attemptRoot, "report.html");
  const draftHtml = input.draftHtml ?? await readFile(draftPath, "utf8");
  const draftDigest = sha256(draftHtml);
  const prepared = await preparePublishableComparisonHtml({
    html: draftHtml,
    attemptRoot: input.attemptRoot,
    media: input.media,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  });
  const preparedDigest = sha256(prepared.html);
  const outputRoot = join(input.attemptRoot, "review", "preview");
  await mkdir(outputRoot, { recursive: true });
  for (const item of input.media) {
    if (!item.available || !item.reportHref) continue;
    const from = join(input.attemptRoot, item.reportHref);
    const to = join(outputRoot, item.reportHref);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to).catch(() => undefined);
  }
  await writeAtomic(join(outputRoot, "preview.html"), prepared.html);
  return {
    htmlPath: join(outputRoot, "preview.html"),
    html: prepared.html,
    draftDigest,
    preparedDigest,
    catalogRevision: input.catalogRevision,
    outputRoot,
  };
}
