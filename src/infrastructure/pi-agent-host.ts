import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { sha256 } from "../core/identity.js";
import { classifyAgentFailure, type AgentFailureKind } from "./agent-failure.js";
import { hostContext } from "./platform.js";
import { imageRefs, inlineBody, redactModelVisibleText, redactToolResultForModel, toolResultBody } from "./agent-model-input.js";

export type { AgentFailureKind };

export type AgentContentBlock = TextContent | ImageContent;
export type AgentToolResult = {
  /** Text fallback retained for non-vision models, logs, and existing tool callers. */
  content: string;
  /** Native Pi blocks; when present these are sent to the model instead of re-encoding them. */
  contentBlocks?: readonly AgentContentBlock[];
  details?: unknown;
};

export type AgentFailure = {
  /** Safe classification used to decide whether a bounded retry is meaningful. */
  kind?: AgentFailureKind;
  code:
    "agent_timeout" | "agent_failure" | "invalid_output" | "privacy_blocked";
  message: string;
  attempts: number;
};

/** A failed invocation deliberately has no T: Host facts must not become model decisions. */
export type AgentInvocation<T> =
  | { status: "completed"; value: T; sessionId: string; invocationId?: string }
  | { status: "failed"; failure: AgentFailure; sessionId?: string; invocationId?: string }
  | { status: "cancelled"; factRef?: string; sessionId?: string; invocationId?: string };
/** Compatibility name during the staged migration; it no longer has a fallback value. */
export type StructuredAgentResult<T> = AgentInvocation<T>;

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(
    params: unknown,
    signal: AbortSignal,
  ): Promise<AgentToolResult>;
  /** Host-only hook for facts a successful read made available during this request. */
  onCompleted?(result: AgentToolResult): Promise<void>;
};

export type AgentAuditEvent = {
  type:
    | "agent.session_started"
    | "agent.session_completed"
    | "agent.session_failed"
    | "agent.session_cancelled"
    | "agent.invocation_started"
    | "agent.invocation_completed"
    | "agent.invocation_failed"
    | "agent.invocation_cancelled"
    | "agent.message_appended"
    | "agent.tool_called"
    | "agent.tool_completed"
    | "agent.tool_failed"
    | "agent.invalid_output"
    | "agent.context_compacted"
    | "agent.request_retried"
    | "agent.assistant_visible"
    | "agent.model_output"
    | "agent.model_request";
  sessionId: string;
  role: string;
  payload: Record<string, unknown>;
};

export type AgentAuditSink = {
  append(event: AgentAuditEvent): Promise<void>;
  commitModelInput?(bytes: Uint8Array): Promise<{ artifactId: string; contentHash: string; byteLength: number }>;
};

export interface PiTextSession {
  /** Pi model input capabilities copied from the resolved model descriptor. */
  readonly inputCapabilities?: readonly string[];
  append(input: { content: string; images?: readonly ImageContent[]; signal: AbortSignal }): Promise<string>;
  cancel(): void;
}

/** Implementations own model/provider state; PiModelCaller implements this using Pi Agent Core. */
export interface PiTextCaller {
  createSession(input: {
    sessionId: string;
    systemPrompt: string;
    tools: readonly AgentToolDefinition[];
    compactionInstructions?: string;
    onContextCompact?: (payload: { summary: string; tokensBefore: number; retainedCount: number; reason?: string; retainedTail?: readonly unknown[] }) => Promise<void>;
    onRetry?: (payload: { attempt: number; kind: string; delayMs: number }) => Promise<void>;
    onAssistantVisible?: (payload: { text: string; turn: number }) => Promise<void>;
    onBeforeToolCall?: (payload: { tool: string }) => Promise<void>;
    onAfterToolCall?: (payload: { tool: string; isError: boolean; contentTypes: readonly string[]; byteLength: number; contentDigest: string }) => Promise<void>;
    onModelRequest?: (payload: { model: string; digest: string; messageCount: number }) => Promise<void>;
  }): Promise<PiTextSession> | PiTextSession;
}

