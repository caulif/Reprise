import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomic } from "../core/identity.js";
import type { EventEnvelope, TaskCase } from "../core/schema.js";
import { recoveryEvidenceCatalog } from "../infrastructure/recovery-tools.js";

export const OBSERVATIONS_MOUNT = "observations";
const FILE_MAX_CHARS = 8_000;

export function recoveryObservationsRoot(experimentRoot: string, runId: string): string {
  return join(experimentRoot, "runs", runId, "observations");
}

function observationRelativePath(ref: string, source: "transcript" | "historical_events" | "run_events"): string {
  const folder =
    source === "transcript" ? "transcript" : source === "run_events" ? "run-events" : "historical-events";
  return `${folder}/${fileStem(ref)}.json`;
}

export async function writeFrozenObservationTree(input: {
  root: string;
  taskCase: TaskCase;
  runEvents?: readonly EventEnvelope[];
  playbookText?: string;
}): Promise<{ fileCount: number }> {
  const allowText = input.taskCase.privacy.allowModelText;
  const catalog = recoveryEvidenceCatalog(input.taskCase);
  const rows: string[] = ["ref\tsource\tpath\tbytes"];
  await mkdir(join(input.root, "transcript"), { recursive: true });
  await mkdir(join(input.root, "historical-events"), { recursive: true });
  if (input.runEvents?.length) await mkdir(join(input.root, "run-events"), { recursive: true });
  let fileCount = 0;
  for (const entry of catalog) {
    const observation =
      entry.source === "transcript"
        ? visibleTranscript(input.taskCase.transcript[entry.index], allowText)
        : visibleValue(input.taskCase.historicalEvents[entry.index], allowText);
    const relative = observationRelativePath(entry.ref, entry.source);
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
  const userInputs = await writeUserInputIndex({
    root: input.root,
    taskCase: input.taskCase,
    runEvents: input.runEvents ?? [],
  });
  fileCount += userInputs.fileCount;
  const index = [
    "# Frozen observations",
    "",
    "Host-owned copies of the frozen session. This tree is not the candidate workspace.",
    "Read INDEX.tsv then a single file with `read`. Grep when you need one sentence or ref.",
    "Do not treat this directory as task output. Envelope refs are the `ref` field inside each JSON file.",
    "User demand is indexed at user-inputs/INDEX.tsv; read those files in order before other evidence.",
    "",
    `- transcript files: ${catalog.filter((entry) => entry.source === "transcript").length}`,
    `- historical event files: ${catalog.filter((entry) => entry.source === "historical_events").length}`,
    `- run event files: ${input.runEvents?.length ?? 0}`,
    `- user input files: ${userInputs.turnCount}`,
    input.playbookText ? "- playbook.md — product recovery playbook text" : "",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
  await writeAtomic(join(input.root, "INDEX.md"), `${index}\n`);
  await writeAtomic(join(input.root, "INDEX.tsv"), `${rows.join("\n")}\n`);
  fileCount += 2;
  return { fileCount };
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
    rows.push([
      message.id,
      String(order),
      "user",
      "historical_user",
      `history/transcript/${message.id}.txt`,
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
  if (next?.role === "assistant") return `history/transcript/${next.id}.txt`;
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
