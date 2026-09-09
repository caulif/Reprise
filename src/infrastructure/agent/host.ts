import { randomUUID } from "node:crypto";
import { sha256 } from "../../core/identity.js";
import { classifyAgentFailure } from "./failure.js";
import { hostContext } from "../platform.js";
import { redactModelVisibleText } from "./model-input.js";
import { callerLoopHooks } from "./audit.js";
import { AgentSessionHost } from "./session.js";
import { instrumentTools } from "./tools.js";
import type {
  AgentHost as AgentHostPort,
  AgentInvocation,
  AgentSessionOptions,
  InvocationCursor,
  ProviderAdapter,
  StructuredAgentRequest,
} from "./types.js";

export type {
  AgentAuditEvent,
  AgentAuditSink,
  AgentContentBlock,
  AgentFailure,
  AgentFailureCode,
  AgentInvocation,
  AgentSession,
  AgentSessionOptions,
  AgentSessionRequest,
  AgentToolDefinition,
  AgentToolResult,
  CompactionPolicy,
  FreeformAgentInvocation,
  FreeformInvocation,
  FreeformWorkRequest,
  ModelConfigSnapshot,
  PrivacyPolicy,
  ProviderAdapter,
  ProviderSession,
  PiTextCaller,
  PiTextSession,
  StructuredAgentRequest,
  StructuredAgentResult,
  StructuredInvocation,
  StructuredWorkRequest,
} from "./types.js";
export type { AgentFailureKind } from "./failure.js";
export { AgentSessionHost } from "./session.js";
export { FakeProviderAdapter } from "./providers/fake/adapter.js";

export class AgentHost implements AgentHostPort {
  readonly #caller: ProviderAdapter;

  constructor(caller: ProviderAdapter) {
    this.#caller = caller;
  }

  async createSession(input: AgentSessionOptions): Promise<AgentSessionHost> {
    if (!input.role.trim() || !input.systemPrompt.trim()) {
      throw new Error("Agent role and system prompt are required.");
    }
    const sessionId = randomUUID();
    const allowModelText = input.privacy?.allowModelText ?? input.allowModelText ?? true;
    if (!allowModelText) {
      await input.audit?.append({
        type: "agent.session_failed",
        sessionId,
        role: input.role,
        payload: { code: "privacy_blocked" },
      });
      return AgentSessionHost.blocked(sessionId, input.role, input.audit);
    }
    const cursor: InvocationCursor = { requestIndex: 0 };
    const tools = instrumentTools(input.tools ?? [], sessionId, input.role, cursor, input.audit);
    const compactionInstructions = input.compaction?.instructions ?? input.compactionInstructions;
    try {
      const session = await this.#caller.createSession({
        sessionId,
        systemPrompt: redactModelVisibleText(input.systemPrompt).text,
        tools,
        ...(compactionInstructions ? { compactionInstructions } : {}),
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
          hostFacts: (() => {
            const host = hostContext();
            return { platform: host.platform, arch: host.arch, pathCase: host.pathCase, shell: host.defaultShell.kind, capabilities: [...host.capabilities].sort() };
          })(),
          ...(input.model ? { model: input.model } : {}),
          ...(session.inputCapabilities ? { inputCapabilities: [...session.inputCapabilities] } : {}),
        },
      });
      return new AgentSessionHost(sessionId, input.role, session, input.audit, undefined, session.inputCapabilities, cursor);
    } catch (error) {
      await input.audit?.append({
        type: "agent.session_failed",
        sessionId,
        role: input.role,
        payload: { code: "agent_failure", message: error instanceof Error ? error.message : String(error) },
      });
      return AgentSessionHost.failed(
        sessionId,
        input.role,
        "agent_failure",
        error instanceof Error ? error.message : String(error),
        input.audit,
        classifyAgentFailure(error),
      );
    }
  }

  async request<T>(request: StructuredAgentRequest<T>): Promise<AgentInvocation<T>> {
    const session = await this.createSession(request);
    try {
      return await session.request({
        ...(request.signal ? { signal: request.signal } : {}),
        context: request.context,
        schema: request.schema,
        timeoutMs: request.timeoutMs,
        maxRepairAttempts: request.maxRepairAttempts,
        ...(request.validate ? { validate: request.validate } : {}),
        ...(request.outputContract ? { outputContract: request.outputContract } : {}),
        ...(request.repairInstruction ? { repairInstruction: request.repairInstruction } : {}),
        ...(request.promptContent ? { promptContent: request.promptContent } : {}),
        ...(request.promptImages ? { promptImages: request.promptImages } : {}),
        ...(request.normalize ? { normalize: request.normalize } : {}),
      });
    } finally {
      await session.close();
    }
  }
}

/** Compatibility alias while callers migrate off the Pi-prefixed Host name. */
export class PiAgentHost extends AgentHost {}
