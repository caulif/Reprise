import { mkdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { writeAtomic } from "../core/identity.js";
import {
  ObservationSessionManifestSchema,
  type EventEnvelope,
  type ObservationSessionManifest,
  type TaskCase,
} from "../core/schema.js";
import { recoveryEvidenceCatalog } from "../infrastructure/recovery-tools.js";

export const OBSERVATIONS_MOUNT = "observations";
const FILE_MAX_CHARS = 8_000;
const SECRET_NAME = /(?:^|[\\/])(?:auth\.json|\.credentials\.json|\.env|credentials|token|api[-_]?key)(?:$|[\\/])/i;

export type ObservationOwnedFile = {
  readonly relativePath: string;
  readonly text?: string;
  readonly bytes?: Buffer;
  readonly missing?: boolean;
};

export function recoveryObservationsRoot(experimentRoot: string, runId: string): string {
  return join(experimentRoot, "runs", runId, "observations");
}

function observationRelativePath(
  ref: string,
  source: "transcript" | "historical_events" | "run_events",
  transcriptId?: string,
): string {
  const folder =
    source === "transcript" ? "transcript" : source === "run_events" ? "events/run" : "events/historical";
  const stem = source === "transcript" && transcriptId ? fileStem(transcriptId) : fileStem(ref);
  return `${folder}/${stem}.json`;
}

export async function writeFrozenObservationTree(input: {
  root: string;
  taskCase: TaskCase;
  runEvents?: readonly EventEnvelope[];
  playbookText?: string;
  ownedFiles?: readonly ObservationOwnedFile[];
}): Promise<{ fileCount: number }> {
  const allowText = input.taskCase.privacy.allowModelText;
  const catalog = recoveryEvidenceCatalog(input.taskCase);
  const rows: string[] = ["ref\tsource\tpath\tbytes"];
  await mkdir(join(input.root, "transcript"), { recursive: true });
  await mkdir(join(input.root, "events", "historical"), { recursive: true });
  await mkdir(join(input.root, "events", "run"), { recursive: true });
  await mkdir(join(input.root, "artifacts"), { recursive: true });
  await mkdir(join(input.root, "files"), { recursive: true });
  await mkdir(join(input.root, "metadata"), { recursive: true });
  await mkdir(join(input.root, "source-refs"), { recursive: true });
  let fileCount = 0;
  const missing: string[] = [];
  for (const entry of catalog) {
    const observation =
      entry.source === "transcript"
        ? visibleTranscript(input.taskCase.transcript[entry.index], allowText)
        : visibleValue(input.taskCase.historicalEvents[entry.index], allowText);
    const transcriptId = entry.source === "transcript" ? input.taskCase.transcript[entry.index]?.id : undefined;
    const relative = observationRelativePath(entry.ref, entry.source, transcriptId);
    await writeObservationFile(join(input.root, ...relative.split("/")), {
      ref: entry.ref,
      source: entry.source,
      index: entry.index,
      observation,
    });
    rows.push(`${entry.ref}\t${entry.source}\t${OBSERVATIONS_MOUNT}/${relative}\t${Buffer.byteLength(JSON.stringify(observation))}`);
    fileCount += 1;
  }
  for (const event of input.runEvents ?? []) {
    const relative = observationRelativePath(`event:${event.eventId}`, "run_events");
    const observation = visibleValue(event, allowText);
    await writeObservationFile(join(input.root, ...relative.split("/")), {
      ref: `event:${event.eventId}`,
      source: "run_events",
      index: event.sequence,
      observation,
    });
    rows.push(`event:${event.eventId}\trun_events\t${OBSERVATIONS_MOUNT}/${relative}\t${Buffer.byteLength(JSON.stringify(observation))}`);
    fileCount += 1;
  }
  if (input.playbookText) {
    await writeAtomic(join(input.root, "playbook.md"), input.playbookText);
    fileCount += 1;
  }
  fileCount += await writeMetadata(input.root, input.taskCase);
  fileCount += await writeSourceRefs(input.root, input.taskCase);
  fileCount += await writeOwnedFiles(input.root, input.ownedFiles ?? [], input.taskCase.privacy.allowBinary, missing, rows);
  const userInputs = await writeUserInputIndex({
    root: input.root,
    taskCase: input.taskCase,
    runEvents: input.runEvents ?? [],
  });
  fileCount += userInputs.fileCount;
  fileCount += await writeSessionManifest(input.root, input.taskCase, missing);
  const index = [
    "# Frozen observations",
    "",
    "Host-owned copies of the frozen session. This tree is not the candidate workspace.",
    "Read INDEX.md then a single file with `read`. Grep when you need one sentence or ref.",
    "Do not treat this directory as task output. Envelope refs are the `ref` field inside each JSON file.",
    "User demand is indexed at user-inputs/INDEX.tsv; read those files in order before other evidence.",
    "Credentials and product original session paths are not copied here.",
    "",
    `- transcript files: ${catalog.filter((entry) => entry.source === "transcript").length}`,
    `- historical event files: ${catalog.filter((entry) => entry.source === "historical_events").length}`,
    `- run event files: ${input.runEvents?.length ?? 0}`,
    `- user input files: ${userInputs.turnCount}`,
    `- owned files: ${(input.ownedFiles ?? []).length}`,
    `- missing: ${missing.length}`,
    input.playbookText ? "- playbook.md — product recovery playbook text" : "",
    "",
    "Layout: session.json, user-inputs/, transcript/, events/, artifacts/, files/, metadata/, source-refs/",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  await writeAtomic(join(input.root, "INDEX.md"), `${index}\n`);
  await writeAtomic(join(input.root, "INDEX.tsv"), `${rows.join("\n")}\n`);
  fileCount += 2;
  return { fileCount };
}

async function writeSessionManifest(root: string, taskCase: TaskCase, missing: string[]): Promise<number> {
  const manifest: ObservationSessionManifest = {
    schemaVersion: 1,
    caseId: taskCase.caseId,
    source: {
      productId: taskCase.source.productId,
      sessionId: taskCase.source.sessionId,
    },
    ...(taskCase.evidenceLevel ? { evidenceLevel: taskCase.evidenceLevel } : {}),
    provenance: taskCase.provenance,
    privacy: {
      allowModelText: taskCase.privacy.allowModelText,
      allowBinary: taskCase.privacy.allowBinary,
    },
    missing,
  };
  if (!Value.Check(ObservationSessionManifestSchema, manifest)) {
    throw new Error("Observation session manifest failed schema check.");
  }
  await writeAtomic(join(root, "session.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return 1;
}

async function writeMetadata(root: string, taskCase: TaskCase): Promise<number> {
  const body = {
    caseId: taskCase.caseId,
    contentHash: taskCase.contentHash,
    importedAt: taskCase.provenance.importedAt,
    packVersion: taskCase.provenance.packVersion,
    sourceHash: taskCase.provenance.sourceHash,
    redactionCount: taskCase.privacy.redactions.length,
  };
  await writeAtomic(join(root, "metadata", "case.json"), `${JSON.stringify(body, null, 2)}\n`);
  return 1;
}

async function writeSourceRefs(root: string, taskCase: TaskCase): Promise<number> {
  const body = {
    productId: taskCase.source.productId,
    sessionId: taskCase.source.sessionId,
    sourcePath: taskCase.source.sourcePath ? "omitted" : "missing",
  };
  await writeAtomic(join(root, "source-refs", "session.json"), `${JSON.stringify(body, null, 2)}\n`);
  return 1;
}

async function writeOwnedFiles(
  root: string,
  files: readonly ObservationOwnedFile[],
  allowBinary: boolean,
  missing: string[],
  rows: string[],
): Promise<number> {
  let written = 0;
  const listing = ["path\tstatus\tbytes"];
  for (const file of files) {
    const relative = posix.normalize(file.relativePath.replaceAll("\\", "/")).replace(/^(\.\.(\/|$))+/, "");
    if (!relative || relative.startsWith("..") || SECRET_NAME.test(relative)) {
      missing.push(relative || file.relativePath);
      listing.push(`${file.relativePath}\tomitted\t0`);
      continue;
    }
    if (file.missing) {
      missing.push(relative);
      listing.push(`${relative}\tmissing\t0`);
      continue;
    }
    const folder = relative.startsWith("artifacts/") ? "artifacts" : "files";
    const destRelative = relative.startsWith("artifacts/") || relative.startsWith("files/")
      ? relative
      : `${folder}/${relative}`;
    if (file.bytes && !allowBinary) {
      missing.push(destRelative);
      listing.push(`${destRelative}\tbinary-omitted\t0`);
      continue;
    }
    const content = file.text ?? file.bytes;
    if (content === undefined) {
      missing.push(destRelative);
      listing.push(`${destRelative}\tmissing\t0`);
      continue;
    }
    const dest = join(root, ...destRelative.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await writeAtomic(dest, content);
    const bytes = Buffer.byteLength(typeof content === "string" ? content : content);
    listing.push(`${destRelative}\tcopied\t${bytes}`);
    rows.push(`file:${destRelative}\towned_file\t${OBSERVATIONS_MOUNT}/${destRelative}\t${bytes}`);
    written += 1;
  }
  const artifacts = ["path\tstatus\tbytes", ...listing.slice(1).filter((row) => row.startsWith("artifacts/"))];
  await writeAtomic(join(root, "files", "INDEX.tsv"), `${listing.join("\n")}\n`);
  await writeAtomic(join(root, "artifacts", "INDEX.tsv"), `${artifacts.join("\n")}\n`);
  return written + 2;
}

async function writeUserInputIndex(input: {
  root: string;
  taskCase: TaskCase;
  runEvents?: readonly EventEnvelope[];
}): Promise<{ fileCount: number; turnCount: number }> {
  const dir = join(input.root, "user-inputs");
  await mkdir(dir, { recursive: true });
  const rows = ["turn_id\torder\trole\tsource\tpath\tattachments\trelated"];
  let order = 0;
  let extraFiles = 0;
  for (const message of input.taskCase.transcript) {
    if (message.role !== "user") continue;
    order += 1;
    const relative = `user-inputs/${message.id}.txt`;
    await writeAtomic(join(input.root, ...relative.split("/")), `${message.text}\n`);
    extraFiles += 1;
    rows.push([
      message.id,
      String(order),
      "user",
      "historical_user",
      `${OBSERVATIONS_MOUNT}/${relative}`,
      "missing",
      relatedReplyPath(input.taskCase.transcript, message.id),
    ].join("\t"));
  }
  for (const event of input.runEvents ?? []) {
    const sent = controllerSendTurn(event);
    if (!sent) continue;
    order += 1;
    const relative = `user-inputs/${sent.id}.txt`;
    await writeAtomic(join(input.root, ...relative.split("/")), `${sent.text}\n`);
    extraFiles += 1;
    rows.push([
      sent.id,
      String(order),
      "user",
      "controller",
      `${OBSERVATIONS_MOUNT}/${relative}`,
      "missing",
      "missing",
    ].join("\t"));
  }
  await writeAtomic(join(dir, "INDEX.tsv"), `${rows.join("\n")}\n`);
  return { fileCount: extraFiles + 1, turnCount: order };
}

function relatedReplyPath(
  transcript: TaskCase["transcript"],
  userId: string,
): string {
  const index = transcript.findIndex((message) => message.id === userId);
  const next = index >= 0 ? transcript[index + 1] : undefined;
  if (next?.role === "assistant") return `${OBSERVATIONS_MOUNT}/transcript/${fileStem(next.id)}.json`;
  return "missing";
}

function controllerSendTurn(event: EventEnvelope): { id: string; text: string } | undefined {
  if (event.type !== "controller.decision") return undefined;
  const payload = event.payload as { status?: unknown; value?: { type?: unknown; message?: unknown } };
  if (payload.status !== "completed" || payload.value?.type !== "send") return undefined;
  if (typeof payload.value.message !== "string" || !payload.value.message.trim()) return undefined;
  return { id: `controller-send-${event.eventId}`, text: payload.value.message };
}

async function writeObservationFile(path: string, body: {
  ref: string;
  source: string;
  index: number;
  observation: unknown;
}): Promise<void> {
  const encoded = JSON.stringify(body.observation);
  const truncated = encoded.length > FILE_MAX_CHARS;
  const payload = {
    ref: body.ref,
    source: body.source,
    index: body.index,
    truncated,
    originalChars: encoded.length,
    observation: truncated
      ? { excerpt: encoded.slice(0, FILE_MAX_CHARS), reason: "file_char_limit" }
      : body.observation,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function fileStem(ref: string): string {
  return ref.replace(/^event:/, "").replace(/[^A-Za-z0-9._-]/g, "_");
}

function visibleTranscript(
  message: TaskCase["transcript"][number] | undefined,
  allowText: boolean,
): unknown {
  if (!message) return null;
  if (allowText || message.role !== "assistant") return message;
  return { ...message, text: "[REDACTED]" };
}

function visibleValue(value: unknown, allowText: boolean): unknown {
  if (allowText) return value;
  return redactTextFields(value);
}

function redactTextFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactTextFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "text" && typeof child === "string" ? "[REDACTED]" : redactTextFields(child),
    ]),
  );
}
