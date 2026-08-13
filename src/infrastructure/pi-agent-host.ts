import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

export type AgentFailure = {
  code: 'agent_timeout' | 'agent_failure' | 'invalid_output' | 'privacy_blocked';
  message: string;
  attempts: number;
};

/** A failed invocation deliberately has no T: Host facts must not become model decisions. */
export type AgentInvocation<T> =
  | { status: 'completed'; value: T; sessionId: string }
  | { status: 'failed'; failure: AgentFailure; sessionId?: string }
  | { status: 'cancelled'; factRef?: string; sessionId?: string };
/** Compatibility name during the staged migration; it no longer has a fallback value. */
export type StructuredAgentResult<T> = AgentInvocation<T>;

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(params: unknown, signal: AbortSignal): Promise<{ content: string; details?: unknown }>;
};

export type AgentAuditEvent = {
  type: 'agent.session_started' | 'agent.session_completed' | 'agent.session_failed' | 'agent.session_cancelled' | 'agent.message_appended' | 'agent.tool_called' | 'agent.tool_completed' | 'agent.tool_failed';
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
  }): Promise<PiTextSession> | PiTextSession;
}

export type StructuredAgentRequest<T> = {
  role: string;
  systemPrompt: string;
  context: unknown;
  schema: TSchema;
  timeoutMs: number;
  maxRepairAttempts: number;
  allowModelText: boolean;
  tools?: readonly AgentToolDefinition[];
  validate?: (value: T) => string | undefined;
  audit?: AgentAuditSink;
};

