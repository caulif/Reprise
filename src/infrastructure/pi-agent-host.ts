import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { sha256 } from "../core/identity.js";

export type AgentFailure = {
  /** Safe classification used to decide whether a bounded retry is meaningful. */
  kind?: AgentFailureKind;
  code:
    "agent_timeout" | "agent_failure" | "invalid_output" | "privacy_blocked";
  message: string;
  attempts: number;
};

export type AgentFailureKind =
  | "authentication"
  | "rate_limited"
  | "transient_network"
  | "transient_upstream"
  | "tool"
  | "timeout"
  | "protocol"
  | "cancelled"
  | "unknown";

/** A failed invocation deliberately has no T: Host facts must not become model decisions. */
export type AgentInvocation<T> =
  | { status: "completed"; value: T; sessionId: string }
  | { status: "failed"; failure: AgentFailure; sessionId?: string }
  | { status: "cancelled"; factRef?: string; sessionId?: string };
/** Compatibility name during the staged migration; it no longer has a fallback value. */
export type StructuredAgentResult<T> = AgentInvocation<T>;

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(
    params: unknown,
    signal: AbortSignal,
  ): Promise<{ content: string; details?: unknown }>;
  /** Host-only hook for facts a successful read made available during this request. */
  onCompleted?(result: { content: string; details?: unknown }): Promise<void>;
};

export type AgentAuditEvent = {
  type:
    | "agent.session_started"
    | "agent.session_completed"
    | "agent.session_failed"
    | "agent.session_cancelled"
    | "agent.message_appended"
    | "agent.tool_called"
    | "agent.tool_completed"
    | "agent.tool_failed"
    | "agent.invalid_output"
    | "agent.context_compacted";
  sessionId: string;
  role: string;
  payload: Record<string, unknown>;
};

export type AgentAuditSink = { append(event: AgentAuditEvent): Promise<void> };

export interface PiTextSession {
  append(input: { content: string; signal: AbortSignal }): Promise<string>;
  cancel(): void;
}

/** Implementations own model/provider state; PiModelCaller implements this using Pi Agent Core. */
export interface PiTextCaller {
  createSession(input: {
    sessionId: string;
    systemPrompt: string;
    tools: readonly AgentToolDefinition[];
    onContextCompact?: (payload: { summary: string; tokensBefore: number; retainedCount: number }) => Promise<void>;
  }): Promise<PiTextSession> | PiTextSession;
}

export type StructuredAgentRequest<T> = {
  role: string;
  systemPrompt: string;
  context: unknown;
  schema: TSchema;
  /** 0 means no per-call timer; the session still stops on cancel. */
  timeoutMs: number;
  maxRepairAttempts: number;
  allowModelText: boolean;
  tools?: readonly AgentToolDefinition[];
  validate?: (value: T) => string | undefined;
  audit?: AgentAuditSink;
  /** Exact JSON the model must return; included in the first prompt and in repairs. */
  outputContract?: string;
  /** Extra bounded instruction appended only to a schema/validator repair request. */
  repairInstruction?: string;
};

export type AgentSessionRequest<T> = Pick<
  StructuredAgentRequest<T>,
  | "context"
  | "schema"
  | "timeoutMs"
  | "maxRepairAttempts"
  | "validate"
  | "outputContract"
  | "repairInstruction"
> & {
  /** Host request identity; a cancelled id is dropped before decode. */
  requestId?: string;
};

/**
 * The shared Host boundary for all internal agents. It owns session identity,
 * timeout/cancellation, schema validation, registered tools, and audit facts.
 * It never manufactures a domain value when a model cannot produce one.
 */
export class PiAgentHost {
  readonly #caller: PiTextCaller;

  constructor(caller: PiTextCaller) {
    this.#caller = caller;
  }

