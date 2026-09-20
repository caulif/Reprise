import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ComparisonLinkRecord, ComparisonMediaRecord } from "../core/schema.js";
import { captureHeadlessScreenshot, type HeadlessScreenshotResult } from "../infrastructure/headless-screenshot.js";
import { comparisonMediaFileName, isComparisonImagePath, materializeComparisonMedia } from "./comparison-media.js";
import { withMediaShortRefs } from "./comparison-short-refs.js";
import {
  discoverBaselineOpenableSources,
  sealBaselineOpenablePath,
} from "./historical-final-discovery.js";
import { isOpenableFinalPath, isScreenshotOpenablePath, isHistoricalImagePath, isHistoricalVisualPath } from "./openable-final-path.js";

export class ComparisonVisualMediaError extends Error {
  readonly code = "media_unavailable" as const;
  constructor(message: string) {
    super(message);
    this.name = "ComparisonVisualMediaError";
  }
}

function isVisualDeliverablePath(path: string): boolean {
  return isHistoricalVisualPath(path);
}

export async function augmentComparisonOpenableMedia(input: {
  attemptRoot: string;
  workspaceRoot: string;
  links: readonly ComparisonLinkRecord[];
  baselineSources: readonly { inspectPath: string; absolutePath: string }[];
  candidateSources: readonly { inspectPath: string; absolutePath: string }[];
  captureScreenshot?: typeof captureHeadlessScreenshot;
  signal?: AbortSignal;
}): Promise<{ links: ComparisonLinkRecord[]; media: ComparisonMediaRecord[] }> {
  const captureScreenshot = input.captureScreenshot ?? captureHeadlessScreenshot;
  const sealedRoot = join(input.attemptRoot, "finals");
  await mkdir(sealedRoot, { recursive: true });
  for (const source of input.baselineSources) {
    if (!isOpenableFinalPath(source.absolutePath)) continue;
    const logical = source.inspectPath.replace(/\\/g, "/").startsWith("finals/")
      ? source.inspectPath.replace(/\\/g, "/").slice("finals/".length)
      : undefined;
    await sealBaselineOpenablePath(sealedRoot, source.absolutePath, logical || undefined);
  }
  const augmentedLinks = [...input.links];
  const screenshotLinks: ComparisonLinkRecord[] = [];
  const screenshotFailures: string[] = [];
  const linkedImageBasenames = new Set(
    input.links
      .filter((link) => link.mediaType?.startsWith("image/") || isComparisonImagePath(link.inspectPath))
      .map((link) => basename(link.inspectPath.replaceAll("\\", "/"))),
  );
  for (const side of ["baseline", "candidate"] as const) {
    const sources = side === "baseline" ? input.baselineSources : input.candidateSources;
    for (const source of sources) {
      if (!isScreenshotOpenablePath(source.absolutePath)) continue;
      const name = basename(source.absolutePath);
      if (linkedImageBasenames.has(name)) continue;
      const info = await stat(source.absolutePath).catch(() => undefined);
      if (!info?.isFile()) continue;
      const id = `${side}-${basename(source.inspectPath).replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      const pngName = comparisonMediaFileName(id, ".png");
      const pngPath = join(input.attemptRoot, "media", pngName);
      await mkdir(join(input.attemptRoot, "media"), { recursive: true });
      input.signal?.throwIfAborted();
      const captured = await captureScreenshot(source.absolutePath, pngPath, {
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!captured.ok) {
        screenshotFailures.push(formatScreenshotFailure(side, source.inspectPath, captured.failure));
        continue;
      }
      screenshotLinks.push({
        side,
        inspectPath: `media/${pngName}`,
        reportHref: `media/${pngName}`,
        mediaType: "image/png",
        byteLength: (await stat(pngPath)).size,
        artifactId: id,
      });
    }
  }
  augmentedLinks.push(...screenshotLinks);
  const media = withMediaShortRefs(await materializeComparisonMedia({
    attemptRoot: input.attemptRoot,
    workspaceRoot: input.workspaceRoot,
    links: augmentedLinks,
  }));
  assertPairedVisualMediaOrThrow({
    baselineSources: input.baselineSources,
    candidateSources: input.candidateSources,
    links: augmentedLinks,
    media,
    screenshotFailures,
  });
  return { links: augmentedLinks, media };
}

export function assertPairedVisualMediaOrThrow(input: {
  baselineSources: readonly { inspectPath: string; absolutePath: string }[];
  candidateSources: readonly { inspectPath: string; absolutePath: string }[];
  links: readonly ComparisonLinkRecord[];
  media: readonly ComparisonMediaRecord[];
  screenshotFailures?: readonly string[];
}): void {
  const baselineVisual = input.baselineSources.some((item) => isVisualDeliverablePath(item.absolutePath))
    || input.links.some((link) => link.side === "baseline" && isVisualLink(link));
  const candidateVisual = input.candidateSources.some((item) => isVisualDeliverablePath(item.absolutePath))
    || input.links.some((link) => link.side === "candidate" && isVisualLink(link));
  if (!baselineVisual || !candidateVisual) return;
  const baselineAvailable = input.media.some((item) => item.side === "baseline" && item.available);
  const candidateAvailable = input.media.some((item) => item.side === "candidate" && item.available);
  if (baselineAvailable && candidateAvailable) return;
  const details = input.screenshotFailures?.length ? ` ${input.screenshotFailures.join("; ")}` : "";
  throw new ComparisonVisualMediaError(
    `Visual deliverables exist on both sides but paired previews were not registered in media.json.${details}`,
  );
}

function formatScreenshotFailure(
  side: string,
  inspectPath: string,
  failure: { kind: string; message?: string },
): string {
  if (failure.kind === "no_browser") return `${side} ${inspectPath}: no headless browser`;
  return `${side} ${inspectPath}: ${failure.message ?? "capture failed"}`;
}

function isVisualLink(link: ComparisonLinkRecord): boolean {
  if (link.mediaType?.startsWith("image/")) return true;
  return isHistoricalImagePath(link.inspectPath);
}

export async function discoverOpenableSources(input: {
  attemptRoot: string;
  experimentRoot: string;
  workspaceRoot: string;
  runId: string;
  changedPaths: readonly string[];
  dataDir?: string;
  caseId: string;
  baselineArtifactNames: readonly string[];
}): Promise<{
  baselineSources: { inspectPath: string; absolutePath: string }[];
  candidateSources: { inspectPath: string; absolutePath: string }[];
}> {
  const baselineSources = await discoverBaselineOpenableSources({
    attemptRoot: input.attemptRoot,
    experimentRoot: input.experimentRoot,
    runId: input.runId,
    caseId: input.caseId,
    baselineArtifactNames: input.baselineArtifactNames,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  });
  const candidateSources: { inspectPath: string; absolutePath: string }[] = [];
  for (const path of input.changedPaths) {
    const absolutePath = join(input.workspaceRoot, ...path.split("/"));
    const info = await stat(absolutePath).catch(() => undefined);
    if (!info?.isFile() || !isOpenableFinalPath(absolutePath)) continue;
    candidateSources.push({ inspectPath: `candidate/${path}`, absolutePath });
  }
  return { baselineSources, candidateSources };
}

