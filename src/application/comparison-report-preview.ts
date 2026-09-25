import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sha256 } from "../core/identity.js";
import { writeAtomic } from "../core/identity.js";
import { pathContainedBy } from "../core/paths.js";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import { comparisonMediaHrefs, preparePublishableComparisonHtml } from "./comparison-publication.js";
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
  const mediaByHref = new Map(input.media.map((item) => [item.reportHref.replaceAll("\\", "/").replace(/^\.\//, ""), item]));
  const dependencies: { href: string; hash: string; bytes: Buffer }[] = [];
  for (const href of comparisonMediaHrefs(prepared.html)) {
    const normalized = href.replaceAll("\\", "/").replace(/^\.\//, "");
    const item = mediaByHref.get(normalized);
    if (!item?.available) continue;
    const source = resolve(input.attemptRoot, ...normalized.split("/"));
    const rootReal = await realpath(input.attemptRoot);
    const sourceReal = await realpath(source);
    if (!pathContainedBy(rootReal, sourceReal) || !pathContainedBy(rootReal, source)) {
      throw new Error(`Comparison preview media escapes attempt root: ${normalized}`);
    }
    const bytes = await readFile(sourceReal);
    const hash = sha256(bytes);
    if (item.contentHash && item.contentHash !== hash) {
      throw new Error(`Comparison preview media changed after registration: ${normalized}`);
    }
    dependencies.push({ href: normalized, hash, bytes });
  }
  const dependencyDigest = sha256(JSON.stringify({
    draftDigest, preparedDigest, catalogRevision: input.catalogRevision,
    media: dependencies.map(({ href, hash }) => ({ href, hash })),
  }));
  const outputRoot = join(input.attemptRoot, "review", "preview", dependencyDigest);
  await mkdir(outputRoot, { recursive: true });
  const rootReal = await realpath(input.attemptRoot);
  const outputReal = await realpath(outputRoot);
  if (!pathContainedBy(rootReal, outputReal)) throw new Error("Comparison preview output escapes attempt root.");
  for (const { href, hash, bytes } of dependencies) {
    const to = resolve(outputRoot, ...href.split("/"));
    if (!pathContainedBy(outputRoot, to)) throw new Error(`Comparison preview media path escapes output root: ${href}`);
    const existing = await readFile(to).catch(() => undefined);
    if (existing && sha256(existing) === hash) continue;
    await mkdir(dirname(to), { recursive: true });
    if (!pathContainedBy(outputReal, await realpath(dirname(to)))) {
      throw new Error(`Comparison preview media output escapes preview root: ${href}`);
    }
    await writeAtomic(to, bytes);
  }
  await writeAtomic(join(outputRoot, "preview.html"), prepared.html);
  return {
    htmlPath: join(outputRoot, "preview.html"),
    html: prepared.html,
    draftDigest,
    preparedDigest,
    catalogRevision: input.catalogRevision,
    dependencyDigest,
    outputRoot,
  };
}
