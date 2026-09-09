import { Value } from "@sinclair/typebox/value";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  AgentImageRefSchema,
  AgentTextBodySchema,
  ModelInputDiagnosticSchema,
  ReconstructedModelRequestSchema,
  type AgentImageRef,
  type AgentTextBody,
  type ModelInputDiagnostic,
  type ReconstructedModelRequest,
} from "../../core/agent-model-input-schema.js";
import { EventEnvelopeSchema, type EventEnvelope } from "../../core/schema.js";
import { isRecord } from "../../core/json.js";
import { eventEnvelopeChecksum, sha256 } from "../../core/identity.js";

export type RedactableToolResult = {
  content: string;
  contentBlocks?: readonly (
    | { type: "text"; text: string }
    | { type: "image"; mimeType: string; data: string }
  )[];
  details?: unknown;
};

export const INLINE_MODEL_INPUT_BYTES = 8_192;
const MODEL_INPUT_SCHEMA_VERSION = 1;
export const INCOMPLETE_MODEL_INPUT_COPY = "该记录未保存完整内容";

export type ArtifactBodyResolver = (ref: {
  artifactId: string;
  contentHash: string;
  byteLength: number;
}) => Promise<string>;

export function redactModelVisibleText(text: string): { text: string; redacted: boolean } {
  const next = text
    .replace(/(authorization\s*[=:]\s*)(?:"?)(?:Bearer\s+)?[^\s"]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  return { text: next, redacted: next !== text };
}

export function inlineBody(text: string): AgentTextBody {
  return { encoding: "inline", schemaVersion: 1, text: redactModelVisibleText(text).text };
}

export function imageRefs(images: readonly ImageContent[] | undefined): AgentImageRef[] {
  return (images ?? []).map((image) => {
    const ref = {
      type: "image" as const,
      mimeType: image.mimeType,
      contentHash: sha256(image.data),
      byteLength: Buffer.byteLength(image.data, "base64"),
    };
    if (!Value.Check(AgentImageRefSchema, ref)) throw new Error("Image reference failed schema check.");
    return ref;
  });
}

export function redactToolResultForModel(result: RedactableToolResult): RedactableToolResult {
  const content = redactModelVisibleText(result.content).text;
  const contentBlocks = result.contentBlocks?.map((block) => (
    block.type === "text" ? { ...block, text: redactModelVisibleText(block.text).text } : block
  ));
  return {
    content,
    ...(contentBlocks ? { contentBlocks } : {}),
    ...(result.details === undefined ? {} : { details: result.details }),
  };
}

export function toolResultBody(result: RedactableToolResult): AgentTextBody {
  if (result.contentBlocks?.length) {
    const persisted = result.contentBlocks.map((block) => (
      block.type === "text"
        ? block
        : { type: "image", mimeType: block.mimeType, contentHash: sha256(block.data), byteLength: Buffer.byteLength(block.data, "base64") }
    ));
    return inlineBody(JSON.stringify(persisted));
  }
  return inlineBody(result.content);
}

async function resolveTextBody(body: unknown, resolveArtifact?: ArtifactBodyResolver): Promise<string> {
  if (!Value.Check(AgentTextBodySchema, body)) throw diagnosticError({ code: "schema", message: "Model input body is not a versioned text body." });
  if (body.encoding === "inline") return body.text;
  if (!resolveArtifact) throw diagnosticError({ code: "missing_attachment", message: "Model input body references an artifact but no resolver was provided.", artifactId: body.artifactId });
  const text = await resolveArtifact(body);
  if (Buffer.byteLength(text) !== body.byteLength || sha256(text) !== body.contentHash) {
    throw diagnosticError({ code: "attachment_checksum", message: "Model input artifact failed integrity check.", artifactId: body.artifactId });
  }
  return text;
}

export function parseCommittedEventLog(text: string): { events: EventEnvelope[]; diagnostic?: ModelInputDiagnostic } {
  const incomplete = !text.endsWith("\n") && text.length > 0;
  const raw = incomplete ? text.slice(0, text.lastIndexOf("\n") + 1) : text;
  const events: EventEnvelope[] = [];
  const lines = raw.split("\n").slice(0, -1);
  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return { events, diagnostic: { code: "invalid_json", message: "Event log contains illegal JSON.", sequence: index + 1 } };
    }
    if (!Value.Check(EventEnvelopeSchema, parsed)) {
      return { events, diagnostic: { code: "invalid_envelope", message: "Event log contains an invalid envelope.", sequence: index + 1 } };
    }
    if (parsed.schemaVersion !== 1) {
      return { events, diagnostic: { code: "unsupported_schema", message: `Unsupported event schemaVersion ${String(parsed.schemaVersion)}.`, sequence: index + 1 } };
    }
    const { checksum, ...body } = parsed;
    if (checksum !== eventEnvelopeChecksum(body)) {
      return { events, diagnostic: { code: "checksum_mismatch", message: "Event checksum mismatch.", sequence: index + 1 } };
    }
    if (parsed.sequence !== index + 1) {
      return { events, diagnostic: { code: "sequence_gap", message: "Event sequence is not contiguous.", sequence: index + 1 } };
    }
    events.push(parsed);
  }
  return { events, ...(incomplete ? { diagnostic: { code: "incomplete_tail" as const, message: "Event log ends without a committed newline." } } : {}) };
}

