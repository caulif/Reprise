import type { TSchema } from "@sinclair/typebox";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentFailureKind } from "./failure.js";

export type { AgentFailureKind };

export type AgentContentBlock = TextContent | ImageContent;

export type AgentToolResult = {
  content: string;
  contentBlocks?: readonly AgentContentBlock[];
  details?: unknown;
};

export type AgentFailureCode =
  | "agent_timeout"
  | "agent_failure"
  | "invalid_output"
  | "privacy_blocked"
  | "audit_failure"
  | "session_closed"
  | "concurrent_invocation";

export type AgentFailure = {
  kind?: AgentFailureKind;
  code: AgentFailureCode;
  message: string;
  attempts: number;
  retryable?: boolean;
};

export type AgentInvocation<T> =
  | { status: "completed"; value: T; sessionId: string; invocationId?: string }
  | { status: "failed"; failure: AgentFailure; sessionId?: string; invocationId?: string }
  | { status: "cancelled"; factRef?: string; sessionId?: string; invocationId?: string };

export type StructuredAgentResult<T> = AgentInvocation<T>;
/** Optional visible diagnostic for audit; business agents must not depend on `text`. */
export type FreeformInvocation = AgentInvocation<{ text?: string }>;
export type StructuredInvocation<T> = AgentInvocation<T>;
export type FreeformAgentInvocation =
  | { status: "completed"; sessionId: string; invocationId?: string }
  | { status: "failed"; failure: AgentFailure; sessionId?: string; invocationId?: string }
  | { status: "cancelled"; factRef?: string; sessionId?: string; invocationId?: string };

export type AgentToolDefinition = {
  name: string;
  description: string;
  parameters: TSchema;
  execute(params: unknown, signal: AbortSignal): Promise<AgentToolResult>;
  onCompleted?(result: AgentToolResult): Promise<void>;
};

export type AgentAuditEventType =
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

export type AgentAuditEvent = {
  type: AgentAuditEventType;
  sessionId: string;
  role: string;
  payload: Record<string, unknown>;
};

export type AgentAuditSink = {
  append(event: AgentAuditEvent): Promise<void>;
  commitModelInput?(bytes: Uint8Array): Promise<{ artifactId: string; contentHash: string; byteLength: number }>;
};

export type ModelConfigSnapshot = {
  providerId: string;
  modelId: string;
  contextWindow?: number;
  maxTokens?: number;
  inputCapabilities?: readonly string[];
};

export type PrivacyPolicy = {
  allowModelText: boolean;
  allowBinary?: boolean;
};

export type CompactionPolicy = {
  reserveTokens: number;
  keepRecentTokens: number;
  instructions?: string;
};

export type AgentSessionOptions = {
  role: string;
  systemPrompt: string;
  model?: ModelConfigSnapshot;
  tools?: readonly AgentToolDefinition[];
  compaction?: CompactionPolicy;
  privacy?: PrivacyPolicy;
  audit?: AgentAuditSink;
  allowModelText?: boolean;
  compactionInstructions?: string;
};

export type FreeformWorkRequest = {
  promptContent: string;
  promptImages?: readonly ImageContent[];
  signal?: AbortSignal;
  timeoutMs: number;
  requestId?: string;
  maxRepairAttempts?: number;
};

export type StructuredWorkRequest<T> = {
  context: unknown;
  schema: TSchema;
  timeoutMs: number;
  maxRepairAttempts: number;
  validate?: (value: T) => string | undefined;
  outputContract?: string;
  repairInstruction?: string;
  promptContent?: string;
  promptImages?: readonly ImageContent[];
  normalize?: (value: unknown) => unknown;
  signal?: AbortSignal;
  requestId?: string;
};

export type AgentSessionRequest<T> = StructuredWorkRequest<T>;

export type StructuredAgentRequest<T> = StructuredWorkRequest<T> & {
  role: string;
  systemPrompt: string;
  allowModelText: boolean;
  tools?: readonly AgentToolDefinition[];
  compactionInstructions?: string;
  audit?: AgentAuditSink;
};

export interface AgentSession {
  readonly sessionId: string;
  work(input: FreeformWorkRequest): Promise<FreeformInvocation>;
  request<T>(input: StructuredWorkRequest<T>): Promise<StructuredInvocation<T>>;
  cancel(reason?: string, requestId?: string): Promise<void>;
  close(): Promise<void>;
}

export interface AgentHost {
  createSession(input: AgentSessionOptions): Promise<AgentSession>;
}

export interface ProviderSession {
  readonly inputCapabilities?: readonly string[];
  append(input: { content: string; images?: readonly ImageContent[]; signal: AbortSignal }): Promise<string>;
  cancel(): void;
  waitForIdle?(): Promise<void>;
}

export type InvocationCursor = {
  invocationId?: string | undefined;
  requestIndex: number;
  toolSeq?: number;
  lastToolCallId?: string;
};

export interface ProviderAdapter {
  createSession(input: {
    sessionId: string;
    systemPrompt: string;
    tools: readonly AgentToolDefinition[];
    compactionInstructions?: string;
    onContextCompact?: (payload: {
      summary: string;
      tokensBefore: number;
      retainedCount: number;
      reason?: string;
      retainedTail?: readonly unknown[];
    }) => Promise<void>;
    onRetry?: (payload: { attempt: number; kind: string; delayMs: number }) => Promise<void>;
    onAssistantVisible?: (payload: { text: string; turn: number }) => Promise<void>;
    onBeforeToolCall?: (payload: { tool: string }) => Promise<void>;
    onAfterToolCall?: (payload: {
      tool: string;
      isError: boolean;
      contentTypes: readonly string[];
      byteLength: number;
      contentDigest: string;
    }) => Promise<void>;
    onModelRequest?: (payload: { model: string; digest: string; messageCount: number }) => Promise<void>;
  }): Promise<ProviderSession> | ProviderSession;
}

/** Compatibility names during migration; public contracts do not require Pi types. */
export type PiTextSession = ProviderSession;
export type PiTextCaller = ProviderAdapter;