export type StructuredAgentRequest<T> = {
  signal?: AbortSignal;
  role: string;
  systemPrompt: string;
  context: unknown;
  schema: TSchema;
  /** 0 means no per-call timer; the session still stops on cancel. */
  timeoutMs: number;
  maxRepairAttempts: number;
  allowModelText: boolean;
  tools?: readonly AgentToolDefinition[];
  compactionInstructions?: string;
  validate?: (value: T) => string | undefined;
  audit?: AgentAuditSink;
  /** Exact JSON the model must return; included in the first prompt and in repairs. */
  outputContract?: string;
  /** Extra bounded instruction appended only to a schema/validator repair request. */
  repairInstruction?: string;
  /** When set, this string is the model user message instead of JSON.stringify(context). */
  promptContent?: string;
  /** Optional native Pi image blocks accompanying the first user message. */
  promptImages?: readonly ImageContent[];
  /** Role-owned rewrite of parsed JSON before TypeBox Clean/Check. */
  normalize?: (value: unknown) => unknown;
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
  | "promptContent"
  | "promptImages"
  | "normalize"
  | "signal"
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
    compactionInstructions?: string;
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
    const cursor: InvocationCursor = { requestIndex: 0 };
    const tools = instrumentTools(
      input.tools ?? [],
      sessionId,
      input.role,
      cursor,
      input.audit,
    );
    try {
      const session = await this.#caller.createSession({
        sessionId,
        systemPrompt: redactModelVisibleText(input.systemPrompt).text,
        tools,
        ...(input.compactionInstructions ? { compactionInstructions: input.compactionInstructions } : {}),
        ...callerLoopHooks(sessionId, input.role, cursor, input.audit),
      });
      await input.audit?.append({
        type: "agent.session_started",
        sessionId,
        role: input.role,
        payload: {
          toolNames: tools.map((tool) => tool.name),
          promptDigest: sha256(input.systemPrompt),
          toolPolicyDigest: sha256(tools.map((tool) => `${tool.name}\n${tool.description}`).join("\n")),
          systemPrompt: redactModelVisibleText(input.systemPrompt).text,
          tools: input.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) ?? [],
          hostFacts: (() => { const host = hostContext(); return { platform: host.platform, arch: host.arch, pathCase: host.pathCase, shell: host.defaultShell.kind, capabilities: [...host.capabilities].sort() }; })(),
          ...(session.inputCapabilities ? { inputCapabilities: [...session.inputCapabilities] } : {}),
        },
      });
      return new AgentSessionHost(sessionId, input.role, session, input.audit, undefined, session.inputCapabilities, cursor);
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
    try {
      return await session.request({
        ...(request.signal ? { signal: request.signal } : {}),
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
        ...(request.promptContent ? { promptContent: request.promptContent } : {}),
        ...(request.promptImages ? { promptImages: request.promptImages } : {}),
        ...(request.normalize ? { normalize: request.normalize } : {}),
      });
    } finally {
      await session.close();
    }
  }
}

type InvocationCursor = { invocationId?: string | undefined; requestIndex: number; toolSeq?: number; lastToolCallId?: string };

function callerLoopHooks(
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
  audit: AgentAuditSink | undefined,
): Pick<
  Parameters<PiTextCaller["createSession"]>[0],
  "onContextCompact" | "onAssistantVisible" | "onRetry" | "onBeforeToolCall" | "onAfterToolCall" | "onModelRequest"
> {
  return {
    onContextCompact: async (payload) => {
      await audit?.append({
        type: "agent.context_compacted",
        sessionId,
        role,
        payload: {
          schemaVersion: 1,
          invocationId: cursor.invocationId,
          requestIndex: cursor.requestIndex,
          summary: redactModelVisibleText(payload.summary).text,
          tokensBefore: payload.tokensBefore,
          retainedCount: payload.retainedCount,
          reason: payload.reason ?? "compact",
          retainedTail: inlineBody(JSON.stringify(payload.retainedTail ?? [])),
        },
      });
    },
    onAssistantVisible: async (payload) => {
      await audit?.append({ type: "agent.assistant_visible", sessionId, role, payload });
    },
    onRetry: async (payload) => { await audit?.append({ type: "agent.request_retried", sessionId, role, payload }); },
    onBeforeToolCall: async ({ tool }) => { await audit?.append({ type: "agent.tool_called", sessionId, role, payload: { tool, nativeHook: "before" } }); },
    onAfterToolCall: async (payload) => { await audit?.append({ type: "agent.tool_completed", sessionId, role, payload: { ...payload, nativeHook: "after" } }); },
    onModelRequest: async (payload) => {
      await audit?.append({
        type: "agent.model_request",
        sessionId,
        role,
        payload: { schemaVersion: 1, invocationId: cursor.invocationId, requestIndex: cursor.requestIndex, ...payload },
      });
    },
  };
}

