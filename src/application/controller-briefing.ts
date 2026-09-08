import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathContainedBy } from "../core/paths.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { CONTROLLER_PROMPT_DIGEST, type SteeringContext } from "../agents/controller-agent.js";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import type { SourceRootKind } from "./replay-conditions.js";

export const CONTROLLER_PROJECT_MOUNT = "project";

const ISOLATION =
  "Writes stay in the isolated replica and never land in the original user directory.";

export type OutlineRow = {
  id: string;
  role: string;
  bytes: number;
  afterFirstDeliverable: boolean;
};

export function controllerBriefingRoot(experimentRoot: string, runId: string): string {
  return join(experimentRoot, "runs", runId, "controller-briefing");
}

export function assertBriefingOutsideReplica(briefingRoot: string, replicaRoot: string): void {
  if (pathContainedBy(replicaRoot, briefingRoot)) {
    throw new Error("Controller briefing must not be written inside the isolated replica.");
  }
}

export function outlineRows(transcript: TaskCase["transcript"]): OutlineRow[] {
  let deliverableSeen = false;
  const rows: OutlineRow[] = [];
  for (const message of transcript) {
    rows.push({
      id: message.id,
      role: message.role,
      bytes: Buffer.byteLength(message.text),
      afterFirstDeliverable: deliverableSeen,
    });
    if (message.role === "assistant" && message.text.trim().length > 0) deliverableSeen = true;
  }
  return rows;
}

