import { mkdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { ComparisonContext } from "../agents/comparison-agent.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { ComparisonBriefingContextSchema, ComparisonLinksSchema, type ComparisonLinkRecord, type EventEnvelope, type RunRecord, type TaskCase } from "../core/schema.js";
import type { ArtifactManifest } from "../infrastructure/store/experiment-store.js";

export type ComparisonPhase = "plan" | "report";
export type ComparisonPlanStatus = "ready" | "partial_unverified" | "unavailable";

export type ComparisonLink = ComparisonLinkRecord;

export function newComparisonAttempt(experimentRoot: string): { attemptId: string; attemptRoot: string } {
  const attemptId = randomUUID();
  return { attemptId, attemptRoot: join(experimentRoot, "comparison-attempts", attemptId) };
}

export async function writeComparisonBriefing(input: {
  attemptRoot: string;
  experimentRoot: string;
  workspaceRoot: string;
  taskCase: TaskCase;
  record: RunRecord;
  context: ComparisonContext;
  events: readonly EventEnvelope[];
  artifacts: readonly ArtifactManifest[];
}): Promise<{ indexMarkdown: string; links: ComparisonLink[]; fileDigests: Record<string, string> }> {
  const briefingRoot = join(input.attemptRoot, "briefing");
  await Promise.all([
    mkdir(join(briefingRoot, "task"), { recursive: true }),
    mkdir(join(briefingRoot, "candidate"), { recursive: true }),
    mkdir(join(briefingRoot, "facts"), { recursive: true }),
    mkdir(join(input.attemptRoot, "work"), { recursive: true }),
    mkdir(join(input.attemptRoot, "scratch"), { recursive: true }),
    mkdir(join(input.attemptRoot, "evidence"), { recursive: true }),
  ]);
  const links = await comparisonLinks(input);
  if (!Value.Check(ComparisonLinksSchema, links)) throw new Error("Comparison links do not satisfy ComparisonLinksSchema.");
  if (!Value.Check(ComparisonBriefingContextSchema, input.context)) throw new Error("Comparison context does not satisfy ComparisonBriefingContextSchema.");
  const indexMarkdown = comparisonIndex();
  const files: Record<string, string> = {
    "INDEX.md": indexMarkdown,
    "task/initial-input.txt": input.taskCase.privacy.allowModelText ? input.taskCase.initialInput.text : "[REDACTED]",
    "candidate/process-index.tsv": processIndex(input.events),
    "facts/context.json": `${JSON.stringify(input.context, null, 2)}\n`,
    "facts/comparison-links.json": `${JSON.stringify(links, null, 2)}\n`,
  };
  for (const [path, body] of Object.entries(files)) await writeAtomic(join(briefingRoot, ...path.split("/")), body);
  return { indexMarkdown, links, fileDigests: Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha256(body)])) };
}

export function comparisonOrientation(input: {
  phase: ComparisonPhase;
  initialInput: string;
  briefingRoot: string;
  indexMarkdown: string;
  baselineAvailable: boolean;
  candidateAvailable: boolean;
  planStatus: ComparisonPlanStatus;
  planFailureKind?: string;
  planDigest?: string;
}): string {
  return [
    `phase=${input.phase}`,
    `initialTask=${input.initialInput}`,
    `baselineEvidence=${input.baselineAvailable ? "available" : "unavailable"}`,
    `candidateEvidence=${input.candidateAvailable ? "available" : "unavailable"}`,
    `planStatus=${input.planStatus}`,
    ...(input.planFailureKind ? [`planFailureKind=${input.planFailureKind}`] : []),
    ...(input.planDigest ? [`planDigest=${input.planDigest}`] : []),
    `briefingRoot=${input.briefingRoot}`,
    "",
    "# INDEX.md",
    input.indexMarkdown,
  ].join("\n");
}

function comparisonIndex(): string {
  return [
    "# Comparison briefing map",
    "",
    "Read only what can change the comparison. The historical and candidate process bodies are mounted separately; this directory contains navigation and Host facts.",
    "",
    "- task/initial-input.txt — frozen initial task",
    "- facts/context.json — bounded Host projection, not a substitute for direct evidence",
    "- facts/comparison-links.json — inspect paths and stable report links",
    "- candidate/process-index.tsv — complete run event index including post-settlement events",
    "- history/outline.tsv and history/transcript/ — frozen historical conversation (read-only mount)",
    "- turns/ — candidate settled-turn briefing (read-only mount)",
    "- candidate/ — retained candidate workspace (read-only mount)",
    "- evidence/ — materialized Host artifacts (read-only mount)",
    "- work/comparison-plan.md — revisable Planner/Reporter working state",
    "- scratch/ — unrestricted temporary analysis files; PowerShell starts here",
    "",
  ].join("\n");
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
  taskCase: TaskCase;
  record: RunRecord;
  context: ComparisonContext;
  events: readonly EventEnvelope[];
  artifacts: readonly ArtifactManifest[];
}): Promise<ComparisonLink[]> {
  const links: ComparisonLink[] = [];
  const controllerRoot = join(input.experimentRoot, "runs", input.record.attempt.runId, "controller-briefing");
  if (input.taskCase.baseline.status === "available") {
    const lastAssistant = [...input.taskCase.transcript].reverse().find((message) => message.role === "assistant");
    const inspectPath = lastAssistant ? `history/transcript/${lastAssistant.id}.txt` : "history/outline.tsv";
    const absolute = join(controllerRoot, ...inspectPath.split("/"));
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile()) links.push({
      side: "baseline",
      inspectPath,
      reportHref: slash(relative(input.experimentRoot, absolute)),
      mediaType: "text/plain",
      byteLength: info.size,
      ...(input.taskCase.baseline.evidenceRefs[0] ? { evidenceRef: input.taskCase.baseline.evidenceRefs[0] } : {}),
    });
  }
  const turns = input.context.reportFacts.activity.candidateTurns;
  if (typeof turns === "number" && turns > 0) {
    const inspectPath = `turns/${String(turns).padStart(4, "0")}/visible.txt`;
    const absolute = join(controllerRoot, "run", inspectPath);
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isFile()) links.push({
      side: "candidate",
      inspectPath,
      reportHref: slash(relative(input.experimentRoot, absolute)),
      mediaType: "text/plain",
      byteLength: info.size,
      ...(input.context.candidates[0]?.evidenceRefs[0] ? { evidenceRef: input.context.candidates[0].evidenceRefs[0] } : {}),
    });
  }
  for (const manifest of input.artifacts) {
    links.push({
      side: "candidate",
      inspectPath: `evidence/${manifest.artifactId}`,
      reportHref: slash(relative(input.experimentRoot, join(input.attemptRoot, "evidence", manifest.artifactId))),
      artifactId: manifest.artifactId,
      ...(manifest.mediaType ? { mediaType: manifest.mediaType } : {}),
      byteLength: manifest.byteLength,
      evidenceRef: `artifact:${manifest.artifactId}`,
    });
  }
  for (const path of input.context.reportFacts.delivery.changedPaths) {
    const absolute = join(input.workspaceRoot, ...path.split("/"));
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) continue;
    const evidenceRef = input.record.outcome.task.evidenceRefs[0]
      ?? (input.events.at(-1) ? `event:${input.events.at(-1)!.eventId}` : undefined);
    links.push({
      side: "candidate",
      inspectPath: `candidate/${path}`,
      reportHref: slash(relative(input.experimentRoot, absolute)),
      path,
      byteLength: info.size,
      ...(evidenceRef ? { evidenceRef } : {}),
    });
  }
  return links;
}

function slash(path: string): string { return path.replaceAll("\\", "/"); }