  async createSession(input: {
    role: string;
    systemPrompt: string;
    allowModelText: boolean;
    tools?: readonly AgentToolDefinition[];
    audit?: AgentAuditSink;
  }): Promise<AgentSessionHost> {
    assertSessionInput(input);
    const sessionId = randomUUID();
    if (!input.allowModelText) {
      await input.audit?.append({
        type: "agent.session_failed",
        sessionId,
        role: input.role,
        payload: { code: "privacy_blocked" },
      });
      return AgentSessionHost.blocked(sessionId, input.role, input.audit);
    }
    const tools = instrumentTools(
      input.tools ?? [],
      sessionId,
      input.role,
      input.audit,
    );
    try {
      const session = await this.#caller.createSession({
        sessionId,
        systemPrompt: input.systemPrompt,
        tools,
        onContextCompact: async (payload) => {
          await input.audit?.append({
            type: "agent.context_compacted",
            sessionId,
            role: input.role,
            payload,
          });
        },
      });
      await input.audit?.append({
        type: "agent.session_started",
        sessionId,
        role: input.role,
        payload: { toolNames: tools.map((tool) => tool.name) },
      });
      return new AgentSessionHost(sessionId, input.role, session, input.audit);
    } catch (error) {
      await input.audit?.append({
        type: "agent.session_failed",
        sessionId,
        role: input.role,
        payload: { code: "agent_failure", message: errorMessage(error) },
      });
      return AgentSessionHost.failed(
        sessionId,
        input.role,
        "agent_failure",
        errorMessage(error),
        input.audit,
        classifyAgentFailure(error),
      );
    }
  }

  async request<T>(
    request: StructuredAgentRequest<T>,
  ): Promise<AgentInvocation<T>> {
    const session = await this.createSession(request);
    return session.request({
      context: request.context,
      schema: request.schema,
      timeoutMs: request.timeoutMs,
      maxRepairAttempts: request.maxRepairAttempts,
      ...(request.validate ? { validate: request.validate } : {}),
      ...(request.outputContract
        ? { outputContract: request.outputContract }
        : {}),
      ...(request.repairInstruction
        ? { repairInstruction: request.repairInstruction }
        : {}),
    });
  }
}

/** One isolated model transcript. A Controller retains one of these per CandidateRun. */
export class AgentSessionHost {
  readonly #sessionId: string;
  readonly #role: string;
  readonly #session: PiTextSession | undefined;
  readonly #audit: AgentAuditSink | undefined;
  readonly #failure: AgentFailure | undefined;
  #cancelled = false;
  #droppedRequestIds = new Set<string>();

  constructor(
    sessionId: string,
    role: string,
    session?: PiTextSession,
    audit?: AgentAuditSink,
    failure?: AgentFailure,
  ) {
    this.#sessionId = sessionId;
    this.#role = role;
    this.#session = session;
    this.#audit = audit;
    this.#failure = failure;
  }

  static blocked(
    sessionId: string,
    role: string,
    audit?: AgentAuditSink,
  ): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, {
      code: "privacy_blocked",
      message: "Model text is disallowed by TaskCase privacy policy.",
      attempts: 0,
    });
  }

  static failed(
    sessionId: string,
    role: string,
    code: AgentFailure["code"],
    message: string,
    audit?: AgentAuditSink,
    kind: AgentFailureKind = "unknown",
  ): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, {
      code,
      message,
      attempts: 0,
      kind,
    });
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  async cancel(factRef?: string, requestId?: string): Promise<void> {
    if (requestId) this.#droppedRequestIds.add(requestId);
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#session?.cancel();
    await this.#audit?.append({
      type: "agent.session_cancelled",
      sessionId: this.#sessionId,
      role: this.#role,
      payload: factRef ? { factRef } : {},
    });
  }

  async request<T>(
    request: AgentSessionRequest<T>,
  ): Promise<AgentInvocation<T>> {
    assertRequest(request);
    if (this.#dropped(request.requestId))
      return { status: "cancelled", sessionId: this.#sessionId };
    if (this.#failure)
      return {
        status: "failed",
        sessionId: this.#sessionId,
        failure: this.#failure,
      };
    if (!this.#session)
      throw new Error(
        "Agent session is unavailable without a recorded failure.",
      );
    let attempts = 0;
    let lastError: string | undefined;
    for (; attempts <= request.maxRepairAttempts; attempts += 1) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const content = promptBody(request, attempts, lastError);
        await this.#audit?.append({
          type: "agent.message_appended",
          sessionId: this.#sessionId,
          role: this.#role,
          payload: {
            byteLength: Buffer.byteLength(content),
            repair: attempts > 0,
          },
        });
        if (request.timeoutMs > 0) {
          timer = setTimeout(() => controller.abort(), request.timeoutMs);
        }
        const text = await abortable(
          this.#session.append({ content, signal: controller.signal }),
          controller.signal,
        );
        if (controller.signal.aborted) throw timeoutError();
        // A provider may resolve after cancel() despite receiving an abort signal.
        if (this.#dropped(request.requestId)) return { status: 'cancelled', sessionId: this.#sessionId };
        const decoded = decode(request.schema, text);
        const error = decoded.error ?? request.validate?.(decoded.value as T);
        if (!error && decoded.value !== undefined) {
          await this.#audit?.append({
            type: "agent.session_completed",
            sessionId: this.#sessionId,
            role: this.#role,
            payload: { attempts: attempts + 1 },
          });
          return {
            status: "completed",
            value: decoded.value as T,
            sessionId: this.#sessionId,
          };
        }
        lastError = error ?? "schema validation failed";
        if (attempts === request.maxRepairAttempts) {
          await this.#audit?.append({
            type: "agent.invalid_output",
            sessionId: this.#sessionId,
            role: this.#role,
            payload: invalidOutputAudit(lastError, attempts + 1, decoded.value),
          });
          return this.#failed("invalid_output", lastError, attempts + 1);
        }
      } catch (error) {
        if (this.#dropped(request.requestId) || (isAbort(error) && !isTimeout(error)))
          return { status: "cancelled", sessionId: this.#sessionId };
        const code = isTimeout(error) ? "agent_timeout" : "agent_failure";
        return this.#failed(
          code,
          errorMessage(error),
          attempts + 1,
          isTimeout(error) ? "timeout" : classifyAgentFailure(error),
        );
      } finally {
        if (timer) clearTimeout(timer);
        if (request.timeoutMs > 0) controller.abort();
      }
    }
    throw new Error("Agent session repair loop unexpectedly ended.");
  }

  async #failed(
    code: AgentFailure["code"],
    message: string,
    attempts: number,
    kind: AgentFailureKind = code === "invalid_output" ? "protocol" : "unknown",
  ): Promise<AgentInvocation<never>> {
    const failure: AgentFailure = { code, message, attempts, kind };
    await this.#audit?.append({
      type: "agent.session_failed",
      sessionId: this.#sessionId,
      role: this.#role,
      payload: code === "invalid_output"
        ? { code, attempts, category: invalidOutputCategory(message) }
        : { code, attempts, kind },
    });
    return { status: "failed", sessionId: this.#sessionId, failure };
  }

  #dropped(requestId?: string): boolean {
    return this.#cancelled || Boolean(requestId && this.#droppedRequestIds.has(requestId));
  }
}

