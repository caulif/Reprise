import { randomUUID } from "node:crypto";
import { classifyAgentFailure, toAgentFailure, type AgentFailureKind } from "./failure.js";
import { inlineBody, redactModelVisibleText } from "./model-input.js";
import { recordedImageRefs } from "./artifacts.js";
import { decodeStructured, invalidOutputAudit, invalidOutputCategory, promptBody } from "./structured.js";
import type {
  AgentAuditSink,
  AgentFailure,
  AgentInvocation,
  FreeformAgentInvocation,
  FreeformInvocation,
  FreeformWorkRequest,
  InvocationCursor,
  ProviderSession,
  StructuredWorkRequest,
} from "./types.js";

type InternalSessionRequest<T> =
  | ({ kind: "freeform" } & FreeformWorkRequest)
  | ({ kind: "structured" } & StructuredWorkRequest<T>);

export class AgentSessionHost {
  readonly #sessionId: string;
  readonly #role: string;
  readonly #session: ProviderSession | undefined;
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
    session?: ProviderSession,
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

  static blocked(sessionId: string, role: string, audit?: AgentAuditSink): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, toAgentFailure({
      code: "privacy_blocked",
      message: "Model text is disallowed by TaskCase privacy policy.",
      attempts: 0,
      kind: "privacy",
      retryable: false,
    }));
  }

  static failed(
    sessionId: string,
    role: string,
    code: AgentFailure["code"],
    message: string,
    audit?: AgentAuditSink,
    kind: AgentFailureKind = "unknown",
  ): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, toAgentFailure({ code, message, attempts: 0, kind }));
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
    await this.#session?.waitForIdle?.();
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

  async work(request: FreeformWorkRequest): Promise<FreeformInvocation> {
    return this.#dispatch({ kind: "freeform", ...request });
  }

  async request<T>(request: StructuredWorkRequest<T>): Promise<AgentInvocation<T>> {
    return this.#dispatch({ kind: "structured", ...request });
  }

  async requestFreeform(request: FreeformWorkRequest): Promise<FreeformAgentInvocation> {
    const result = await this.work(request);
    if (result.status !== "completed") return result;
    return {
      status: "completed",
      sessionId: result.sessionId,
      ...(result.invocationId ? { invocationId: result.invocationId } : {}),
    };
  }

  async #dispatch(request: { kind: "freeform" } & FreeformWorkRequest): Promise<FreeformInvocation>;
  async #dispatch<T>(request: { kind: "structured" } & StructuredWorkRequest<T>): Promise<AgentInvocation<T>>;
  async #dispatch<T>(request: InternalSessionRequest<T>): Promise<AgentInvocation<T> | FreeformInvocation> {
    assertRequest(request);
    const blocked = this.#blockedInvocation(request);
    if (blocked) return blocked;
    if (this.#busy) {
      return {
        status: "failed",
        sessionId: this.#sessionId,
        failure: toAgentFailure({
          code: "concurrent_invocation",
          message: "Agent session already has an invocation in flight.",
          attempts: 0,
          kind: "protocol",
          retryable: false,
        }),
      };
    }
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
    } catch (error) {
      if (isAuditError(error)) {
        return this.#failed("audit_failure", errorMessage(error), 0, invocationId, "persistence");
      }
      throw error;
    } finally {
      this.#busy = false;
      this.#cursor.invocationId = undefined;
    }
  }

  #blockedInvocation(request: { requestId?: string; signal?: AbortSignal }): FreeformInvocation | undefined {
    if (this.#dropped(request.requestId) || request.signal?.aborted) {
      return { status: "cancelled", sessionId: this.#sessionId };
    }
    if (this.#closed) {
      return {
        status: "failed",
        sessionId: this.#sessionId,
        failure: toAgentFailure({
          code: "session_closed",
          message: "Agent session is closed.",
          attempts: 0,
          kind: "protocol",
          retryable: false,
        }),
      };
    }
    if (this.#failure) return { status: "failed", sessionId: this.#sessionId, failure: this.#failure };
    if (!this.#session) throw new Error("Agent session is unavailable without a recorded failure.");
    return undefined;
  }

  async #invoke<T>(
    request: InternalSessionRequest<T>,
    invocationId: string,
  ): Promise<AgentInvocation<T> | FreeformInvocation> {
    const cancelled = () => this.#dropped(request.requestId) || Boolean(request.signal?.aborted);
    const deadline = request.timeoutMs > 0 ? Date.now() + request.timeoutMs : undefined;
    const repairLimit = request.kind === "freeform" ? 0 : request.maxRepairAttempts;
    let lastError: string | undefined;
    for (let attempts = 0; attempts <= repairLimit; attempts += 1) {
      const outcome = await this.#attempt(request, invocationId, attempts, lastError, deadline, cancelled);
      if (outcome.done) return outcome.result;
      lastError = outcome.lastError;
    }
    throw new Error("Agent session repair loop unexpectedly ended.");
  }

  async #attempt<T>(
    request: InternalSessionRequest<T>,
    invocationId: string,
    attempts: number,
    lastError: string | undefined,
    deadline: number | undefined,
    cancelled: () => boolean,
  ): Promise<{ done: true; result: AgentInvocation<T> | FreeformInvocation } | { done: false; lastError: string }> {
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
        payload: { schemaVersion: 1, invocationId, requestIndex: this.#cursor.requestIndex, body: inlineBody(text) },
      });
      if (request.kind === "freeform") {
        await this.#audit?.append({
          type: "agent.invocation_completed",
          sessionId: this.#sessionId,
          role: this.#role,
          payload: { invocationId, attempts: attempts + 1, modelRequests: this.#cursor.requestIndex },
        });
        return {
          done: true,
          result: { status: "completed", value: { text }, sessionId: this.#sessionId, invocationId },
        };
      }
      const decoded = decodeStructured(request.schema, text, request.normalize);
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
        return { done: true, result: await this.#failed("invalid_output", repairError, attempts + 1, invocationId, "protocol") };
      }
      return { done: false, lastError: repairError };
    } catch (error) {
      if (cancelled()) return { done: true, result: { status: "cancelled", sessionId: this.#sessionId, invocationId } };
      if (isAuditError(error)) {
        return { done: true, result: await this.#failed("audit_failure", errorMessage(error), attempts + 1, invocationId, "persistence") };
      }
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
    const failure = toAgentFailure({ code, message, attempts, kind });
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

function assertRequest<T>(request: InternalSessionRequest<T>): void {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 0) {
    throw new Error("Agent request limits are invalid.");
  }
  if (request.kind === "freeform") {
    if (!request.promptContent.trim()) throw new Error("Freeform work requests require promptContent.");
    if (request.maxRepairAttempts !== undefined && request.maxRepairAttempts !== 0) {
      throw new Error("Freeform work requests cannot run JSON repair.");
    }
    return;
  }
  if (!Number.isInteger(request.maxRepairAttempts) || request.maxRepairAttempts < 0) {
    throw new Error("Agent request limits are invalid.");
  }
}

function capabilityAwarePrompt(content: string, inputCapabilities: readonly string[]): string {
  if (!inputCapabilities.length) return content;
  return `modelInputCapabilities=${inputCapabilities.join(",")}\nOnly request or interpret native media whose type is listed above.\n\n${content}`;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function timeoutError(): Error {
  const error = new Error("agent timeout");
  error.name = "TimeoutError";
  return error;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.message === "agent timeout");
}

function isAuditError(error: unknown): boolean {
  return error instanceof Error && /\baudit\b/i.test(error.message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
