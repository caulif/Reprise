import { mkdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonContext, ComparisonFactsContext } from "../agents/comparison-agent.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonBriefingContextSchema, ComparisonLinksSchema, GitSinkManifestSchema, type ComparisonLinkRecord, type ComparisonMediaRecord, type EventEnvelope, type RunRecord, type TaskCase } from "../core/schema.js";
import type { ArtifactManifest } from "../infrastructure/store/experiment-store.js";
import { briefingComparisonContext } from "./comparison.js";
import { controllerBriefingRoot } from "./controller-briefing.js";
import { OBSERVATIONS_MOUNT, writeFrozenObservationTree } from "../products/history/observations-materializer.js";
import { finalizeGitSinkCatalog, gitSinkRefsListing, gitSinkRoot, readGitSinkManifest } from "../environment/git-sink.js";
import {
  isComparisonImagePath,
  mediaTypeForComparisonPath,
} from "./comparison-media.js";
import { withEvidenceShortRefs } from "./comparison-short-refs.js";
import { replicaWorkspaceLocation } from "./result-paths.js";
import { isComparisonChangedPath } from "./controller-queries.js";
import {
  augmentComparisonOpenableMedia,
  discoverOpenableSources,
} from "./comparison-openable-media.js";
import {
  buildSealedBaselineImageLinks,
  collectHistoricalDeliverableNames,
} from "./historical-final-discovery.js";
import { attemptFinalsRoot } from "./prepare-historical-artifacts.js";

export const MAX_COMPARISON_LINKS = 64;

export type ComparisonLink = ComparisonLinkRecord;

export function comparisonOrientation(input: {
  briefingRoot: string;
  indexMarkdown: string;
  baselineAvailable: boolean;
  candidateAvailable: boolean;
}): string {
  return [
    "Compare this real task's historical outcome with the candidate run.",
    `baselineEvidence=${input.baselineAvailable ? "available" : "unavailable"}`,
    `candidateEvidence=${input.candidateAvailable ? "available" : "unavailable"}`,
    "Navigation for the attempt root is in INDEX.md below.",
    "Start with briefing/decision-map.md for bounded delivery leads and gaps; verify conclusions against the linked sources.",
    "",
    "# INDEX.md",
    input.indexMarkdown,
  ].join("\n");
}

export function newComparisonAttempt(experimentRoot: string): { attemptId: string; attemptRoot: string } {
  const attemptId = randomUUID();
  return { attemptId, attemptRoot: join(experimentRoot, "comparison-attempts", attemptId) };
}

export function comparisonCandidateMount(input: {
  candidateSnapshotStatus: "complete" | "incomplete" | "missing";
  candidateSnapshotRoot: string;
  attemptRoot: string;
}): string {
  if (input.candidateSnapshotStatus === "complete") return input.candidateSnapshotRoot;
  return join(input.attemptRoot, "candidate-snapshot-unavailable");
}

/** Tool mounts used by Comparison Agent. Paths are relative to the attempt root. */
export type ComparisonAttemptMounts = {
  readonly candidate: string;
  readonly evidence: string;
  readonly history: string;
  /** Frozen / derived historical deliverables for this attempt (not controller process history). */
  readonly finals: string;
  readonly turns: string;
  readonly run: string;
};

export function comparisonAttemptMounts(input: {
  experimentRoot: string;
  runId: string;
  attemptRoot: string;
  candidateSnapshotStatus: "complete" | "incomplete" | "missing";
  candidateSnapshotRoot: string;
}): ComparisonAttemptMounts {
  const controllerRoot = controllerBriefingRoot(input.experimentRoot, input.runId);
  return {
    candidate: comparisonCandidateMount(input),
    evidence: join(input.attemptRoot, "evidence"),
    history: join(controllerRoot, "history"),
    finals: attemptFinalsRoot(input.attemptRoot),
    turns: join(controllerRoot, "run", "turns"),
    run: join(controllerRoot, "run"),
  };
}

