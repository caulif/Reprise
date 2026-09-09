import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathContainedBy } from "../core/paths.js";
import { sha256, writeAtomic } from "../core/identity.js";
import { CONTROLLER_PROMPT_DIGEST, CONTROLLER_TURN_PROMPTS, type SteeringContext } from "../agents/controller-agent.js";
import { record, text } from "../core/json.js";
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

export type ControllerViewSurface = "empty" | "unavailable" | "waiting" | "failed" | "completed" | "aborted";

export function controllerViewSurface(
  settlementStatus: string | undefined,
  visibleText: string | undefined,
  allowModelText: boolean,
): ControllerViewSurface {
  if (!allowModelText) return "unavailable";
  if (settlementStatus === "waiting_input") return "waiting";
  if (settlementStatus === "failed") return "failed";
  if (settlementStatus === "aborted") return "aborted";
  if (settlementStatus === "completed") return visibleText?.trim() ? "completed" : "empty";
  return visibleText?.trim() ? "completed" : "empty";
}

export function renderIndexMarkdown(latestTurnRelative: string | undefined): string {
  const latest = latestTurnRelative ?? "(none — opening; THIS-TURN.txt is empty)";
  return [
    "# Controller briefing map",
    "",
    "Host-owned, invisible to the candidate. `project/` is a read-only mount of the isolated replica.",
    "Read with workspace tools (`read`, `ls`, `grep`, `find`). There is no `read_observation`.",
    "",
    "Historical user requirements:",
    "- history/user-inputs/INDEX.tsv — complete user demand in session order",
    "- history/user-inputs/{turn-id}.txt — that user input body",
    "- history/initial-input.txt — frozen first user task sentence",
    "- history/outline.tsv — id, role, bytes, after_first_deliverable",
    "- history/transcript/{id}.txt — full text for that outline id (user or assistant)",
    "",
    "Historical agent discoveries (not this user's prior knowledge): outline rows with role=assistant and their transcript files.",
    "",
    "Current candidate facts:",
    "- view.txt — Host snapshot of the user-visible surface; read this before other details",
    "- permissions.txt — Controller tools stay read-only; candidate runtime uses Host-fixed historical session settings",
    "- run/sent-user-messages.jsonl — user messages already submitted this run",
    "- run/turns/NNNN/visible.txt, event-index.tsv, changed-paths.txt — one settled candidate turn",
    "- THIS-TURN.txt — relative path of the latest turn directory, empty before the first settlement",
    "- project/ — current replica; project/imported-inputs/ may be absent",
    "- project-root.txt, replay.txt, manifest.json — Host path and isolation facts",
    "",
    `Latest turn: ${latest}`,
    "",
  ].join("\n");
}

export function controllerPromptContent(input: {
  phase: "opening" | "steering";
  briefingRoot: string;
  indexMarkdown: string;
}): string {
  const decision = input.phase === "opening" ? CONTROLLER_TURN_PROMPTS.opening : CONTROLLER_TURN_PROMPTS.steering;
  return `${decision}\n\nbriefingRoot=${input.briefingRoot}\nphase=${input.phase}\n\n# INDEX.md\n${input.indexMarkdown}`;
}

function visibleText(text: string, allowModelText: boolean): string {
  return allowModelText ? text : "[REDACTED]";
}

