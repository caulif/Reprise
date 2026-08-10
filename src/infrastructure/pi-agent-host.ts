import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

export type AgentCapability = 'read_observation' | 'read_artifact' | 'write_staging';
export type AgentDiagnostic = { code: 'agent_timeout' | 'agent_failure' | 'invalid_output' | 'privacy_blocked'; attempts: number };
export type StructuredAgentResult<T> = { value: T; usedFallback: boolean; diagnostic?: AgentDiagnostic };
export type StructuredAgentRequest<T> = {
  systemPrompt: string;
  context: unknown;
  schema: TSchema;
  timeoutMs: number;
  maxRepairAttempts: number;
  fallback: T;
  allowModelText: boolean;
  capabilities: readonly AgentCapability[];
  validate?: (value: T) => string | undefined;
};

export interface PiTextCaller {
  complete(input: { systemPrompt: string; contextJson: string; repair?: string; capabilities: readonly AgentCapability[] }, signal: AbortSignal): Promise<string>;
}

/**
 * Shared deterministic boundary around independent Pi-backed Agent sessions.
 * It owns schema checks and fallback, not domain decisions or tool execution.
 */
export class PiAgentHost {
  readonly #caller: PiTextCaller;

  constructor(caller: PiTextCaller) {
    this.#caller = caller;
  }

  async request<T>(request: StructuredAgentRequest<T>): Promise<StructuredAgentResult<T>> {
    assertRequest(request);
    if (!request.allowModelText) return { value: request.fallback, usedFallback: true, diagnostic: { code: 'privacy_blocked', attempts: 0 } };
    let contextJson: string;
    try {
      contextJson = JSON.stringify(request.context);
    } catch {
      return { value: request.fallback, usedFallback: true, diagnostic: { code: 'invalid_output', attempts: 0 } };
    }
    for (let attempt = 0; attempt <= request.maxRepairAttempts; attempt += 1) {
      const response = await this.#complete(request, contextJson, attempt);
      if ('error' in response) {
        if (attempt === request.maxRepairAttempts) return { value: request.fallback, usedFallback: true, diagnostic: { code: response.error, attempts: attempt + 1 } };
        continue;
      }
      const candidate = parse(response.text);
      if (candidate !== undefined && Value.Check(request.schema, candidate) && !request.validate?.(candidate as T)) {
        return { value: candidate as T, usedFallback: false };
      }
      if (attempt === request.maxRepairAttempts) return { value: request.fallback, usedFallback: true, diagnostic: { code: 'invalid_output', attempts: attempt + 1 } };
    }
    throw new Error('PiAgentHost repair loop unexpectedly ended.');
  }

  async #complete<T>(request: StructuredAgentRequest<T>, contextJson: string, attempt: number): Promise<{ text: string } | { error: 'agent_timeout' | 'agent_failure' }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('agent timeout')); }, request.timeoutMs);
    });
    try {
      const text = await Promise.race([
        this.#caller.complete({
          systemPrompt: request.systemPrompt,
          contextJson,
          ...(attempt ? { repair: 'Return only JSON that conforms to the requested output schema.' } : {}),
          capabilities: request.capabilities,
        }, controller.signal),
        deadline,
      ]);
      return { text };
    } catch (error) {
      return { error: isTimeout(error) ? 'agent_timeout' : 'agent_failure' };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }
}

function assertRequest<T>(request: StructuredAgentRequest<T>): void {
  if (!request.systemPrompt.trim() || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || !Number.isInteger(request.maxRepairAttempts) || request.maxRepairAttempts < 0) {
    throw new Error('PiAgentHost request limits and prompt are invalid.');
  }
}

function parse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'agent timeout';
}

// ponytail: callers are injected until a real provider/session is explicitly approved; add a Pi Agent adapter at that boundary, not a second host abstraction.