export async function writeComparisonBriefing(input: {
  attemptRoot: string;
  experimentRoot: string;
  workspaceRoot: string;
  dataDir?: string;
  /** Extra openable-baseline names from prepare manifest (old-case derive). */
  openableBaselineNames?: readonly string[];
  taskCase: TaskCase;
  record: RunRecord;
  context: ComparisonContext | ComparisonFactsContext;
  events: readonly EventEnvelope[];
  artifacts: readonly ArtifactManifest[];
  snapshotStatus: "complete" | "incomplete" | "missing";
  signal?: AbortSignal;
}): Promise<{ indexMarkdown: string; links: ComparisonLink[]; media: ComparisonMediaRecord[]; fileDigests: Record<string, string> }> {
  const briefingRoot = join(input.attemptRoot, "briefing");
  await Promise.all([
    mkdir(join(briefingRoot, "task"), { recursive: true }),
    mkdir(join(briefingRoot, "candidate"), { recursive: true }),
    mkdir(join(briefingRoot, "facts"), { recursive: true }),
    mkdir(join(input.attemptRoot, "work"), { recursive: true }),
    mkdir(join(input.attemptRoot, "scratch"), { recursive: true }),
    mkdir(join(input.attemptRoot, "evidence"), { recursive: true }),
  ]);
  await writeFrozenObservationTree({
    root: join(input.attemptRoot, OBSERVATIONS_MOUNT),
    taskCase: input.taskCase,
    runEvents: input.events,
  });
  const selected = await comparisonLinks(input);
  const mediaBundle = await comparisonMediaBundle(input, selected);
  const links = mediaBundle.links;
  const media = mediaBundle.media;
  const invalidLinkCount = mediaBundle.invalidLinkCount;
  const context = briefingComparisonContext(input.context);
  const briefingContext = {
    ...context,
    reportFacts: {
      ...context.reportFacts,
      delivery: {
        ...context.reportFacts.delivery,
        changedPaths: selected.links.flatMap((link) => link.path ? [link.path] : []),
        changedPathsIndexed: selected.changedPathsIndexed,
        changedPathsOmitted: selected.omitted + invalidLinkCount,
      },
    },
    media,
  };
  if (!Value.Check(ComparisonBriefingContextSchema, briefingContext)) throw new Error("Comparison context does not satisfy ComparisonBriefingContextSchema.");
  const snapshotStatus = comparisonSnapshotLabel(input.snapshotStatus);
  const cleanupStatus = input.record.outcome.cleanup.status;
  const indexMarkdown = comparisonIndex(snapshotStatus, cleanupStatus, {
    links: links.length,
    changedPathsIndexed: selected.changedPathsIndexed,
    omitted: selected.omitted + invalidLinkCount,
    limit: MAX_COMPARISON_LINKS,
  });
  const decisionMap = comparisonDecisionMap({
    links, media, snapshotStatus,
    openableSources: mediaBundle.openableSources,
    omitted: selected.omitted + invalidLinkCount,
    changedPathsIndexed: selected.changedPathsIndexed,
  });
  const factsContext = `${JSON.stringify(briefingContext, null, 2)}\n`;
  const factsLinks = `${JSON.stringify(links, null, 2)}\n`;
  const factsMedia = `${JSON.stringify(media, null, 2)}\n`;
  const factsEvidence = `${JSON.stringify(links.map((link) => ({
    shortRef: link.shortRef, label: link.label, side: link.side, inspectPath: link.inspectPath,
    ...(link.reportHref ? { reportHref: link.reportHref } : {}),
    ...(link.evidenceRef ? { canonicalRef: link.evidenceRef } : {}),
  })), null, 2)}\n`;
  const candidateProcess = processIndex(input.events);
  const gitSink = await loadGitSinkBriefing(input.experimentRoot, input.record.attempt.runId,
    input.record.manifest?.environment.workspacePath ?? join(input.experimentRoot, 'environment', 'runs', input.record.attempt.runId));
  const files: Record<string, string> = {
    "INDEX.md": indexMarkdown,
    "decision-map.md": decisionMap,
    "task/initial-input.txt": input.taskCase.initialInput.text,
    "candidate/process-index.tsv": candidateProcess,
    "facts/context.json": factsContext,
    "facts/comparison-links.json": factsLinks,
    "facts/media.json": factsMedia,
    "facts/evidence-index.json": factsEvidence,
    "facts/links-diagnostics.json": `${JSON.stringify({ schemaVersion: 1, indexed: links.length, omitted: selected.omitted, invalidDropped: invalidLinkCount, limit: MAX_COMPARISON_LINKS }, null, 2)}\n`,
    "candidate/SNAPSHOT.txt": `snapshotStatus=${snapshotStatus}\ncleanupStatus=${cleanupStatus}\n`,
    "candidate/git-sink-refs.txt": gitSink.refsListing,
    "candidate/git-sink-manifest.json": gitSink.catalogJson,
  };
  for (const [path, body] of Object.entries(files)) await writeAtomic(join(briefingRoot, ...path.split("/")), body);
  await writeAttemptSidecars(input, {
    factsContext, factsLinks, factsMedia, factsEvidence, candidateProcess, snapshotStatus, cleanupStatus, gitSink,
  });
  return { indexMarkdown, links, media, fileDigests: Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha256(body)])) };
}