export type AgentSessionRequest<T> = Pick<StructuredAgentRequest<T>, 'context' | 'schema' | 'timeoutMs' | 'maxRepairAttempts' | 'validate'>;

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
      await input.audit?.append({ type: 'agent.session_failed', sessionId, role: input.role, payload: { code: 'privacy_blocked' } });
      return AgentSessionHost.blocked(sessionId, input.role, input.audit);
    }
    const tools = instrumentTools(input.tools ?? [], sessionId, input.role, input.audit);
    try {
      const session = await this.#caller.createSession({ sessionId, systemPrompt: input.systemPrompt, tools });
      await input.audit?.append({ type: 'agent.session_started', sessionId, role: input.role, payload: { toolNames: tools.map((tool) => tool.name) } });
      return new AgentSessionHost(sessionId, input.role, session, input.audit);
    } catch (error) {
      await input.audit?.append({ type: 'agent.session_failed', sessionId, role: input.role, payload: { code: 'agent_failure', message: errorMessage(error) } });
      return AgentSessionHost.failed(sessionId, input.role, 'agent_failure', errorMessage(error), input.audit);
    }
  }

  async request<T>(request: StructuredAgentRequest<T>): Promise<AgentInvocation<T>> {
    const session = await this.createSession(request);
    return session.request({
      context: request.context, schema: request.schema, timeoutMs: request.timeoutMs, maxRepairAttempts: request.maxRepairAttempts,
      ...(request.validate ? { validate: request.validate } : {}),
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

  constructor(sessionId: string, role: string, session?: PiTextSession, audit?: AgentAuditSink, failure?: AgentFailure) {
    this.#sessionId = sessionId;
    this.#role = role;
    this.#session = session;
    this.#audit = audit;
    this.#failure = failure;
  }

  static blocked(sessionId: string, role: string, audit?: AgentAuditSink): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, { code: 'privacy_blocked', message: 'Model text is disallowed by TaskCase privacy policy.', attempts: 0 });
  }

  static failed(sessionId: string, role: string, code: AgentFailure['code'], message: string, audit?: AgentAuditSink): AgentSessionHost {
    return new AgentSessionHost(sessionId, role, undefined, audit, { code, message, attempts: 0 });
  }

  get sessionId(): string { return this.#sessionId; }

  async cancel(factRef?: string): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#session?.cancel();
    await this.#audit?.append({ type: 'agent.session_cancelled', sessionId: this.#sessionId, role: this.#role, payload: factRef ? { factRef } : {} });
  }

  async request<T>(request: AgentSessionRequest<T>): Promise<AgentInvocation<T>> {
    assertRequest(request);
    if (this.#cancelled) return { status: 'cancelled', sessionId: this.#sessionId };
    if (this.#failure) return { status: 'failed', sessionId: this.#sessionId, failure: this.#failure };
    if (!this.#session) throw new Error('Agent session is unavailable without a recorded failure.');
    let attempts = 0;
    for (; attempts <= request.maxRepairAttempts; attempts += 1) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const content = JSON.stringify(request.context);
        const repair = attempts ? 'Your prior response was invalid. Return only JSON conforming to the required schema.\n\n' : '';
        await this.#audit?.append({ type: 'agent.message_appended', sessionId: this.#sessionId, role: this.#role, payload: { byteLength: Buffer.byteLength(content), repair: attempts > 0 } });
        timer = setTimeout(() => controller.abort(), request.timeoutMs);
        const text = await abortable(this.#session.append({ content: `${repair}${content}`, signal: controller.signal }), controller.signal);
        if (controller.signal.aborted) throw timeoutError();
        const candidate = parse(text);
        const error = candidate === undefined || !Value.Check(request.schema, candidate)
          ? 'schema validation failed'
          : request.validate?.(candidate as T);
        if (!error) {
          await this.#audit?.append({ type: 'agent.session_completed', sessionId: this.#sessionId, role: this.#role, payload: { attempts: attempts + 1 } });
          return { status: 'completed', value: candidate as T, sessionId: this.#sessionId };
        }
        if (attempts === request.maxRepairAttempts) return this.#failed('invalid_output', error, attempts + 1);
      } catch (error) {
        if (this.#cancelled || isAbort(error) && !isTimeout(error)) return { status: 'cancelled', sessionId: this.#sessionId };
        if (attempts === request.maxRepairAttempts) return this.#failed(isTimeout(error) ? 'agent_timeout' : 'agent_failure', errorMessage(error), attempts + 1);
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    }
    throw new Error('Agent session repair loop unexpectedly ended.');
  }

  async #failed(code: AgentFailure['code'], message: string, attempts: number): Promise<AgentInvocation<never>> {
    const failure = { code, message, attempts } as AgentFailure;
    await this.#audit?.append({ type: 'agent.session_failed', sessionId: this.#sessionId, role: this.#role, payload: failure });
    return { status: 'failed', sessionId: this.#sessionId, failure };
  }
}

function instrumentTools(tools: readonly AgentToolDefinition[], sessionId: string, role: string, audit?: AgentAuditSink): AgentToolDefinition[] {
  const names = new Set<string>();
  return tools.map((tool) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool.name) || !tool.description.trim() || names.has(tool.name)) throw new Error('Agent tool definitions require unique safe names and descriptions.');
    names.add(tool.name);
    return {
      ...tool,
      async execute(params, signal) {
        await audit?.append({ type: 'agent.tool_called', sessionId, role, payload: { tool: tool.name, params: safeParams(params) } });
        try {
          const result = await tool.execute(params, signal);
          await audit?.append({ type: 'agent.tool_completed', sessionId, role, payload: { tool: tool.name, byteLength: Buffer.byteLength(result.content) } });
          return result;
        } catch (error) {
          await audit?.append({ type: 'agent.tool_failed', sessionId, role, payload: { tool: tool.name, message: errorMessage(error) } });
          throw error;
        }
      },
    };
  });
}

function assertSessionInput(input: { role: string; systemPrompt: string }): void {
  if (!input.role.trim() || !input.systemPrompt.trim()) throw new Error('Agent role and system prompt are required.');
}

function assertRequest<T>(request: AgentSessionRequest<T>): void {
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isInteger(request.maxRepairAttempts) || request.maxRepairAttempts < 0) {
    throw new Error('Agent request limits are invalid.');
  }
}

function parse(text: string): unknown | undefined {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(timeoutError());
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function timeoutError(): Error { const error = new Error('agent timeout'); error.name = 'TimeoutError'; return error; }
function isTimeout(error: unknown): boolean { return error instanceof Error && (error.name === 'TimeoutError' || error.message === 'agent timeout'); }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valueType: typeof value };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, key === 'content' && typeof item === 'string' ? { byteLength: Buffer.byteLength(item) } : key === 'path' ? 'relative-path' : typeof item]));
}