function instrumentTools(
  tools: readonly AgentToolDefinition[],
  sessionId: string,
  role: string,
  audit?: AgentAuditSink,
): AgentToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) ||
      !tool.description.trim() ||
      names.has(tool.name)
    )
      throw new Error(
        "Agent tool definitions require unique safe names and descriptions.",
      );
    names.add(tool.name);
    return {
      ...tool,
      async execute(params, signal) {
        await audit?.append({
          type: "agent.tool_called",
          sessionId,
          role,
          payload: { tool: tool.name, params: safeParams(params) },
        });
        try {
          const result = await tool.execute(params, signal);
          await tool.onCompleted?.(result);
          await audit?.append({
            type: "agent.tool_completed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              byteLength: Buffer.byteLength(result.content),
              ...(result.details && typeof result.details === "object"
                ? { details: safeDetails(result.details) }
                : {}),
            },
          });
          return result;
        } catch (error) {
          await audit?.append({
            type: "agent.tool_failed",
            sessionId,
            role,
            payload: { tool: tool.name, message: errorMessage(error) },
          });
          throw new AgentToolFailure(error);
        }
      },
    };
  });
}

class AgentToolFailure extends Error {
  constructor(cause: unknown) {
    super("Recovery agent tool execution failed.", { cause });
    this.name = "AgentToolFailure";
  }
}

function classifyAgentFailure(error: unknown): AgentFailureKind {
  if (error instanceof AgentToolFailure) return "tool";
  if (isAbort(error)) return "cancelled";
  const details = errorDetails(error).toLowerCase();
  const status = errorStatus(error);
  if (status === 401 || status === 403 || /\b(unauthori[sz]ed|forbidden|invalid api key|authentication)\b/.test(details))
    return "authentication";
  if (status === 429 || /\b(rate.?limit|too many requests|quota)\b/.test(details)) return "rate_limited";
  if ([408, 500, 502, 503, 504].includes(status ?? 0) || /\b(upstream_error|upstream request failed|service temporarily unavailable|bad gateway|gateway timeout)\b/.test(details))
    return "transient_upstream";
  if (/\b(econnreset|econnrefused|enotfound|etimedout|timeout|network|transport|fetch failed|socket)\b/.test(details))
    return "transient_network";
  if (/\b(context_length_exceeded|maximum context length|prompt is too long|context window)\b/.test(details))
    return "protocol";
  if (/\b(invalid json|schema|protocol|malformed|unexpected response)\b/.test(details)) return "protocol";
  return "unknown";
}

function errorStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    for (const value of [record.status, record.statusCode, record.code]) {
      if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)
        return value;
      if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
    }
    current = record.cause;
  }
  return undefined;
}

function errorDetails(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    } else break;
  }
  return messages.join(" ");
}

function assertSessionInput(input: {
  role: string;
  systemPrompt: string;
}): void {
  if (!input.role.trim() || !input.systemPrompt.trim())
    throw new Error("Agent role and system prompt are required.");
}

function assertRequest<T>(request: AgentSessionRequest<T>): void {
  if (
    !Number.isInteger(request.timeoutMs) ||
    request.timeoutMs < 0 ||
    !Number.isInteger(request.maxRepairAttempts) ||
    request.maxRepairAttempts < 0
  ) {
    throw new Error("Agent request limits are invalid.");
  }
}

function promptBody<T>(
  request: AgentSessionRequest<T>,
  attempts: number,
  lastError: string | undefined,
): string {
  const context = JSON.stringify(request.context);
  const contract = request.outputContract
    ? `${request.outputContract.trim()}\n\n`
    : "";
  if (!attempts) return `${contract}${context}`;
  const reason = lastError ? ` (${lastError})` : "";
  const repair = request.repairInstruction ? ` ${request.repairInstruction.trim()}` : "";
  return `${contract}Your prior response was invalid${reason}. Return only JSON matching the contract.${repair}\n\n${context}`;
}

function invalidOutputAudit(error: string, attempts: number, value: unknown): Record<string, unknown> {
  const refs = value && typeof value === "object" && Array.isArray((value as { evidenceRefs?: unknown }).evidenceRefs)
    ? (value as { evidenceRefs: unknown[] }).evidenceRefs.filter((ref): ref is string => typeof ref === "string")
    : [];
  return {
    category: invalidOutputCategory(error),
    attempts,
    evidenceRefCount: refs.length,
    evidenceRefsHash: sha256([...refs].sort().join("\0")),
  };
}

function invalidOutputCategory(error: string): string {
  if (/^RECOVERY_UNKNOWN_REF:/.test(error)) return "recovery_unknown_ref";
  if (/^RECOVERY_/.test(error)) return "recovery_contract";
  if (/^schema validation failed/.test(error)) return "schema_validation";
  if (error === "invalid JSON") return "invalid_json";
  return "validator_rejected";
}

function decode(
  schema: TSchema,
  text: string,
): { value?: unknown; error?: string } {
  const parsed = parse(text);
  if (parsed === undefined) return { error: "invalid JSON" };
  const cleaned = Value.Clean(schema, parsed);
  if (Value.Check(schema, cleaned)) return { value: cleaned };
  const first = Value.Errors(schema, cleaned).First();
  const path = first?.path || "/";
  const message = first?.message || "failed";
  return { error: `schema validation failed at ${path}: ${message}` };
}

function parse(text: string): unknown {
  const candidates = [stripJsonFence(text.trim()), extractJsonObject(text)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

/** Models often wrap JSON in a Markdown fence; unwrapping it spends no repair attempt on formatting. */
function stripJsonFence(text: string): string {
  const whole = /^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```\s*$/.exec(text);
  if (whole?.[1]) return whole[1];
  const embedded = /```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?\s*```/.exec(text);
  return embedded?.[1] ?? text;
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener("abort", abort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function timeoutError(): Error {
  const error = new Error("agent timeout");
  error.name = "TimeoutError";
  return error;
}
function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.message === "agent timeout")
  );
}
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function safeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { valueType: typeof value };
  const facts: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    facts[key] =
      key === "content" && typeof item === "string"
        ? { byteLength: Buffer.byteLength(item) }
        : key === "path" && typeof item === "string"
          ? redactAuditText(item).slice(0, 240)
          : key === "command" && typeof item === "string"
            ? redactAuditText(item)
            : typeof item;
  return facts;
}

function safeDetails(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { valueType: typeof value };
  const facts: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    facts[key] =
      key === "command" && typeof item === "string"
        ? redactAuditText(item)
        : key === "content" && typeof item === "string"
          ? { byteLength: Buffer.byteLength(item) }
          : typeof item === "string" && item.length > 512
            ? `${item.slice(0, 512)}…`
            : item;
  return facts;
}

function redactAuditText(text: string): string {
  return text
    .replace(
      /(authorization\s*[=:]\s*)(?:"?)(?:Bearer\s+)?[^\s"]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[=:]\s*)([^\s]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 2048);
}