export async function reconstructModelRequests(
  events: readonly EventEnvelope[],
  resolveArtifact?: ArtifactBodyResolver,
): Promise<{ requests: ReconstructedModelRequest[]; diagnostic?: ModelInputDiagnostic }> {
  const sessions = new Map<string, SessionReplay>();
  const requests: ReconstructedModelRequest[] = [];
  try {
    for (const event of events) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      if (event.type === "agent.session_started" && sessionId) {
        sessions.set(sessionId, {
          sessionId,
          role: typeof payload.role === "string" ? payload.role : "unknown",
          systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : "",
          tools: Array.isArray(payload.tools) ? payload.tools : [],
          messages: [],
          invocationTerminal: false,
        });
        continue;
      }
      const session = sessions.get(sessionId);
      if (!session) continue;
      if (event.type === "agent.invocation_completed" || event.type === "agent.invocation_failed" || event.type === "agent.invocation_cancelled") {
        session.invocationTerminal = true;
        continue;
      }
      if (event.type === "agent.session_completed") {
        if (!session.invocationTerminal) {
          const last = [...requests].reverse().find((request) => request.sessionId === session.sessionId);
          if (last) last.legacyRequestComplete = true;
        }
        continue;
      }
      if (event.type === "agent.message_appended") {
        requests.push(await replayUserRequest(session, payload, resolveArtifact));
        continue;
      }
      if (event.type === "agent.context_compacted") {
        const summary = typeof payload.summary === "string" ? payload.summary : "";
        let tail: unknown[] = [];
        const inspected = inspectModelInputBody(payload.retainedTail);
        if (!inspected.ok && inspected.diagnostic.code === "unsupported_schema") throw diagnosticError(inspected.diagnostic);
        if (inspected.ok) {
          tail = JSON.parse(await resolveTextBody(inspected.body, resolveArtifact)) as unknown[];
        } else if (Array.isArray(payload.retainedTail)) {
          tail = payload.retainedTail;
        }
        session.messages = [{ role: "compactionSummary", summary }, ...tail];
        if (requests.length > 0) {
          const last = requests.at(-1);
          if (last && last.sessionId === session.sessionId && last.invocationId === stringField(payload.invocationId, last.invocationId)) {
            last.compacted = true;
            last.messages = session.messages;
          }
        }
        continue;
      }
      if (event.type === "agent.model_output") {
        const inspected = inspectModelInputBody(payload.body);
        if (!inspected.ok) continue;
        const text = await resolveTextBody(inspected.body, resolveArtifact);
        session.messages.push({ role: "assistant", content: [{ type: "text", text }] });
        continue;
      }
      if (payload.nativeHook) continue;
      if (event.type === "agent.tool_called") {
        session.messages.push({
          role: "assistant",
          content: [{ type: "toolCall", id: stringField(payload.toolCallId), name: stringField(payload.tool), arguments: payload.params ?? {} }],
        });
        continue;
      }
      if (event.type === "agent.tool_completed") {
        const text = payload.body ? await resolveTextBody(payload.body, resolveArtifact) : "";
        session.messages.push({
          role: "toolResult",
          toolCallId: stringField(payload.toolCallId),
          toolName: stringField(payload.tool),
          content: [{ type: "text", text }],
        });
      }
    }
  } catch (error) {
    if (isDiagnostic(error)) return { requests, diagnostic: error.diagnostic };
    throw error;
  }
  for (const request of requests) {
    if (!Value.Check(ReconstructedModelRequestSchema, request)) {
      return { requests, diagnostic: { code: "schema", message: "Reconstructed model request failed schema check." } };
    }
  }
  return { requests };
}