export function renderOutlineTsv(rows: readonly OutlineRow[]): string {
  const lines = ["id\trole\tbytes\tafter_first_deliverable"];
  for (const row of rows) {
    lines.push(`${row.id}\t${row.role}\t${row.bytes}\t${row.afterFirstDeliverable ? "1" : "0"}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderIndexMarkdown(latestTurnRelative: string | undefined): string {
  const latest = latestTurnRelative ?? "(none — opening; THIS-TURN.txt is empty)";
  return [
    "# Controller briefing map",
    "",
    "This directory is Host-owned and invisible to the candidate. `project/` is a read-only mount of the isolated replica.",
    "Read files with workspace tools (`read`, `ls`, `grep`, `find`). Do not expect `read_observation`.",
    "",
    "Fact kinds (do not mix):",
    "- historical user requirements: history/initial-input.txt and outline rows with role=user",
    "- historical agent discoveries: outline rows with role=assistant; not this user's prior knowledge",
    "- current candidate facts: run/turns/ and project/",
    "",
    "Paths:",
    "- history/initial-input.txt — frozen first user task sentence",
    "- history/outline.tsv — id, role, bytes, after_first_deliverable (1 after first non-empty assistant text in transcript order)",
    "- history/transcript/{id}.txt — full text for that outline id",
    "- project-root.txt — isolated replica absolute path",
    "- replay.txt — sourceRootKind, historicalCwd, isolation",
    "- run/sent-user-messages.jsonl — user messages already submitted this run",
    "- run/turns/NNNN/visible.txt, events.jsonl, event-index.tsv, changed-paths.txt — one settled candidate turn",
    "- THIS-TURN.txt — relative path of the latest turn directory, empty before the first settlement",
    "- manifest.json — deterministic digest/size index for briefing files",
    "- project/imported-inputs/ — files the frozen user sentence named that lived outside historical cwd (directory may be absent)",
    "",
    `Latest turn: ${latest}`,
    "",
  ].join("\n");
}

const OPENING_DECISION = [
  "# Decision (opening)",
  "This first Invocation investigates history and returns the opening send in the same Controller Session.",
  "Read history/initial-input.txt, project-root.txt, replay.txt, outline.tsv, and transcript files as needed for goals, constraints, and collaboration habits.",
  "Treat role=user as this user's requirements; role=assistant as historical agent discoveries, not prior user knowledge.",
  "Do not put after_first_deliverable=1 user sentences into the first message.",
  "Return send. done is invalid.",
].join("\n");

const STEERING_DECISION = [
  "# Decision (after a settled candidate turn)",
  "Continue the same Controller Session. Only add facts from this settled turn and current project/ artifacts.",
  "Read THIS-TURN.txt and the files it names, then inspect project/ for current artifacts.",
  "History is for whether this user would stop or steer, not a queue to send in order. Exhausting historical user sentences is not done/satisfied.",
  "You may send or done. Host does not reject done for unread files or a missing ledger.",
  "Treat files on disk as truth if they disagree with earlier session summaries.",
].join("\n");

export function controllerPromptContent(input: {
  phase: "opening" | "steering";
  briefingRoot: string;
  indexMarkdown: string;
}): string {
  const decision = input.phase === "opening" ? OPENING_DECISION : STEERING_DECISION;
  return `${decision}\n\nbriefingRoot=${input.briefingRoot}\nphase=${input.phase}\n\n# INDEX.md\n${input.indexMarkdown}`;
}

function visibleText(text: string, allowModelText: boolean): string {
  return allowModelText ? text : "[REDACTED]";
}

export async function writeOpeningBriefing(input: {
  briefingRoot: string;
  replicaRoot: string;
  taskCase: TaskCase;
  sourceRootKind: SourceRootKind;
  historicalCwd?: string;
}): Promise<{ indexMarkdown: string; fileDigests: Record<string, string> }> {
  assertBriefingOutsideReplica(input.briefingRoot, input.replicaRoot);
  const history = join(input.briefingRoot, "history");
  const transcriptDir = join(history, "transcript");
  await mkdir(join(input.briefingRoot, "run", "turns"), { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  const allow = input.taskCase.privacy.allowModelText;
  await writeAtomic(join(history, "initial-input.txt"), visibleText(input.taskCase.initialInput.text, allow));
  const rows = outlineRows(input.taskCase.transcript);
  await writeAtomic(join(history, "outline.tsv"), renderOutlineTsv(rows));
  for (const message of input.taskCase.transcript) {
    await writeAtomic(join(transcriptDir, `${message.id}.txt`), visibleText(message.text, allow));
  }
  await writeAtomic(join(input.briefingRoot, "project-root.txt"), `${input.replicaRoot}\n`);
  const cwdLine = input.historicalCwd ? `historicalCwd=${input.historicalCwd}\n` : "";
  await writeAtomic(
    join(input.briefingRoot, "replay.txt"),
    `sourceRootKind=${input.sourceRootKind}\n${cwdLine}isolation=${ISOLATION}\n`,
  );
  await writeAtomic(join(input.briefingRoot, "THIS-TURN.txt"), "");
  await writeAtomic(join(input.briefingRoot, "run", "sent-user-messages.jsonl"), "");
  const indexMarkdown = renderIndexMarkdown(undefined);
  await writeAtomic(join(input.briefingRoot, "INDEX.md"), indexMarkdown);
  await writeBriefingManifest(input.briefingRoot);
  return { indexMarkdown, fileDigests: await digestBriefing(input.briefingRoot, undefined) };
}

export async function writeSettledTurnBriefing(input: {
  briefingRoot: string;
  turnIndex: number;
  visibleText: string;
  events: readonly EventEnvelope[];
  changedPaths: readonly string[];
  allowModelText: boolean;
}): Promise<{ indexMarkdown: string; fileDigests: Record<string, string>; turnRelative: string }> {
  const turnRelative = `run/turns/${String(input.turnIndex).padStart(4, "0")}`;
  const turnDir = join(input.briefingRoot, ...turnRelative.split("/"));
  await mkdir(turnDir, { recursive: true });
  await writeAtomic(join(turnDir, "visible.txt"), visibleText(input.visibleText, input.allowModelText));
  const eventLines = input.events.map((event) => JSON.stringify(input.allowModelText ? event : redactEvent(event)));
  await writeAtomic(join(turnDir, "events.jsonl"), eventLines.length ? `${eventLines.join("\n")}\n` : "");
  const eventIndex = ["sequence\ttype\tevent_id\tmodel_visible", ...input.events.map((event) => `${event.sequence}\t${event.type}\t${event.eventId}\t${input.allowModelText ? "1" : "0"}`)];
  await writeAtomic(join(turnDir, "event-index.tsv"), `${eventIndex.join("\n")}\n`);
  await writeAtomic(join(turnDir, "changed-paths.txt"), `${input.changedPaths.join("\n")}${input.changedPaths.length ? "\n" : ""}`);
  await writeAtomic(join(input.briefingRoot, "THIS-TURN.txt"), `${turnRelative}\n`);
  const indexMarkdown = renderIndexMarkdown(turnRelative);
  await writeAtomic(join(input.briefingRoot, "INDEX.md"), indexMarkdown);
  await writeBriefingManifest(input.briefingRoot);
  return { indexMarkdown, fileDigests: await digestBriefing(input.briefingRoot, turnRelative), turnRelative };
}

export async function appendSentUserMessage(
  briefingRoot: string,
  message: { id: string; text: string },
): Promise<void> {
  const path = join(briefingRoot, "run", "sent-user-messages.jsonl");
  await appendFile(path, `${JSON.stringify(message)}\n`);
}

async function digestBriefing(briefingRoot: string, turnRelative: string | undefined): Promise<Record<string, string>> {
  const relative = [
    "INDEX.md",
    "THIS-TURN.txt",
    "history/initial-input.txt",
    "history/outline.tsv",
    "project-root.txt",
    "replay.txt",
    "manifest.json",
  ];
  if (turnRelative) {
    relative.push(`${turnRelative}/visible.txt`, `${turnRelative}/changed-paths.txt`, `${turnRelative}/event-index.tsv`);
  }
  const fileDigests: Record<string, string> = {};
  for (const path of relative) {
    const body = await readFile(join(briefingRoot, path), "utf8").catch(() => "");
    fileDigests[path] = sha256(body);
  }
  return fileDigests;
}

async function writeBriefingManifest(briefingRoot: string): Promise<void> {
  const files: { path: string; bytes: number; digest: string }[] = [];
  async function visit(root: string, relative = ""): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = join(root, entry.name);
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.name !== "manifest.json") {
        const body = await readFile(full);
        files.push({ path: rel.replaceAll("\\", "/"), bytes: body.byteLength, digest: sha256(body) });
      }
    }
  }
  await visit(briefingRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeAtomic(join(briefingRoot, "manifest.json"), JSON.stringify({ schemaVersion: 1, files }, null, 2));
}

export function controllerRequestSnapshot(context: SteeringContext): Record<string, unknown> {
  return {
    schemaVersion: 1,
    toolSetVersion: 1,
    promptDigest: CONTROLLER_PROMPT_DIGEST,
    requestId: context.requestId,
    runId: context.runId,
    runState: context.runState,
    ...(context.phase ? { phase: context.phase } : {}),
    promptContent: context.promptContent ?? "",
    briefingRoot: context.briefingRoot ?? "",
    fileDigests: context.fileDigests ?? {},
    current: context.current,
    trajectory: context.trajectory,
    evidenceCatalog: context.evidenceCatalog,
    budget: context.budget,
    ...(context.replay ? { replay: context.replay } : {}),
  };
}

function redactEvent(event: EventEnvelope): EventEnvelope {
  return { ...event, payload: redactUnknown(event.payload) };
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      key === "text" && typeof child === "string" ? "[REDACTED]" : redactUnknown(child),
    ]),
  );
}
