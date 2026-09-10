import type { ProductRuntime, TurnSettlement } from '../core/runtime.js';
import type { JsonRecord } from '../core/json.js';
import type {
  CandidateSpec,
  EventEnvelope,
  RecoveryDiagnostic,
  RecoveryReadiness,
  TaskCase,
  UserVisibleTurn,
} from '../core/schema.js';

export type {
  CandidateLaunchContext,
  CandidateSessionHandle,
  CandidateRuntimeEvent,
  UserVisibleTurn,
  RecoveryDiagnostic,
  RecoveryReadiness,
} from '../core/schema.js';

export type SessionMessage = TaskCase['transcript'][number];

export type SessionEvidenceLevel = 'transcript' | 'history';

export type SessionSignals = {
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly completedTurns: number;
};

export type KnownInstant = {
  readonly value: string;
  readonly source: 'event' | 'file-mtime' | 'filename';
};

export type SessionSummary = {
  readonly productId: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  /** Missing rather than fabricated when the source does not expose a valid start instant. */
  readonly startedAt?: string;
  /** Provenance for the displayed start time, kept separate for backwards-compatible consumers. */
  readonly startedAtSource?: KnownInstant['source'];
  /** Latest source event or file update, used for stable discovery ordering when available. */
  readonly updatedAt?: string;
  /** Provenance for the displayed update time. */
  readonly updatedAtSource?: KnownInstant['source'];
  readonly cwd?: string;
  readonly model?: string;
  readonly summary?: string;
  /** Later user texts from the same bounded head; list titles may prefer a short task over an instruction block. */
  readonly laterUserSummaries?: readonly string[];
  /** The bounded head was sufficient for a safe list item, but not a complete summary. */
  readonly partial?: boolean;
  readonly signals: SessionSignals;
  /** Internal evidence strength. TUI keeps one workflow regardless of this value. */
  readonly evidenceLevel?: SessionEvidenceLevel;
  /** Internal discovery provenance; adapters may omit it for legacy sources. */
  readonly sourceKind?: 'catalog+transcript' | 'catalog-only' | 'rollout-only' | 'projectless' | 'unknown';
  readonly availability?: 'indexed' | 'catalog-only' | 'unindexed' | 'unreadable';
  /** Transcript recovery, independent of whether the source file exists. */
  readonly recoveryReadiness?: RecoveryReadiness;
  readonly recoveryDiagnostics?: readonly RecoveryDiagnostic[];
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

export type DiscoveryDiagnosticCode =
  | 'excluded'
  | 'stale-cursor'
  | 'too-large'
  | 'unreadable-directory'
  | 'unreadable-file'
  | 'invalid-jsonl'
  | 'invalid-metadata'
  /** Claude's prompt history refers to a session whose replay transcript is no longer local. */
  | 'history-without-transcript'
  | 'unsupported-entry'
  | 'catalog-unavailable'
  | 'catalog-schema-unsupported'
  | 'catalog-read-error'
  | 'global-state-unavailable'
  | 'source-missing'
  | 'duplicate-source'
  | 'conflicting-project-source';

/** Aggregate information about local records discovery intentionally did not surface. */
export type DiscoveryDiagnostic = {
  readonly code: DiscoveryDiagnosticCode;
  readonly count: number;
  readonly samplePath?: string;
};

export type SessionDiscoveryProject = {
  readonly key: string;
  readonly label: string;
  readonly path?: string;
};

export type SessionDiscoveryPage = {
  readonly items: readonly SessionSummary[];
  readonly projects?: readonly SessionDiscoveryProject[];
  /** Opaque continuation token bound to one product root and its stable file ordering. */
  readonly nextCursor?: string;
  readonly scanned: number;
  readonly skipped: number;
  /** All discovery-index diagnostics for standalone consumers. */
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  /** Root-enumeration and immutable summary-index diagnostics, repeated on every cursor page so consumers can avoid double counting them. */
  readonly rootDiagnostics?: readonly DiscoveryDiagnostic[];
  /** Optional diagnostics generated while an adapter examines only this cursor page. */
  readonly pageDiagnostics?: readonly DiscoveryDiagnostic[];
};

export type SessionDiscoveryQuery = {
  readonly root?: string;
  readonly limit?: number;
  readonly cursor?: string;
  /** Exact product session ids. Does not imply cwd or project exclusion. */
  readonly excludeSessionIds?: readonly string[];
  /** Exact source files after normalization and containment in the discovery root. */
  readonly excludeSourcePaths?: readonly string[];
  /** Explicit source-directory exclusion. Never applied to session cwd. */
  readonly excludeRoots?: readonly string[];
  readonly signal?: AbortSignal;
  /** Rebuild the current root's in-memory summary index. */
  readonly refresh?: boolean;
};

export type ImportDiagnostic = {
  readonly code: string;
  readonly message: string;
};

export type ImportedRawFile = {
  readonly relativePath: string;
  readonly text: string;
  readonly sourcePath?: string;
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
  /** Defaults to transcript for adapters written before evidence-aware intake. */
  readonly evidenceLevel?: SessionEvidenceLevel;
  /** Internal discovery provenance; adapters may omit it for legacy sources. */
  readonly sourceKind?: 'catalog+transcript' | 'catalog-only' | 'rollout-only' | 'projectless' | 'unknown';
  readonly availability?: 'indexed' | 'catalog-only' | 'unindexed' | 'unreadable';
  readonly recoveryReadiness?: RecoveryReadiness;
  readonly recoveryDiagnostics?: readonly RecoveryDiagnostic[];
};

/** Completed sessions with a user task and at least one assistant message or tool call. */
export function isEligibleSession(session: SessionSummary): boolean {
  if (session.evidenceLevel === 'history') return session.signals.userMessages > 0;
  return session.signals.completedTurns > 0 && session.signals.userMessages > 0
    && (session.signals.assistantMessages > 0 || session.signals.toolCalls > 0);
}

export type ProductHistoryReader = {
  readonly defaultRoot: string;
  discover(query?: SessionDiscoveryQuery): Promise<SessionDiscoveryPage>;
  inspect(ref: SessionRef): Promise<SessionInspection>;
  import(ref: SessionRef): Promise<ImportedSession>;
};

export type TargetRunFacts = {
  /** Ordered public assistant texts in the inspected event set. */
  readonly assistantTexts?: readonly string[];
  /** Last public assistant text in that set; run-level summary, not the turn surface. */
  readonly finalMessage?: string;
  readonly prompt?: string;
  readonly commands: readonly string[];
  readonly rejectedApprovals: number;
  readonly evidenceEvents: readonly EventEnvelope[];
};

export function publicAssistantFacts(texts: readonly (string | undefined)[]): Pick<TargetRunFacts, "assistantTexts" | "finalMessage"> {
  const assistantTexts = texts.map((value) => value?.trim() ?? "").filter(Boolean);
  const finalMessage = assistantTexts.at(-1);
  return {
    ...(assistantTexts.length ? { assistantTexts } : {}),
    ...(finalMessage ? { finalMessage } : {}),
  };
}

export function joinPublicAssistantSurface(texts: readonly string[] | undefined): string | undefined {
  const parts = (texts ?? []).map((value) => value.trim()).filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

export interface UserSurfaceProjection {
  inspectRunFacts(events: readonly EventEnvelope[]): TargetRunFacts;
  projectTurn(input: {
    turnIndex: number;
    settlement: TurnSettlement;
    events: readonly EventEnvelope[];
    allowModelText: boolean;
  }): UserVisibleTurn;
}

export function projectUserVisibleTurn(input: {
  turnIndex: number;
  settlement: Pick<TurnSettlement, 'status' | 'observedAt' | 'failure'>;
  facts: TargetRunFacts;
  allowModelText: boolean;
}): UserVisibleTurn {
  if (!input.allowModelText) {
    return { schemaVersion: 1, turnIndex: input.turnIndex, status: 'unavailable', observedAt: input.settlement.observedAt };
  }
  const mapped =
    input.settlement.status === 'waiting_input' ? 'waiting'
    : input.settlement.status === 'failed' ? 'failed'
    : input.settlement.status === 'aborted' ? 'aborted'
    : input.settlement.status === 'completed' ? 'completed'
    : 'unavailable';
  if (mapped === 'failed' || mapped === 'aborted') {
    return {
      schemaVersion: 1,
      turnIndex: input.turnIndex,
      status: mapped,
      observedAt: input.settlement.observedAt,
      ...(input.settlement.failure?.summary ? { assistantText: input.settlement.failure.summary } : {}),
    };
  }
  const text = joinPublicAssistantSurface(input.facts.assistantTexts) ?? input.facts.finalMessage?.trim() ?? '';
  const prompt = input.facts.prompt?.trim() ?? '';
  if (mapped === 'completed' && !text) {
    return {
      schemaVersion: 1,
      turnIndex: input.turnIndex,
      status: 'empty',
      observedAt: input.settlement.observedAt,
      ...(prompt ? { prompt } : {}),
    };
  }
  return {
    schemaVersion: 1,
    turnIndex: input.turnIndex,
    status: mapped,
    observedAt: input.settlement.observedAt,
    ...(text ? { assistantText: text } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

export type ProductAuthStatus = {
  readonly configured: boolean;
  readonly provider?: string;
  readonly source?: string;
  readonly detail?: string;
};

export const PACK_API_MAJOR = 3;

export type PackCapability = "import" | "runtime";

export type ProductPackManifest = {
  readonly productId: string;
  readonly displayName: string;
  readonly packVersion: string;
  readonly schemaVersion: number;
  readonly apiMajor: number;
  readonly capabilities: readonly PackCapability[];
  readonly sessionSchemaVersions?: readonly string[];
};

export type RecoveryPlaybookDescriptor = {
  readonly version: string;
  readonly sha256: string;
  readonly text: string;
};

export interface ProductPack {
  readonly manifest: ProductPackManifest;
  readonly history: ProductHistoryReader;
  readonly runtime: ProductRuntime;
  readonly projection: UserSurfaceProjection;
  recoveryPlaybook(): RecoveryPlaybookDescriptor;
  checkAuth?(): Promise<ProductAuthStatus>;
  defaultCandidate(): CandidateSpec;
}