/** One isolated model transcript. A Controller retains one of these per CandidateRun. */
export class AgentSessionHost {
  readonly #sessionId: string;
  readonly #role: string;
  readonly #session: PiTextSession | undefined;
  readonly #audit: AgentAuditSink | undefined;
  readonly #failure: AgentFailure | undefined;
  readonly #inputCapabilities: readonly string[];
  readonly #cursor: InvocationCursor;
  #cancelled = false;
  #closed = false;
  #busy = false;
  readonly #abort = new AbortController();
  #droppedRequestIds = new Set<string>();

  constructor(
    sessionId: string,
    role: string,
    session?: PiTextSession,
    audit?: AgentAuditSink,
    failure?: AgentFailure,
    inputCapabilities: readonly string[] = [],
    cursor: InvocationCursor = { requestIndex: 0 },
  ) {
    this.#sessionId = sessionId;
    this.#role = role;
    this.#session = session;
    this.#audit = audit;
    this.#failure = failure;
    this.#inputCapabilities = inputCapabilities;
    this.#cursor = cursor;
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
    this.#closed = true;
    this.#abort.abort();
    this.#session?.cancel();
    const invocationId = this.#cursor.invocationId;
    if (invocationId) {
      await this.#audit?.append({
        type: "agent.invocation_cancelled",
        sessionId: this.#sessionId,
        role: this.#role,
        payload: { invocationId, ...(factRef ? { factRef } : {}) },
      });
    }
    await this.#audit?.append({
      type: "agent.session_cancelled",
      sessionId: this.#sessionId,
      role: this.#role,
      payload: factRef ? { factRef } : {},
    });
  }

  async close(): Promise<void> {
    if (this.#closed || this.#cancelled) {
      this.#closed = true;
      return;
    }
    this.#closed = true;
    this.#session?.cancel();
    await this.#audit?.append({
      type: "agent.session_completed",
      sessionId: this.#sessionId,
      role: this.#role,
      payload: {},
    });
  }

  async request<T>(
    request: AgentSessionRequest<T>,
  ): Promise<AgentInvocation<T>> {
    assertRequest(request);
    const blocked = this.#blockedInvocation(request);
    if (blocked) return blocked;
    if (this.#busy) throw new Error("Agent session already has an invocation in flight.");
    const invocationId = request.requestId ?? randomUUID();
    this.#busy = true;
    this.#cursor.invocationId = invocationId;
    this.#cursor.requestIndex = 0;
    try {
      await this.#audit?.append({
        type: "agent.invocation_started",
        sessionId: this.#sessionId,
        role: this.#role,
        payload: { invocationId, ...(request.requestId ? { requestId: request.requestId } : {}) },
      });
      return await this.#invoke(request, invocationId);
    } finally {
      this.#busy = false;
      this.#cursor.invocationId = undefined;
    }
  }

  #blockedInvocation<T>(request: AgentSessionRequest<T>): AgentInvocation<T> | undefined {
    if (this.#dropped(request.requestId) || request.signal?.aborted) {
      return { status: "cancelled", sessionId: this.#sessionId };
    }
    if (this.#closed) {
      return {
        status: "failed",
        sessionId: this.#sessionId,
        failure: { code: "agent_failure", message: "Agent session is closed.", attempts: 0 },
      };
    }
    if (this.#failure) return { status: "failed", sessionId: this.#sessionId, failure: this.#failure };
    if (!this.#session) throw new Error("Agent session is unavailable without a recorded failure.");
    return undefined;
  }

  async #invoke<T>(
    request: AgentSessionRequest<T>,
    invocationId: string,
  ): Promise<AgentInvocation<T>> {
    const cancelled = () => this.#dropped(request.requestId) || Boolean(request.signal?.aborted);
    const deadline = request.timeoutMs > 0 ? Date.now() + request.timeoutMs : undefined;
    let lastError: string | undefined;
    for (let attempts = 0; attempts <= request.maxRepairAttempts; attempts += 1) {
      const outcome = await this.#attempt(request, invocationId, attempts, lastError, deadline, cancelled);
      if (outcome.done) return outcome.result;
      lastError = outcome.lastError;
    }
    throw new Error("Agent session repair loop unexpectedly ended.");
  }

  async #attempt<T>(
    request: AgentSessionRequest<T>,
    invocationId: string,
    attempts: number,
    lastError: string | undefined,
    deadline: number | undefined,
    cancelled: () => boolean,
  ): Promise<{ done: true; result: AgentInvocation<T> } | { done: false; lastError: string }> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.#abort.signal, ...(request.signal ? [request.signal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      this.#cursor.requestIndex += 1;
      const content = redactModelVisibleText(capabilityAwarePrompt(promptBody(request, attempts, lastError), this.#inputCapabilities)).text;
      await this.#audit?.append({
        type: "agent.message_appended",
        sessionId: this.#sessionId,
        role: this.#role,
        payload: {
          schemaVersion: 1,
          invocationId,
          requestIndex: this.#cursor.requestIndex,
          byteLength: Buffer.byteLength(content),
          repair: attempts > 0,
          body: inlineBody(content),
          images: await recordedImageRefs(request.promptImages, this.#audit),
        },
      });
      if (request.timeoutMs > 0) {
        const remaining = deadline! - Date.now();
        if (remaining <= 0) throw timeoutError();
        timer = setTimeout(() => controller.abort(), remaining);
      }
      if (cancelled()) return { done: true, result: { status: "cancelled", sessionId: this.#sessionId, invocationId } };
      const text = await abortable(
        this.#session!.append({ content, ...(request.promptImages ? { images: request.promptImages } : {}), signal }),
        signal,
      );
      if (controller.signal.aborted) throw timeoutError();
      if (cancelled()) return { done: true, result: { status: "cancelled", sessionId: this.#sessionId, invocationId } };
      await this.#audit?.append({
        type: "agent.model_output",
        sessionId: this.#sessionId,
        role: this.#role,
        payload: {
          schemaVersion: 1,
          invocationId,
          requestIndex: this.#cursor.requestIndex,
          body: inlineBody(text),
        },
      });
      const decoded = decode(request.schema, text, request.normalize);
      const error = decoded.error ?? request.validate?.(decoded.value as T);
      if (!error && decoded.value !== undefined) {
        await this.#audit?.append({
          type: "agent.invocation_completed",
          sessionId: this.#sessionId,
          role: this.#role,
          payload: { invocationId, attempts: attempts + 1, modelRequests: this.#cursor.requestIndex },
        });
        return {
          done: true,
          result: { status: "completed", value: decoded.value as T, sessionId: this.#sessionId, invocationId },
        };
      }
      const repairError = error ?? "schema validation failed";
      if (attempts === request.maxRepairAttempts) {
        await this.#audit?.append({
          type: "agent.invalid_output",
          sessionId: this.#sessionId,
          role: this.#role,
          payload: { invocationId, ...invalidOutputAudit(repairError, attempts + 1, decoded.value) },
        });
        return { done: true, result: await this.#failed("invalid_output", repairError, attempts + 1, invocationId) };
      }
      return { done: false, lastError: repairError };
    } catch (error) {
      if (cancelled()) return { done: true, result: { status: "cancelled", sessionId: this.#sessionId, invocationId } };
      const kind = isTimeout(error) ? "timeout" : classifyAgentFailure(error);
      if (kind === "cancelled") return { done: true, result: { status: "cancelled", sessionId: this.#sessionId, invocationId } };
      const code = kind === "timeout" ? "agent_timeout" : "agent_failure";
      return { done: true, result: await this.#failed(code, errorMessage(error), attempts + 1, invocationId, kind) };
    } finally {
      if (timer) clearTimeout(timer);
      if (request.timeoutMs > 0) controller.abort();
    }
  }

  async #failed(
    code: AgentFailure["code"],
    message: string,
    attempts: number,
    invocationId?: string,
    kind: AgentFailureKind = code === "invalid_output" ? "protocol" : "unknown",
  ): Promise<AgentInvocation<never>> {
    const failure: AgentFailure = { code, message, attempts, kind };
    await this.#audit?.append({
      type: "agent.invocation_failed",
      sessionId: this.#sessionId,
      role: this.#role,
      payload: {
        ...(invocationId ? { invocationId } : {}),
        ...(code === "invalid_output"
          ? { code, attempts, category: invalidOutputCategory(message) }
          : { code, attempts, kind }),
      },
    });
    return { status: "failed", sessionId: this.#sessionId, failure, ...(invocationId ? { invocationId } : {}) };
  }

  #dropped(requestId?: string): boolean {
    return this.#cancelled || Boolean(requestId && this.#droppedRequestIds.has(requestId));
  }
}

function instrumentTools(
  tools: readonly AgentToolDefinition[],
  sessionId: string,
  role: string,
  cursor: InvocationCursor,
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
        const toolCallId = `${cursor.invocationId ?? sessionId}:tool:${cursor.toolSeq = (cursor.toolSeq ?? 0) + 1}`;
        await audit?.append({
          type: "agent.tool_called",
          sessionId,
          role,
          payload: {
            tool: tool.name,
            toolCallId,
            params: safeParams(params),
            ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
          },
        });
        try {
          const result = await tool.execute(params, signal);
          const visible = redactToolResultForModel(result);
          await tool.onCompleted?.(visible);
          await audit?.append({
            type: "agent.tool_completed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              toolCallId,
              byteLength: contentByteLength(visible),
              contentTypes: contentTypes(visible),
              contentDigest: contentDigest(visible),
              body: toolResultBody(visible),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
              ...(visible.details && typeof visible.details === "object"
                ? { details: safeDetails(visible.details) }
                : {}),
            },
          });
          return visible;
        } catch (error) {
          await audit?.append({
            type: "agent.tool_failed",
            sessionId,
            role,
            payload: {
              tool: tool.name,
              message: errorMessage(error),
              ...(cursor.invocationId ? { invocationId: cursor.invocationId } : {}),
            },
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

async function recordedImageRefs(
  images: readonly ImageContent[] | undefined,
  audit: AgentAuditSink | undefined,
) {
  const refs = imageRefs(images);
  if (!images?.length || !audit?.commitModelInput) return refs;
  const recorded = [];
  for (const [index, image] of images.entries()) {
    const artifact = await audit.commitModelInput(Buffer.from(image.data, "base64"));
    recorded.push({ ...refs[index]!, artifactId: artifact.artifactId });
  }
  return recorded;
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
  const context = request.promptContent ?? JSON.stringify(request.context);
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
  normalize?: (value: unknown) => unknown,
): { value?: unknown; error?: string } {
  const parsed = parse(text);
  if (parsed === undefined) return { error: "invalid JSON" };
  const prepared = normalize ? normalize(parsed) : parsed;
  const cleaned = Value.Clean(schema, prepared);
  if (Value.Check(schema, cleaned)) return { value: cleaned };
  const first = Value.Errors(schema, cleaned).First();
  const path = first?.path || "/";
  const message = first?.message || "failed";
  return { error: `schema validation failed at ${path}: ${message}` };
}

function parse(text: string): unknown {
  const stripped = stripThinkBlocks(text.trim());
  const candidates = [stripJsonFence(stripped), ...balancedJsonObjects(stripped)];
  let last: unknown;
  let found = false;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      last = JSON.parse(candidate) as unknown;
      found = true;
    } catch {
      /* keep scanning; the last successful object wins */
    }
  }
  return found ? last : undefined;
}

function stripThinkBlocks(text: string): string {
  return text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trim();
}

/** Each `{`…`}` span that is a complete JSON object, in document order. */
function balancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const span = sliceBalancedObject(text, index);
    if (span) objects.push(span);
  }
  return objects;
}

function sliceBalancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (character === "\\") escape = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
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

function capabilityAwarePrompt(content: string, inputCapabilities: readonly string[]): string {
  if (!inputCapabilities.length) return content;
  return `modelInputCapabilities=${inputCapabilities.join(",")}\nOnly request or interpret native media whose type is listed above.\n\n${content}`;
}

function contentByteLength(result: AgentToolResult): number {
  if (!result.contentBlocks) return Buffer.byteLength(result.content);
  return result.contentBlocks.reduce((total, block) => total + (block.type === "text" ? Buffer.byteLength(block.text) : Buffer.byteLength(block.data, "base64")), 0);
}

function contentTypes(result: AgentToolResult): string[] {
  return result.contentBlocks ? [...new Set(result.contentBlocks.map((block) => block.type))] : ["text"];
}

function contentDigest(result: AgentToolResult): string {
  return sha256(result.contentBlocks ? JSON.stringify(result.contentBlocks) : result.content);
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