function renderUserInputIndexTsv(transcript: TaskCase["transcript"]): string {
  const lines = ["turn_id\torder\trole\tsource\tpath\tattachments\trelated"];
  let order = 0;
  for (const message of transcript) {
    if (message.role !== "user") continue;
    order += 1;
    const index = transcript.findIndex((entry) => entry.id === message.id);
    const next = index >= 0 ? transcript[index + 1] : undefined;
      const related = next?.role === "assistant" ? `history/transcript/${next.id}.txt` : "missing";
    lines.push(
      `${message.id}\t${order}\tuser\thistorical_user\thistory/user-inputs/${message.id}.txt\tmissing\t${related}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export type CandidateWriteScope = "allowed" | "workspace" | "denied" | "unconfirmed";

function historicalCandidatePermissions(taskCase: TaskCase): {
  source: "historical_session" | "unconfirmed";
  sandbox: string;
  permissionMode: string;
  approvalPolicy: string;
  network: string;
  writes: CandidateWriteScope;
  uncertainty: string;
} {
  const ctx = record(taskCase.taskContext);
  const fromEvents = permissionFieldsFromRecords(taskCase.historicalEvents);
  const sandbox = text(ctx.sandbox) ?? fromEvents.sandbox ?? "";
  const permissionMode = text(ctx.permissionMode) ?? fromEvents.permissionMode ?? "";
  const approvalPolicy = text(ctx.approvalPolicy) ?? fromEvents.approvalPolicy ?? "";
  const network = text(ctx.network) ?? fromEvents.network ?? "";
  const missing = [
    sandbox ? undefined : "sandbox",
    permissionMode ? undefined : "permissionMode",
    approvalPolicy ? undefined : "approvalPolicy",
  ].filter((item): item is string => Boolean(item));
  const recorded = Boolean(sandbox || permissionMode || approvalPolicy || network);
  return {
    source: recorded ? "historical_session" : "unconfirmed",
    sandbox: sandbox || "unconfirmed",
    permissionMode: permissionMode || "(none)",
    approvalPolicy: approvalPolicy || "unconfirmed",
    network: network || "(none)",
    writes: candidateWrites(sandbox, permissionMode),
    uncertainty: recorded && missing.length === 0
      ? "(none)"
      : `${missing.join(",") || "historical_settings_incomplete"}; host_safety_ceiling_applies`,
  };
}

function permissionFieldsFromRecords(events: readonly unknown[]): {
  sandbox?: string;
  permissionMode?: string;
  approvalPolicy?: string;
  network?: string;
} {
  let sandbox: string | undefined;
  let permissionMode: string | undefined;
  let approvalPolicy: string | undefined;
  let network: string | undefined;
  for (const event of events) {
    const row = record(event);
    const payload = record(row.payload);
    sandbox ??= text(row.sandbox) ?? text(payload.sandbox) ?? text(payload.sandbox_policy);
    permissionMode ??= text(row.permissionMode) ?? text(payload.permissionMode) ?? text(payload["permission-mode"]);
    approvalPolicy ??= text(row.approvalPolicy) ?? text(payload.approvalPolicy) ?? text(payload.approval_policy);
    network ??= text(row.network) ?? text(payload.network);
  }
  return {
    ...(sandbox ? { sandbox } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(network ? { network } : {}),
  };
}

function candidateWrites(sandbox: string, permissionMode: string): CandidateWriteScope {
  const sandboxNorm = sandbox.toLowerCase();
  if (sandboxNorm.includes("full-access") || permissionMode === "bypassPermissions") return "allowed";
  if (sandboxNorm === "workspace-write" || permissionMode === "acceptEdits") return "workspace";
  if (sandboxNorm === "read-only" || permissionMode === "plan") return "denied";
  return "unconfirmed";
}

function renderPermissionsTxt(taskCase: TaskCase): string {
  const candidate = historicalCandidatePermissions(taskCase);
  const privacy = taskCase.privacy;
  return [
    "# Controller tools",
    "controller.writes=denied",
    "controller.project=read_only",
    "",
    "# Candidate runtime",
    `candidate.source=${candidate.source}`,
    `candidate.sandbox=${candidate.sandbox}`,
    `candidate.permissionMode=${candidate.permissionMode}`,
    `candidate.approvalPolicy=${candidate.approvalPolicy}`,
    `candidate.network=${candidate.network}`,
    `candidate.writes=${candidate.writes}`,
    `candidate.uncertainty=${candidate.uncertainty}`,
    `privacy.allowModelText=${privacy.allowModelText ? "1" : "0"}`,
    `privacy.allowBinary=${privacy.allowBinary ? "1" : "0"}`,
    "",
  ].join("\n");
}

function renderViewSnapshot(input: {
  phase: "opening" | "steering";
  surface: "empty" | "unavailable" | "waiting" | "failed" | "completed" | "aborted";
  latestTurnRelative?: string;
  visibleText?: string;
  changedPaths?: readonly string[];
  prompt?: string;
}): string {
  if (input.phase === "opening") {
    return [
      "surface=empty",
      "candidate_turn=none",
      "user_visible=empty",
      "deliverable_paths=(none)",
      "prompt=(none)",
      "user_inputs=history/user-inputs/INDEX.tsv",
      "permissions=permissions.txt",
      "",
    ].join("\n");
  }
  const paths = input.changedPaths?.length ? input.changedPaths.join("\n") : "(none)";
  const visible = input.visibleText?.trim() ? input.visibleText.trimEnd() : "(empty)";
  const prompt = input.prompt?.trim() ? input.prompt.trimEnd() : "(none)";
  return [
    `surface=${input.surface}`,
    `latest_turn=${input.latestTurnRelative ?? ""}`,
    "permissions=permissions.txt",
    `prompt=${prompt === "(none)" ? "(none)" : "see below"}`,
    "",
    "# Visible assistant text",
    visible,
    "",
    "# Visible prompt",
    prompt,
    "",
    "# Deliverable paths",
    paths,
    "",
  ].join("\n");
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
  const userInputs = join(history, "user-inputs");
  await mkdir(userInputs, { recursive: true });
  for (const message of input.taskCase.transcript) {
    if (message.role !== "user") continue;
    await writeAtomic(join(userInputs, `${message.id}.txt`), visibleText(message.text, allow));
  }
  await writeAtomic(join(userInputs, "INDEX.tsv"), renderUserInputIndexTsv(input.taskCase.transcript));
  await writeAtomic(join(input.briefingRoot, "permissions.txt"), renderPermissionsTxt(input.taskCase));
  await writeAtomic(join(input.briefingRoot, "view.txt"), renderViewSnapshot({ phase: "opening", surface: "empty" }));
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
  surface?: "empty" | "unavailable" | "waiting" | "failed" | "completed" | "aborted";
  prompt?: string;
}): Promise<{ indexMarkdown: string; fileDigests: Record<string, string>; turnRelative: string }> {
  const turnRelative = `run/turns/${String(input.turnIndex).padStart(4, "0")}`;
  const turnDir = join(input.briefingRoot, ...turnRelative.split("/"));
  await mkdir(turnDir, { recursive: true });
  const visible = visibleText(input.visibleText, input.allowModelText);
  await writeAtomic(join(turnDir, "visible.txt"), visible);
  const eventIndex = ["sequence\ttype\tevent_id\tmodel_visible", ...input.events.map((event) => `${event.sequence}\t${event.type}\t${event.eventId}\t${input.allowModelText ? "1" : "0"}`)];
  await writeAtomic(join(turnDir, "event-index.tsv"), `${eventIndex.join("\n")}\n`);
  await writeAtomic(join(turnDir, "changed-paths.txt"), `${input.changedPaths.join("\n")}${input.changedPaths.length ? "\n" : ""}`);
  await writeAtomic(join(input.briefingRoot, "THIS-TURN.txt"), `${turnRelative}\n`);
  const surface = input.surface
    ?? (!input.allowModelText ? "unavailable" : input.visibleText.trim() ? "completed" : "empty");
  await writeAtomic(
    join(input.briefingRoot, "view.txt"),
    renderViewSnapshot({
      phase: "steering",
      surface,
      latestTurnRelative: turnRelative,
      visibleText: visible,
      changedPaths: input.changedPaths,
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }),
  );
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
    "view.txt",
    "permissions.txt",
    "history/user-inputs/INDEX.tsv",
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