async function comparisonMediaBundle(
  input: Parameters<typeof writeComparisonBriefing>[0],
  selected: Awaited<ReturnType<typeof comparisonLinks>>,
): Promise<{ links: ComparisonLink[]; media: ComparisonMediaRecord[]; invalidLinkCount: number; openableSources: { baseline: string[]; candidate: string[] } }> {
  const rawLinks = withEvidenceShortRefs(selected.links);
  const links = rawLinks.filter((link) => Value.Check(ComparisonLinksSchema, [link]));
  const invalidLinkCount = rawLinks.length - links.length;
  const openable = await discoverOpenableSources({
    attemptRoot: input.attemptRoot,
    experimentRoot: input.experimentRoot,
    workspaceRoot: input.workspaceRoot,
    runId: input.record.attempt.runId,
    changedPaths: input.context.reportFacts.delivery.changedPaths.filter(isComparisonChangedPath),
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
    caseId: input.taskCase.caseId,
    baselineArtifactNames: [
      ...collectHistoricalDeliverableNames(input.taskCase, "openable-baseline"),
      ...(input.openableBaselineNames ?? []),
    ],
  });
  const augmented = await augmentComparisonOpenableMedia({
    attemptRoot: input.attemptRoot,
    workspaceRoot: input.workspaceRoot,
    links,
    baselineSources: openable.baselineSources,
    candidateSources: openable.candidateSources,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return {
    links: augmented.links, media: augmented.media, invalidLinkCount,
    openableSources: {
      baseline: openable.baselineSources.map((item) => item.inspectPath),
      candidate: openable.candidateSources.map((item) => item.inspectPath),
    },
  };
}

async function writeAttemptSidecars(
  input: {
    attemptRoot: string;
    experimentRoot: string;
    taskCase: TaskCase;
    record: RunRecord;
  },
  files: {
    factsContext: string;
    factsLinks: string;
    factsMedia: string;
    factsEvidence: string;
    candidateProcess: string;
    snapshotStatus: string;
    cleanupStatus: string;
    gitSink: { refsListing: string; catalogJson: string };
  },
): Promise<void> {
  await mkdir(join(input.attemptRoot, "history"), { recursive: true });
  await mkdir(join(input.attemptRoot, "candidate"), { recursive: true });
  await mkdir(join(input.attemptRoot, "facts"), { recursive: true });
  await writeAtomic(join(input.attemptRoot, "INDEX.md"), comparisonAttemptIndex());
  await writeAtomic(join(input.attemptRoot, "facts", "context.json"), files.factsContext);
  await writeAtomic(join(input.attemptRoot, "facts", "comparison-links.json"), files.factsLinks);
  await writeAtomic(join(input.attemptRoot, "facts", "media.json"), files.factsMedia);
  await writeAtomic(join(input.attemptRoot, "facts", "evidence-index.json"), files.factsEvidence);
  await writeAtomic(join(input.attemptRoot, "history", "INDEX.md"), [
    "# History track",
    "",
    "The frozen historical session and this run's imported events are under observations/.",
    "User inputs: observations/user-inputs/INDEX.tsv",
    "",
  ].join("\n"));
  await writeAtomic(join(input.attemptRoot, "candidate", "INDEX.md"), [
    "# Candidate track",
    "",
    "Process index: candidate/process-index.tsv and briefing/candidate/process-index.tsv",
    "User views: turns/*/user-view.md",
    "Experiment Git remotes: briefing/candidate/git-sink-refs.txt and briefing/candidate/git-sink-manifest.json",
    "Controller messages: run/sent-user-messages.jsonl and observations/user-inputs/",
    "",
  ].join("\n"));
  await writeAtomic(join(input.attemptRoot, "candidate", "process-index.tsv"), files.candidateProcess);
  await writeAtomic(
    join(input.attemptRoot, "history", "messages.tsv"),
    ["id\trole\tbytes", ...input.taskCase.transcript.map((message) => `${message.id}\t${message.role}\t${Buffer.byteLength(message.text)}`)].join("\n") + "\n",
  );
  await writeAtomic(join(input.attemptRoot, "candidate", "outcome.json"), `${JSON.stringify(input.record.outcome, null, 2)}\n`);
  await writeAtomic(
    join(input.attemptRoot, "candidate", "SNAPSHOT.txt"),
    `snapshotStatus=${files.snapshotStatus}\ncleanupStatus=${files.cleanupStatus}\n`,
  );
  const userView = await readFile(
    join(input.experimentRoot, "runs", input.record.attempt.runId, "controller-briefing", "current-user-view.md"),
    "utf8",
  ).catch(() => "");
  if (userView) await writeAtomic(join(input.attemptRoot, "candidate", "user-view.md"), userView);
  await writeAtomic(join(input.attemptRoot, "candidate", "git-sink-refs.txt"), files.gitSink.refsListing);
  await writeAtomic(join(input.attemptRoot, "candidate", "git-sink-manifest.json"), files.gitSink.catalogJson);
}

export function comparisonSnapshotLabel(status: "complete" | "incomplete" | "missing"): "complete" | "incomplete" | "unknown" {
  return status === "missing" ? "unknown" : status;
}

function comparisonAttemptIndex(): string {
  return [
    "# Comparison attempt",
    "",
    "Navigation is in briefing/INDEX.md. facts/, history/, finals/, and candidate/ are Host projections for human audit.",
    "",
  ].join("\n");
}

function comparisonIndex(
  snapshotStatus: "complete" | "incomplete" | "unknown",
  cleanupStatus: string,
  evidence: { links: number; changedPathsIndexed: number; omitted: number; limit: number },
): string {
  return [
    "# Comparison briefing map",
    "",
    "Read only what can change the comparison. Historical and candidate process bodies are mounted separately; this directory holds navigation and Host facts.",
    "All paths below are relative to the attempt root, not to briefingRoot.",
    "",
    "- briefing/decision-map.md: bounded delivery leads and gaps; inspect the sources before judging",
    `- candidate/SNAPSHOT.txt: snapshotStatus=${snapshotStatus} cleanupStatus=${cleanupStatus}`,
    "- briefing/task/initial-input.txt: frozen initial task",
    `- briefing/facts/context.json: bounded Host projection; delivery.changedPathsIndexed=${evidence.changedPathsIndexed} delivery.changedPathsOmitted=${evidence.omitted}`,
    `- briefing/facts/links-diagnostics.json: evidence index ${evidence.links}/${evidence.limit}; omitted=${evidence.omitted}`,
    "- briefing/facts/comparison-links.json: inspect paths and stable report links; not the full workspace listing",
    "- briefing/facts/media.json: registered images and previews, shortRef media-01, reportHref, availability",
    "- briefing/facts/evidence-index.json: short evidence refs ev-01 with descriptive names",
    "- briefing/candidate/process-index.tsv: complete run event index including post-settlement events",
    "- observations/user-inputs/INDEX.tsv: complete user demand in session order (historical_user vs controller)",
    "- observations/INDEX.md: frozen transcript, historical events, and this run's events (read-only)",
    "- history/outline.tsv and history/transcript/: frozen historical conversation (read-only mount)",
    "- finals/: frozen or attempt-derived historical deliverables (read-only mount; use REPRISE_FINALS_ROOT in shell)",
    "- turns/: candidate settled-turn briefing including each user-view.md (read-only mount)",
    "- briefing/candidate/git-sink-refs.txt: Host catalog of initial and final sink refs by repository relative path (not the user's GitHub); objectStore may be not_seeded",
    "- briefing/candidate/git-sink-manifest.json: structured sink catalog with isolation, objectStore, completeness, issues.code, and ref changes; do not assume a branch named main",
    "- run/sent-user-messages.jsonl: Controller messages sent this run (read-only mount)",
    "- candidate/: retained candidate workspace snapshot (read-only mount)",
    "- evidence/: materialized Host artifacts (read-only mount)",
    "- work/comparison-plan.md: revisable working notes for this session",
    "- scratch/: unrestricted temporary analysis files; the shell starts here",
    "",
  ].join("\n");
}

function comparisonDecisionMap(input: {
  links: readonly ComparisonLinkRecord[];
  media: readonly ComparisonMediaRecord[];
  openableSources: { baseline: readonly string[]; candidate: readonly string[] };
  snapshotStatus: "complete" | "incomplete" | "unknown";
  omitted: number;
  changedPathsIndexed: number;
}): string {
  const lines = [
    "# Delivery leads and gaps",
    "",
    "This is a Host navigation projection, not a finding. Confirm final versions and task success against the source files.",
    "User requirements: observations/user-inputs/INDEX.tsv (in order); initial task: briefing/task/initial-input.txt.",
    "",
  ];
  for (const side of ["baseline", "candidate"] as const) {
    lines.push(`## ${side}`);
    if (side === "candidate" && input.snapshotStatus !== "complete") {
      lines.push(`Candidate snapshot ${input.snapshotStatus}; sealed delivery unavailable. Do not substitute a mutable workspace.`, "");
      continue;
    }
    const candidates = input.links.filter((link) => link.side === side);
    const openable = [...new Set(input.openableSources[side])];
    const images = input.media.filter((item) => item.side === side);
    if (candidates.length === 0 && images.length === 0 && openable.length === 0) lines.push("No indexed delivery lead; inspect the full sources before treating it as absent.");
    for (const path of openable.slice(0, 6)) lines.push(`- ${path} (openable delivery lead; confirm final version)`);
    if (openable.length > 6) lines.push(`- ${openable.length - 6} more openable leads: finals/ or candidate/`);
    for (const link of candidates.slice(0, 6)) {
      lines.push(`- ${link.shortRef ?? "unreferenced"} ${link.inspectPath}${link.origin ? ` (${link.origin})` : ""}`);
    }
    if (candidates.length > 6) lines.push(`- ${candidates.length - 6} more indexed leads: briefing/facts/comparison-links.json`);
    for (const item of images.slice(0, 6)) {
      lines.push(`- ${item.shortRef ?? "unreferenced"} ${item.inspectPath}: ${item.available ? "available" : "unavailable"} media (${item.mediaType})`);
    }
    if (images.length > 6) lines.push(`- ${images.length - 6} more media: briefing/facts/media.json`);
    lines.push("");
  }
  lines.push("## Checks to resolve", "");
  if (input.snapshotStatus !== "complete") lines.push("- Determine what can be concluded without a complete sealed candidate snapshot.");
  if (!input.links.some((link) => link.side === "baseline") && input.openableSources.baseline.length === 0) lines.push("- Locate the historical final delivery, or report the evidence gap.");
  if (input.snapshotStatus === "complete" && !input.links.some((link) => link.side === "candidate") && input.openableSources.candidate.length === 0) lines.push("- Locate the candidate final delivery, or report the evidence gap.");
  if (input.media.some((item) => !item.available)) lines.push("- Check unavailable media before making visual claims.");
  if (input.omitted > 0) lines.push(`- ${input.omitted} leads were omitted by the bounded index; inspect the full sources if they could change the result.`);
  if (input.changedPathsIndexed > 0) lines.push("- Check which changed paths are final deliverables rather than intermediate files.");
  if (lines.at(-1) === "") lines.push("- Verify both final deliveries against the user's success criteria.");
  lines.push("", "Full sources: briefing/facts/evidence-index.json, briefing/facts/media.json, briefing/candidate/process-index.tsv, observations/INDEX.md, finals/, and candidate/.", "");
  return lines.join("\n");
}

function processIndex(events: readonly EventEnvelope[]): string {
  const lines = ["sequence\ttype\toccurred_at\tpayload_bytes\tevidence_ref"];
  for (const event of events) {
    lines.push([event.sequence, event.type, event.occurredAt, Buffer.byteLength(JSON.stringify(event.payload)), `event:${event.eventId}`].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function comparisonLinks(input: {
  attemptRoot: string;
  experimentRoot: string;
  workspaceRoot: string;
  dataDir?: string;
  taskCase: TaskCase;
  record: RunRecord;
  context: ComparisonContext | ComparisonFactsContext;
  events: readonly EventEnvelope[];
  artifacts: readonly ArtifactManifest[];
}): Promise<{ links: ComparisonLink[]; changedPathsIndexed: number; omitted: number }> {
  const ranked: { rank: number; link: ComparisonLink; changedPath?: boolean }[] = [];
  const seen = new Set<string>();
  const push = (rank: number, link: ComparisonLink, changedPath = false): void => {
    const key = `${link.side}\0${link.inspectPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    ranked.push({ rank, link, changedPath });
  };
  const controllerRoot = join(input.experimentRoot, "runs", input.record.attempt.runId, "controller-briefing");
  if (input.taskCase.baseline.status === "available") {
    const lastAssistant = [...input.taskCase.transcript].reverse().find((message) => message.role === "assistant");
    const inspectPath = lastAssistant ? `history/transcript/${lastAssistant.id}.txt` : "history/outline.tsv";
    const absolute = join(controllerRoot, ...inspectPath.split("/"));
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile()) push(0, {
      side: "baseline",
      inspectPath,
      reportHref: slash(relative(input.experimentRoot, absolute)),
      mediaType: "text/plain",
      byteLength: info.size,
      ...(input.taskCase.baseline.evidenceRefs[0] ? { evidenceRef: input.taskCase.baseline.evidenceRefs[0] } : {}),
    });
  }
  for (const link of await buildSealedBaselineImageLinks({
    attemptRoot: input.attemptRoot,
    experimentRoot: input.experimentRoot,
    taskCase: input.taskCase,
    runId: input.record.attempt.runId,
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  })) {
    push(0, link);
  }
  const turns = input.context.reportFacts.activity.candidateTurns;
  if (typeof turns === "number" && turns > 0) {
    const inspectPath = `turns/${String(turns).padStart(4, "0")}/visible.txt`;
    const absolute = join(controllerRoot, "run", inspectPath);
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile()) push(1, {
      side: "candidate",
      inspectPath,
      reportHref: slash(relative(input.experimentRoot, absolute)),
      mediaType: "text/plain",
      byteLength: info.size,
      ...(input.context.candidates[0]?.evidenceRefs[0] ? { evidenceRef: input.context.candidates[0].evidenceRefs[0] } : {}),
    });
  }
  const changedPaths = input.context.reportFacts.delivery.changedPaths.filter(isComparisonChangedPath);
  for (const path of changedPaths) {
    const absolute = join(input.workspaceRoot, ...path.split("/"));
    const info = await stat(absolute).catch(() => undefined);
    const imagePath = isComparisonImagePath(path);
    if (!info?.isFile() && !imagePath) continue;
    const evidenceRef = input.record.outcome.task.evidenceRefs[0]
      ?? (input.events.at(-1) ? `event:${input.events.at(-1)!.eventId}` : undefined);
    const mediaType = mediaTypeForComparisonPath(path);
    push(2, {
      side: "candidate",
      inspectPath: `candidate/${path}`,
      ...(info?.isFile() ? { reportHref: slash(relative(input.experimentRoot, absolute)), byteLength: info.size } : {}),
      path,
      ...(mediaType ? { mediaType } : {}),
      ...(evidenceRef ? { evidenceRef } : {}),
    }, true);
  }
  for (const manifest of input.artifacts) {
    const mediaType = manifestImageType(manifest);
    const media = mediaType ?? "";
    const rank = media.startsWith("image/") || media.includes("html") ? 3 : 4;
    push(rank, {
      side: "candidate",
      inspectPath: `evidence/${manifest.artifactId}`,
      reportHref: slash(relative(input.experimentRoot, join(input.attemptRoot, "evidence", manifest.artifactId))),
      artifactId: manifest.artifactId,
      ...(mediaType ? { mediaType } : {}),
      byteLength: manifest.byteLength,
      evidenceRef: `artifact:${manifest.artifactId}`,
    });
  }
  ranked.sort((left, right) => left.rank - right.rank);
  const selected = ranked.slice(0, MAX_COMPARISON_LINKS);
  return {
    links: selected.map((item) => item.link),
    changedPathsIndexed: selected.filter((item) => item.changedPath).length,
    omitted: ranked.length - selected.length + (input.context.reportFacts.delivery.changedPaths.length - changedPaths.length),
  };
}


function manifestImageType(manifest: ArtifactManifest): string | undefined {
  if (manifest.mediaType?.startsWith("image/")) return manifest.mediaType;
  return mediaTypeForComparisonPath(manifest.path || manifest.artifactId);
}


function slash(path: string): string { return path.replaceAll("\\", "/"); }

async function loadGitSinkBriefing(experimentRoot: string, runId: string, workspaceRoot: string): Promise<{ refsListing: string; catalogJson: string }> {
  const location = replicaWorkspaceLocation(experimentRoot, runId, workspaceRoot);
  if (!location) throw new Error('Candidate workspace is outside the selected experiment.');
  const sinkRoot = gitSinkRoot(location.providerRoot, runId);
  await finalizeGitSinkCatalog(sinkRoot);
  const catalog = await readGitSinkManifest(sinkRoot) ?? {
    schemaVersion: 2 as const,
    sinkId: runId,
    treeRoot: sinkRoot,
    sinkRoot,
    status: "missing" as const,
    finalized: true,
    repos: [],
    skipped: [],
    errors: ["manifest_missing"],
  };
  if (!Value.Check(GitSinkManifestSchema, catalog)) throw new Error("Git sink catalog does not satisfy GitSinkManifestSchema.");
  return { refsListing: await gitSinkRefsListing(sinkRoot), catalogJson: `${JSON.stringify(catalog, null, 2)}\n` };
}