export async function spillInlineBody(
  body: unknown,
  write: (bytes: Uint8Array) => Promise<{ artifactId: string; contentHash: string; byteLength: number }>,
): Promise<unknown> {
  if (!Value.Check(AgentTextBodySchema, body) || body.encoding !== "inline") return body;
  if (Buffer.byteLength(body.text) <= INLINE_MODEL_INPUT_BYTES) return body;
  const bytes = Buffer.from(body.text);
  const artifact = await write(bytes);
  return {
    encoding: "artifact",
    schemaVersion: 1,
    artifactId: artifact.artifactId,
    contentHash: artifact.contentHash,
    byteLength: artifact.byteLength,
  };
}

export async function spillImageRefs(
  images: unknown,
  write: (bytes: Uint8Array) => Promise<{ artifactId: string; contentHash: string; byteLength: number }>,
): Promise<unknown> {
  if (!Array.isArray(images)) return images;
  const spilled: unknown[] = [];
  for (const image of images) {
    if (!isRecord(image) || typeof image.data !== "string") {
      spilled.push(image);
      continue;
    }
    const artifact = await write(Buffer.from(image.data, "base64"));
    const { data: _data, ...rest } = image;
    spilled.push({
      ...rest,
      type: "image",
      mimeType: image.mimeType,
      artifactId: artifact.artifactId,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
    });
  }
  return spilled;
}

type SessionReplay = {
  sessionId: string;
  role: string;
  systemPrompt: string;
  tools: unknown[];
  messages: unknown[];
  invocationTerminal: boolean;
};

function userContent(text: string, images: unknown): unknown[] {
  const blocks: unknown[] = [{ type: "text", text }];
  if (!Array.isArray(images)) return blocks;
  for (const image of images) {
    if (!isRecord(image)) continue;
    const { data: _data, ...rest } = image;
    blocks.push({ type: "image", ...rest });
  }
  return blocks;
}

export function inspectModelInputBody(body: unknown): { ok: true; body: AgentTextBody } | { ok: false; diagnostic: ModelInputDiagnostic } {
  if (body === undefined || !isRecord(body)) {
    return { ok: false, diagnostic: { code: "incomplete_content", message: INCOMPLETE_MODEL_INPUT_COPY } };
  }
  if (typeof body.schemaVersion === "number" && body.schemaVersion !== MODEL_INPUT_SCHEMA_VERSION) {
    return { ok: false, diagnostic: { code: "unsupported_schema", message: `Unsupported model input schemaVersion ${String(body.schemaVersion)}.` } };
  }
  if (!Value.Check(AgentTextBodySchema, body)) {
    return { ok: false, diagnostic: { code: "incomplete_content", message: INCOMPLETE_MODEL_INPUT_COPY } };
  }
  return { ok: true, body };
}

async function replayUserRequest(
  session: SessionReplay,
  payload: Record<string, unknown>,
  resolveArtifact?: ArtifactBodyResolver,
): Promise<ReconstructedModelRequest> {
  const inspected = inspectModelInputBody(payload.body);
  if (!inspected.ok) {
    if (inspected.diagnostic.code === "unsupported_schema") throw diagnosticError(inspected.diagnostic);
    return snapshotRequest(session, payload, false, false);
  }
  const text = await resolveTextBody(inspected.body, resolveArtifact);
  session.messages.push({ role: "user", content: userContent(text, payload.images) });
  return snapshotRequest(session, payload, false, true);
}

async function snapshotRequest(session: SessionReplay, payload: Record<string, unknown>, compacted: boolean, contentComplete: boolean): Promise<ReconstructedModelRequest> {
  const invocationId = stringField(payload.invocationId);
  const requestIndex = Number(payload.requestIndex ?? 0);
  return {
    schemaVersion: 1,
    sessionId: session.sessionId,
    role: session.role,
    invocationId,
    requestIndex,
    repair: payload.repair === true,
    compacted,
    contentComplete,
    systemPrompt: session.systemPrompt,
    tools: session.tools as ReconstructedModelRequest["tools"],
    messages: [...session.messages],
  };
}

function diagnosticError(diagnostic: ModelInputDiagnostic): Error & { diagnostic: ModelInputDiagnostic } {
  if (!Value.Check(ModelInputDiagnosticSchema, diagnostic)) throw new Error("Model input diagnostic failed schema check.");
  return Object.assign(new Error(diagnostic.message), { diagnostic });
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isDiagnostic(error: unknown): error is Error & { diagnostic: ModelInputDiagnostic } {
  return error instanceof Error && "diagnostic" in error && isRecord((error as { diagnostic?: unknown }).diagnostic);
}
