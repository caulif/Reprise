import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sha256, writeAtomic } from "../core/identity.js";
import type { ControllerUnderstanding, SteeringContext } from "../agents/controller-agent.js";
import { Value } from "@sinclair/typebox/value";
import { ControllerUnderstandingLedgerSchema, type ControllerUnderstandingDelta, type ControllerUnderstandingLedger } from "../core/schema.js";
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
  const briefing = briefingRoot.replaceAll("\\", "/").toLowerCase();
  const replica = replicaRoot.replaceAll("\\", "/").toLowerCase();
  if (briefing === replica || briefing.startsWith(`${replica}/`)) {
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
    "Paths:",
    "- history/initial-input.txt — frozen first user task sentence",
    "- history/outline.tsv — id, role, bytes, after_first_deliverable (1 after first non-empty assistant text in transcript order)",
    "- history/transcript/{id}.txt — full text for that outline id",
    "- project-root.txt — isolated replica absolute path",
    "- replay.txt — sourceRootKind, historicalCwd, isolation",
    "- run/sent-user-messages.jsonl — user messages already submitted this run",
    "- run/turns/NNNN/visible.txt, events.jsonl, event-index.tsv, changed-paths.txt — one settled candidate turn",
    "- THIS-TURN.txt — relative path of the latest turn directory, empty before the first settlement",
    "- controller-task-understanding.md — Controller's private, Host-persisted task and collaborator understanding",
    "- controller-understanding.json — mutable, schema-validated semantic ledger",
    "- manifest.json — deterministic digest/size index for briefing files",
    "",
    `Latest turn: ${latest}`,
    "",
  ].join("\n");
}

const OPENING_DECISION = [
  "# Decision (opening)",
  "Read history/initial-input.txt, project-root.txt, and replay.txt.",
  "Read outline.tsv and transcript files with after_first_deliverable=0 if you need tone or constraints stated before a first deliverable.",
  "Do not put after_first_deliverable=1 user sentences into the first message.",
  "Return send. done is invalid.",
].join("\n");

const STEERING_DECISION = [
  "# Decision (after a settled candidate turn)",
  "Read THIS-TURN.txt and the files it names, then inspect project/ for current artifacts.",
  "History is for whether this user would stop or steer, not a queue to send in order.",
  "You may send or done. Before done/satisfied, read this turn's output and the current deliverable files. The Host does not reject done if you skip reads.",
  "Treat files on disk as truth if they disagree with earlier session summaries.",
  "Read controller-task-understanding.md before deciding. It is a private semantic ledger, not a script; update your understanding from the current turn before choosing send or done.",
].join("\n");

export function controllerPromptContent(input: {
  phase: "opening" | "steering";
  briefingRoot: string;
  indexMarkdown: string;
}): string {
  const decision = input.phase === "opening" ? OPENING_DECISION : STEERING_DECISION;
  return `${decision}\n\nbriefingRoot=${input.briefingRoot}\nphase=${input.phase}\n\n# INDEX.md\n${input.indexMarkdown}`;
}

export async function writeControllerUnderstanding(
  briefingRoot: string,
  understanding: ControllerUnderstanding,
): Promise<string> {
  const body = [
    "# Controller task understanding",
    "",
    understanding.markdown.trim(),
    "",
    "## Source messages",
    ...understanding.sourceMessageIds.map((id) => `- ${id}`),
    "",
    "## Unresolved actions at capture time",
    ...(understanding.unresolvedActions.length
      ? understanding.unresolvedActions.map((action) => `- ${action}`)
      : ["- (none reported)"]),
    "",
  ].join("\n");
  const path = join(briefingRoot, "controller-task-understanding.md");
  const ledger: ControllerUnderstandingLedger = {
    schemaVersion: 1,
    baseMarkdown: understanding.markdown.trim(),
    sourceMessageIds: understanding.sourceMessageIds,
    confirmedFacts: [],
    acceptanceSignals: [],
    unresolvedActions: understanding.unresolvedActions,
  };
  await writeAtomic(join(briefingRoot, "controller-understanding.json"), JSON.stringify(ledger, null, 2));
  await writeAtomic(path, body);
  await writeBriefingManifest(briefingRoot);
  return path;
}

export async function applyControllerUnderstandingDelta(
  briefingRoot: string,
  delta: ControllerUnderstandingDelta,
): Promise<string> {
  const ledgerPath = join(briefingRoot, "controller-understanding.json");
  const current: unknown = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (!Value.Check(ControllerUnderstandingLedgerSchema, current)) throw new Error("Controller understanding ledger is malformed.");
  const ledger = current;
  const update = (old: string[], next: string[] | undefined): string[] =>
    next === undefined ? old : delta.mode === "replace" ? next : [...new Set([...old, ...next])];
  const updated: ControllerUnderstandingLedger = {
    ...ledger,
    confirmedFacts: update(ledger.confirmedFacts, delta.confirmedFacts),
    acceptanceSignals: update(ledger.acceptanceSignals, delta.acceptanceSignals),
    unresolvedActions: update(ledger.unresolvedActions, delta.unresolvedActions),
  };
  await writeAtomic(ledgerPath, JSON.stringify(updated, null, 2));
  const section = (title: string, values: string[]) => [
    `## ${title}`,
    ...(values.length ? values.map((value) => `- ${value}`) : ["- (none)"]),
    "",
  ];
  const body = [
    "# Controller task understanding", "", updated.baseMarkdown, "",
    ...section("Confirmed facts", updated.confirmedFacts),
    ...section("Acceptance signals", updated.acceptanceSignals),
    "## Source messages", ...updated.sourceMessageIds.map((id) => `- ${id}`), "",
    ...section("Unresolved actions", updated.unresolvedActions),
  ].join("\n");
  await writeAtomic(join(briefingRoot, "controller-task-understanding.md"), body);
  await writeBriefingManifest(briefingRoot);
  return join(briefingRoot, "controller-task-understanding.md");
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
    "controller-task-understanding.md",
    "controller-understanding.json",
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
