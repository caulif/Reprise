import type { RuntimePort } from '../core/runtime.js';
import type { JsonRecord } from '../core/json.js';
import type { CandidateSpec, EventEnvelope, TaskCase } from '../core/schema.js';

export type SessionMessage = TaskCase['transcript'][number];

export type SessionSignals = {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly completedTurns: number;
};

export type SessionSummary = {
  readonly productId: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly startedAt: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly summary?: string;
  readonly signals: SessionSignals;
};

export type SessionInspection = SessionSummary & {
  readonly transcript: readonly SessionMessage[];
  readonly finalMessage?: string;
  readonly sourceVersion?: string;
  readonly historicalCommit?: string;
};

export type SessionPrivacy = {
  readonly allowModelText: boolean;
  readonly allowBinary: boolean;
  readonly redactions: readonly string[];
};

export type SessionRef = {
  readonly productId: string;
  readonly sessionId: string;
  readonly sourcePath?: string;
};

export type SessionDiscoveryQuery = {
  readonly root?: string;
  readonly limit?: number;
  readonly excludeRoots?: readonly string[];
};

export type ImportDiagnostic = {
  readonly code: string;
  readonly message: string;
};

export type ImportedRawFile = {
  readonly relativePath: string;
  readonly text: string;
};

export type ImportedExtraFile = {
  readonly relativePath: string;
  readonly bytes: Buffer;
};

/** Product-agnostic snapshot. Freeze assigns caseId, privacy, and content hash. */
export type ImportedSession = {
  readonly source: SessionRef;
  readonly initialInput: SessionMessage;
  readonly transcript: readonly SessionMessage[];
  readonly historicalEvents: readonly JsonRecord[];
  readonly baseline: TaskCase['baseline'];
  readonly sourceRuntimeEvidence: TaskCase['sourceRuntimeEvidence'];
  readonly taskContext?: TaskCase['taskContext'];
  readonly provenance: { readonly packVersion: string };
  readonly raw: ImportedRawFile;
  readonly extraFiles?: readonly ImportedExtraFile[];
  readonly diagnostics: readonly ImportDiagnostic[];
  readonly signals: SessionSignals;
};

/** Completed sessions with a user task and at least one assistant message or tool call. */
export function isEligibleSession(session: SessionSummary): boolean {
  return session.signals.completedTurns > 0 && session.signals.userMessages > 0
    && (session.signals.assistantMessages > 0 || session.signals.toolCalls > 0);
}

export type SessionSourceAdapter = {
  readonly defaultRoot: string;
  discover(query?: SessionDiscoveryQuery): Promise<readonly SessionSummary[]>;
  inspect(ref: SessionRef): Promise<SessionInspection>;
  import(ref: SessionRef): Promise<ImportedSession>;
};

export type FileChange = {
  readonly path: string;
  readonly kind?: string;
  readonly diff?: string;
};

export type ActivityStatus = 'started' | 'completed' | 'failed';

/** TUI-owned closed vocabulary. Packs may only choose from these kinds. */
export type TargetActivity =
  | { readonly kind: 'prompt'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text?: string; readonly streaming?: true }
  | { readonly kind: 'message'; readonly text?: string; readonly streaming?: true }
  | {
    readonly kind: 'command';
    readonly command: string;
    readonly status: ActivityStatus;
    readonly output?: string;
    readonly cwd?: string;
    readonly exitCode?: number;
    readonly durationMs?: number;
    readonly blockedBySandbox?: true;
    readonly actions?: readonly string[];
  }
  | { readonly kind: 'file_change'; readonly changes: readonly FileChange[]; readonly completed?: boolean }
  | { readonly kind: 'web_search'; readonly query?: string; readonly completed: boolean }
  | { readonly kind: 'tool_call'; readonly name: string; readonly status: ActivityStatus; readonly body?: string }
  | { readonly kind: 'subtask'; readonly name: string; readonly status: ActivityStatus; readonly body?: string }
  | { readonly kind: 'schedule'; readonly name: string; readonly status: ActivityStatus; readonly body?: string }
  | { readonly kind: 'plan'; readonly steps: readonly { readonly status: string; readonly step: string }[] }
  | {
    readonly kind: 'token_usage';
    readonly total: number;
    readonly input?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly cached?: number;
  }
  | { readonly kind: 'sandbox_notice'; readonly label: string; readonly identity?: string; readonly caveat?: string }
  | { readonly kind: 'runtime_error'; readonly message: string }
  | { readonly kind: 'other'; readonly label: string; readonly body?: string };

export type TargetActivityEntry = {
  readonly activity: TargetActivity;
  readonly correlationId?: string;
  readonly merge?: 'replace' | 'append';
};

export type TargetRunFacts = {
  readonly finalMessage?: string;
  readonly commands: readonly string[];
  readonly rejectedApprovals: number;
  readonly evidenceEvents: readonly EventEnvelope[];
};

export interface TargetActivityTranslator {
  /** Only this pack's namespace. Empty means keep the event in the trace, not the timeline. */
  translate(event: EventEnvelope): readonly TargetActivityEntry[];
  inspectRunFacts(events: readonly EventEnvelope[]): TargetRunFacts;
}

export type ProductAuthStatus = {
  readonly configured: boolean;
  readonly provider?: string;
  readonly source?: string;
  readonly detail?: string;
};

export type ProductPackManifest = {
  readonly productId: string;
  readonly displayName: string;
  readonly packVersion: string;
  readonly schemaVersion: number;
  readonly sessionSchemaVersions?: readonly string[];
};

export type RecoveryPlaybookDescriptor = {
  readonly version: string;
  readonly sha256: string;
  readonly text: string;
};

export interface ProductPack {
  readonly manifest: ProductPackManifest;
  readonly sessions: SessionSourceAdapter;
  readonly runtime: RuntimePort;
  readonly activity: TargetActivityTranslator;
  recoveryPlaybook(): RecoveryPlaybookDescriptor;
  checkAuth(): Promise<ProductAuthStatus>;
  defaultCandidate(): CandidateSpec;
}
