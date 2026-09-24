/**
 * Shared TUI synthetic flow fixtures for T00+.
 * Neutral task text only — no video/private paths. No real Runtime or model.
 * Single SoT for audit / full-flow / unit tests (consume via dist after build).
 */
import type { EventEnvelope } from '../../../src/core/schema.js';
import type { TimelineEntry } from '../../../src/tui/timeline.js';

export const SYNTHETIC_FLOW_BASE_ISO = '2026-08-11T00:10:00.000Z';
export const SYNTHETIC_TASK_TEXT = 'Fix the failing test.';
export const SYNTHETIC_EXPERIMENT_ROOT = String.raw`C:\reprise\experiments\synthetic-flow`;
export const SYNTHETIC_RUN_ID = 'run-synthetic-1';
export const PUBLIC_DETAIL_END = 'PUBLIC_DETAIL_END';

export type FakeClock = {
  now(): string;
  nowMs(): number;
  advance(ms: number): void;
  set(isoOrMs: string | number): void;
};

export function createFakeClock(startIso = SYNTHETIC_FLOW_BASE_ISO): FakeClock {
  let ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) throw new Error(`createFakeClock: invalid startIso ${startIso}`);
  return {
    now() {
      return new Date(ms).toISOString();
    },
    nowMs() {
      return ms;
    },
    advance(deltaMs: number) {
      if (!Number.isFinite(deltaMs)) throw new Error('createFakeClock.advance: deltaMs must be finite');
      ms += deltaMs;
    },
    set(isoOrMs: string | number) {
      const next = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
      if (!Number.isFinite(next)) throw new Error(`createFakeClock.set: invalid value ${String(isoOrMs)}`);
      ms = next;
    },
  };
}

export type EnvelopeOptions = {
  sequence?: number;
  at?: string;
  eventId?: string;
  checksum?: string;
};

export function envelope(type: string, payload: unknown, options: EnvelopeOptions = {}): EventEnvelope {
  const sequence = options.sequence ?? 1;
  return {
    schemaVersion: 1,
    sequence,
    eventId: options.eventId ?? `event-${sequence}`,
    occurredAt: options.at ?? SYNTHETIC_FLOW_BASE_ISO,
    type,
    payload,
    checksum: options.checksum ?? '0'.repeat(64),
  };
}

export type TaskStatus = 'apparently_completed' | 'incomplete' | 'indeterminate' | 'not_assessed';
export type TerminationKind = 'completed' | 'limit_reached' | 'stalled' | 'cancelled' | 'blocked' | 'failed' | 'uncertain';
export type CleanupStatus = 'not_needed' | 'complete' | 'incomplete' | 'unknown';

/** Candidate outcome knobs — never linked by a single success flag. */
export type CandidateOutcomeInput = {
  task?: TaskStatus;
  termination?: TerminationKind | {
    kind: TerminationKind;
    code?: string;
    initiatedBy?: 'target' | 'controller' | 'user' | 'harness';
    failure?: {
      origin: 'runtime' | 'controller' | 'environment' | 'harness' | 'external_dependency' | 'unknown';
      code: string;
      message: string;
    };
  };
  cleanup?: CleanupStatus | {
    status: CleanupStatus;
    remainingResourceIds?: readonly string[];
  };
};

export type ComparisonCase =
  | { status: 'completed'; valueStatus?: 'completed' | 'insufficient_evidence'; headline?: string; reportPath?: 'report.html' }
  | { status: 'failed'; failure?: { code?: string; kind?: string; message?: string; attempts?: number } }
  | { status: 'cancelled'; factRef?: string }
  | { status: 'skipped' };

export type SyntheticFlowOptions = {
  clock?: FakeClock;
  comparison?: ComparisonCase;
  candidate?: CandidateOutcomeInput;
  /** Lines in the public candidate response (default 8; visual audits use 40). */
  longMessageLines?: number;
  /** Directory listing rows on runtime.tool_finished (default 2; audit uses 24). */
  commandListingLines?: number;
  commandCwd?: string;
  /** When true, attach callId/toolCallId on tool events (default false = legacy shape). */
  includeToolCallId?: boolean;
  /** Identical recovery shell_exec failures to fold (default 0). */
  repeatedToolFailures?: number;
  /** Emit multi-line live via runtime.tool_started before tool_finished (default true). */
  multiLineLive?: boolean;
  /** Emit candidate.user_view_persisted (default true; full-flow omits). */
  includeUserViewPersisted?: boolean;
  /** Emit run.outcome_created (default true; audit omits). */
  includeOutcomeEvent?: boolean;
  runId?: string;
  experimentRoot?: string;
};

export type ScriptedWorkflowOptions = SyntheticFlowOptions & {
  policy?: Record<string, unknown>;
  workflowCandidate?: { candidateId: string; productId: string; requestedModel: string };
  /** Merged into the gated preflight return (workspace, limitations, …). */
  preflightExtras?: Record<string, unknown>;
  /** Absolute recover experimentRoot override (audit wires a temp path). */
  recoveryExperimentRoot?: string;
  recoverySummary?: string;
};

const DEFAULT_TERMINATION_CODE: Record<TerminationKind, string> = {
  completed: 'completed.controller_satisfied',
  limit_reached: 'limit.target_turns',
  stalled: 'stalled.controller_no_further_value',
  cancelled: 'cancelled.user',
  blocked: 'blocked.controller_done',
  failed: 'failed.controller',
  uncertain: 'uncertain.controller',
};

const DEFAULT_POLICY = {
  maxTargetTurns: 256,
  maxModelCalls: 256,
  wallClockMs: 86_400_000,
  turnTimeoutMs: 7_200_000,
};

function maybeId(include: boolean, key: string, value: string): Record<string, string> {
  return include ? { [key]: value } : {};
}

function stamp(events: EventEnvelope[], clock: FakeClock, stepMs: number): EventEnvelope[] {
  return events.map((event, index) => {
    if (index > 0) clock.advance(stepMs);
    return { ...event, sequence: index + 1, eventId: `event-${index + 1}`, occurredAt: clock.now() };
  });
}

export function longPublicResponse(lines = 8): string {
  const body = Array.from({ length: lines }, (_, index) => `public response line ${index + 1}`);
  return [...body, PUBLIC_DETAIL_END].join('\n');
}

function commandAggregatedOutput(listingLines: number): string {
  const header = ['Mode  Length LastWriteTime         Name', '----  ------ -------------         ----'];
  const rows = Array.from({ length: listingLines }, (_, index) => (
    `-a--- ${String(1200 + index).padStart(6)} 8/13/2026 12:00:00 AM  file-${index + 1}.txt`
  ));
  return [...header, ...rows].join('\n');
}

export function syntheticCandidateOutcome(input: CandidateOutcomeInput = {}): {
  task: { status: TaskStatus };
  termination: {
    kind: TerminationKind;
    code: string;
    initiatedBy?: 'target' | 'controller' | 'user' | 'harness';
    failure?: {
      origin: 'runtime' | 'controller' | 'environment' | 'harness' | 'external_dependency' | 'unknown';
      code: string;
      message: string;
      evidenceRefs: [];
    };
  };
  cleanup: { status: CleanupStatus; remainingResourceIds?: string[] };
} {
  const taskStatus = input.task ?? 'apparently_completed';
  const terminationInput = input.termination;
  const kind = typeof terminationInput === 'string'
    ? terminationInput
    : terminationInput?.kind ?? 'completed';
  const code = typeof terminationInput === 'string'
    ? DEFAULT_TERMINATION_CODE[kind]
    : terminationInput?.code ?? DEFAULT_TERMINATION_CODE[kind];
  const initiatedBy = typeof terminationInput === 'object' ? terminationInput.initiatedBy : undefined;
  const failure = typeof terminationInput === 'object' ? terminationInput.failure : undefined;
  const cleanupInput = input.cleanup;
  const cleanupStatus = typeof cleanupInput === 'string'
    ? cleanupInput
    : cleanupInput?.status ?? 'complete';
  const remaining = typeof cleanupInput === 'object' ? cleanupInput.remainingResourceIds : undefined;
  return {
    task: { status: taskStatus },
    termination: {
      kind,
      code,
      ...(initiatedBy ? { initiatedBy } : {}),
      ...(failure ? { failure: { ...failure, evidenceRefs: [] as [] } } : {}),
    },
    cleanup: {
      status: cleanupStatus,
      ...(remaining ? { remainingResourceIds: [...remaining] } : {}),
    },
  };
}

/**
 * Single ComparisonCase → invocationFact-shaped result.
 * Used by both {@link syntheticComparisonResult} and {@link syntheticComparisonEvents}.
 */
function comparisonInvocation(comparison: ComparisonCase = { status: 'completed' }): Record<string, unknown> {
  if (comparison.status === 'skipped') return { status: 'skipped' };
  if (comparison.status === 'cancelled') {
    return {
      status: 'cancelled',
      ...(comparison.factRef ? { factRef: comparison.factRef } : {}),
      sessionId: 'comparison-synthetic-1',
    };
  }
  if (comparison.status === 'failed') {
    return {
      status: 'failed',
      failure: {
        code: comparison.failure?.code ?? 'agent_failure',
        kind: comparison.failure?.kind ?? 'protocol',
        message: comparison.failure?.message ?? 'Synthetic comparison failure.',
        attempts: comparison.failure?.attempts ?? 1,
      },
      sessionId: 'comparison-synthetic-1',
    };
  }
  const valueStatus = comparison.valueStatus ?? 'completed';
  return {
    status: 'completed',
    sessionId: 'comparison-synthetic-1',
    value: {
      status: valueStatus,
      reportPath: comparison.reportPath ?? 'report.html',
      evidenceRefs: ['ev-01'],
      ...(comparison.headline
        ? { headline: comparison.headline }
        : valueStatus === 'completed'
          ? { headline: 'Synthetic comparison headline.' }
          : {}),
      ...(valueStatus === 'insufficient_evidence' ? { limitationCodes: ['missing_baseline_artifact'] } : {}),
    },
  };
}

export function syntheticComparisonResult(comparison: ComparisonCase = { status: 'completed' }): unknown {
  return comparisonInvocation(comparison);
}

/** Absolute report/diagnostic path aligned with experiment-report persist rules. */
export function syntheticReportPath(experimentRoot: string, comparison: ComparisonCase): string {
  if (comparison.status === 'skipped') return experimentRoot;
  if (comparison.status === 'failed' || comparison.status === 'cancelled') {
    return `${experimentRoot}\\comparison-failure.html`;
  }
  return `${experimentRoot}\\report.html`;
}

export function syntheticExperimentResult(options: SyntheticFlowOptions = {}): Record<string, unknown> {
  const experimentRoot = options.experimentRoot ?? SYNTHETIC_EXPERIMENT_ROOT;
  const runId = options.runId ?? SYNTHETIC_RUN_ID;
  const comparison = options.comparison ?? { status: 'completed' };
  const outcome = syntheticCandidateOutcome(options.candidate);
  const comparisonResult = comparisonInvocation(comparison);
  const reportPath = syntheticReportPath(experimentRoot, comparison);
  const skipped = comparison.status === 'skipped';
  return {
    reportPath,
    experimentRoot,
    preflight: {
      sourceBaseline: 'available',
      resolved: {
        productId: 'codex',
        executable: 'fixture',
        requestedModel: 'gpt-test',
        resolvedModel: 'gpt-test',
      },
      comparisonClass: 'observational',
      limitations: [],
    },
    record: {
      attempt: { runId },
      outcome,
    },
    decision: {
      status: 'completed',
      value: { type: 'done', reason: 'satisfied', rationale: 'Synthetic controller rationale.' },
      usedFallback: false,
    },
    comparison: { result: comparisonResult },
    facts: {
      wallClockMs: 49_000,
      elapsedMs: 72_000,
      calls: 1,
      controllerCalls: 1,
      turns: 1,
    },
    pathLinks: {
      // Match buildResultPathLinks: skip report link when comparison was skipped (reportPath === experimentRoot).
      ...(skipped ? {} : { report: reportPath }),
      historyFinal: `${experimentRoot}\\environment\\baselines\\history-final.txt`,
      candidateFinal: `${experimentRoot}\\environment\\runs\\${runId}\\candidate-final.txt`,
      trace: `${experimentRoot}\\runs\\${runId}`,
      replica: `${experimentRoot}\\environment\\runs\\${runId}`,
    },
  };
}

export function syntheticRecoveryEvents(options: SyntheticFlowOptions = {}): EventEnvelope[] {
  const includeToolCallId = options.includeToolCallId === true;
  const repeated = Math.max(0, options.repeatedToolFailures ?? 0);
  const failureMessage = 'recovery_no_information_gain: destructive change budget of 16 was exhausted.';
  const events: EventEnvelope[] = [
    envelope('recovery.started', { sourceDigest: 'synthetic-source' }),
    envelope('agent.assistant_visible', {
      role: 'recovery',
      text: 'I will inspect the frozen task text and restore the workspace.',
      turn: 0,
    }),
    envelope('agent.tool_called', {
      role: 'recovery',
      tool: 'read',
      params: { path: 'INDEX.md' },
      ...maybeId(includeToolCallId, 'toolCallId', 'recovery-read-1'),
    }),
    envelope('agent.tool_completed', {
      role: 'recovery',
      tool: 'read',
      params: { path: 'INDEX.md' },
      ...maybeId(includeToolCallId, 'toolCallId', 'recovery-read-1'),
    }),
  ];
  for (let index = 0; index < repeated; index += 1) {
    events.push(envelope('agent.tool_failed', {
      role: 'recovery',
      tool: 'shell_exec',
      message: failureMessage,
      ...maybeId(includeToolCallId, 'toolCallId', `recovery-shell-${index + 1}`),
    }));
  }
  events.push(envelope('recovery.completed', { status: 'recovered' }));
  return events;
}

export function syntheticCandidateEvents(options: SyntheticFlowOptions = {}): EventEnvelope[] {
  const includeToolCallId = options.includeToolCallId === true;
  const multiLineLive = options.multiLineLive !== false;
  const includeUserView = options.includeUserViewPersisted !== false;
  const includeOutcome = options.includeOutcomeEvent !== false;
  const listingLines = options.commandListingLines ?? 2;
  const cwd = options.commandCwd ?? String.raw`C:\reprise`;
  const response = longPublicResponse(options.longMessageLines ?? 8);
  const liveDetail = multiLineLive
    ? 'first live line\nsecond live line\twith tab\rand CR'
    : 'pelican-bike.html';
  const events: EventEnvelope[] = [
    envelope('run.state_changed', { to: 'launching' }),
    envelope('input.submitted', { turnIndex: 0, text: SYNTHETIC_TASK_TEXT }),
    envelope('runtime.turn_started', {}),
    envelope('controller.decision', {
      status: 'completed',
      sessionId: 'controller-synthetic-1',
      value: { type: 'send', rationale: 'One check remains.', message: 'Run the focused test.' },
    }),
  ];
  if (multiLineLive) {
    events.push(envelope('runtime.tool_started', {
      schemaVersion: 1,
      sessionId: 'sess-synthetic-1',
      evidenceRefs: [],
      live: { schemaVersion: 1, verb: 'check', leaf: liveDetail },
      ...maybeId(includeToolCallId, 'callId', 'candidate-tool-1'),
    }));
  }
  events.push(envelope('runtime.tool_finished', {
    item: {
      type: 'commandExecution',
      command: String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command "Get-ChildItem | Format-Table Mode,Length,LastWriteTime,Name"`,
      status: 'completed',
      cwd,
      exitCode: 0,
      durationMs: listingLines > 2 ? 476 : 120,
      aggregatedOutput: commandAggregatedOutput(listingLines),
    },
    ...maybeId(includeToolCallId, 'callId', 'candidate-tool-1'),
  }));
  events.push(envelope('runtime.visible_output', {
    item: { type: 'agentMessage', text: response },
  }));
  if (includeUserView) {
    events.push(envelope('candidate.user_view_persisted', {
      turnIndex: 1,
      status: 'completed',
      // stamp() overwrites envelope occurredAt; observedAt filled to match after stamp via note in flow.
      observedAt: SYNTHETIC_FLOW_BASE_ISO,
      assistantText: response,
    }));
  }
  if (includeOutcome) {
    events.push(envelope('run.outcome_created', {
      outcome: syntheticCandidateOutcome(options.candidate),
    }));
  }
  return events;
}

export function syntheticComparisonEvents(options: SyntheticFlowOptions = {}): EventEnvelope[] {
  const comparison = options.comparison ?? { status: 'completed' };
  const includeToolCallId = options.includeToolCallId === true;
  const events: EventEnvelope[] = [
    envelope('agent.tool_called', {
      role: 'comparison',
      tool: 'read',
      params: { path: 'report-facts.json' },
      ...maybeId(includeToolCallId, 'toolCallId', 'comparison-read-1'),
    }),
    envelope('agent.tool_completed', {
      role: 'comparison',
      tool: 'read',
      params: { path: 'report-facts.json' },
      ...maybeId(includeToolCallId, 'toolCallId', 'comparison-read-1'),
    }),
  ];
  // Live persist: { attemptId, ...invocationFact(result) }. Fixtures omit attemptId; keep invocationFact shape.
  events.push(envelope('comparison.completed', comparisonInvocation(comparison)));
  return events;
}

/** Full recovery → candidate → comparison event sequence with monotonic sequence + clock stamps. */
export function syntheticFlowEvents(options: SyntheticFlowOptions = {}): EventEnvelope[] {
  const clock = options.clock ?? createFakeClock();
  const combined = [
    ...syntheticRecoveryEvents(options),
    ...syntheticCandidateEvents(options),
    ...syntheticComparisonEvents(options),
  ];
  const stamped = stamp(combined, clock, 500);
  return stamped.map((event) => {
    if (event.type !== 'candidate.user_view_persisted') return event;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    return { ...event, payload: { ...payload, observedAt: event.occurredAt } };
  });
}

export function sampleTimelineEntries(clock: FakeClock = createFakeClock()): TimelineEntry[] {
  const at0 = clock.now();
  clock.advance(1_000);
  const at1 = clock.now();
  clock.advance(1_000);
  const at2 = clock.now();
  return [
    {
      sequence: 1,
      occurredAt: at0,
      source: 'CONTROLLER',
      title: `Prompt · ${SYNTHETIC_TASK_TEXT.replace(/\.$/, '')}`,
      kind: 'narrate',
      detail: SYNTHETIC_TASK_TEXT.replace(/\.$/, ''),
    },
    {
      sequence: 2,
      occurredAt: at1,
      source: 'TARGET',
      title: 'Visible response',
      kind: 'narrate',
      detail: 'public response line 1',
    },
    {
      sequence: 3,
      occurredAt: at2,
      source: 'TARGET',
      title: 'Candidate · working',
      kind: 'live',
      itemId: 'now:candidate',
      placeholder: true,
    },
  ];
}

export type ScriptedWorkflowHandles = {
  releasePreflight: () => void;
  releaseRecovery: () => void;
  releaseCopy: () => void;
  releaseStart: () => void;
  resolveResult: (result?: unknown) => void;
  emitCandidateEvents: (onEvent: (event: EventEnvelope) => void) => void;
  /** True once start() is blocked on the copy gate (for audit waitFor). */
  copyLatched: () => boolean;
  /** True once start() is blocked on the start gate after events were emitted. */
  startLatched: () => boolean;
};

/**
 * Gated recover/start workflow stub — shared by unit tests, visual-audit, and full-flow.
 * Callers may spread extras (listCatalog, verifyCandidate, …) onto `workflow`.
 */
export function createScriptedSyntheticWorkflow(options: ScriptedWorkflowOptions = {}): {
  workflow: {
    policy: unknown;
    candidate?: { candidateId: string; productId: string; requestedModel: string };
    preflight: (request?: { signal?: AbortSignal }) => Promise<unknown>;
    recover: (request?: { signal?: AbortSignal }) => Promise<unknown>;
    acceptRecovery: () => Promise<unknown>;
    discardRecovery: () => Promise<void>;
    start: (input: { onEvent: (event: EventEnvelope) => void; signal?: AbortSignal }) => Promise<{
      cancel: () => Promise<void>;
      result: Promise<unknown>;
    }>;
  };
  handles: ScriptedWorkflowHandles;
  clock: FakeClock;
} {
  const clock = options.clock ?? createFakeClock();
  const experimentRoot = options.recoveryExperimentRoot
    ?? options.experimentRoot
    ?? SYNTHETIC_EXPERIMENT_ROOT;
  const summary = options.recoverySummary ?? 'Ready for the original task.';
  let releasePreflight!: () => void;
  let releaseRecovery!: () => void;
  let releaseCopy!: () => void;
  let releaseStart!: () => void;
  let resolveResult!: (result?: unknown) => void;
  const handles: ScriptedWorkflowHandles = {
    releasePreflight: () => releasePreflight?.(),
    releaseRecovery: () => releaseRecovery?.(),
    releaseCopy: () => releaseCopy?.(),
    releaseStart: () => releaseStart?.(),
    resolveResult: (result) => resolveResult?.(result ?? syntheticExperimentResult(options)),
    copyLatched: () => typeof releaseCopy === 'function',
    startLatched: () => typeof releaseStart === 'function',
    emitCandidateEvents(onEvent) {
      for (const event of stamp(syntheticCandidateEvents(options), clock, 500)) {
        if (event.type === 'candidate.user_view_persisted') {
          const payload = event.payload && typeof event.payload === 'object'
            ? event.payload as Record<string, unknown>
            : {};
          onEvent({ ...event, payload: { ...payload, observedAt: event.occurredAt } });
          continue;
        }
        onEvent(event);
      }
    },
  };
  const recoveredBaseline = {
    root: experimentRoot,
    mode: 'canonical' as const, match: 'recovered' as const, warnings: [],
    readiness: { runnable: 'isolated' as const, strictness: 'strict' as const, blockingResourceIds: [] },
    fingerprint: { digest: 'synthetic-recovered-digest' },
    recovery: { status: 'ready' as const, unresolved: [], sourceDigest: 'synthetic-source-digest', recoveredDigest: 'synthetic-recovered-digest' },
  };
  const workflow = {
    ...(options.workflowCandidate ? { candidate: options.workflowCandidate } : {}),
    policy: options.policy ?? DEFAULT_POLICY,
    preflight: async () => {
      await new Promise<void>((resolve) => { releasePreflight = resolve; });
      return {
        sourceBaseline: 'available',
        resolved: {
          productId: options.workflowCandidate?.productId ?? 'codex',
          executable: 'fixture',
          requestedModel: options.workflowCandidate?.requestedModel ?? 'gpt-test',
          resolvedModel: options.workflowCandidate?.requestedModel ?? 'gpt-test',
        },
        limitations: [],
        ...options.preflightExtras,
      };
    },
    recover: async () => {
      await new Promise<void>((resolve) => { releaseRecovery = resolve; });
      return {
        experimentId: 'synthetic-recovery',
        experimentRoot,
        baseline: recoveredBaseline,
        staging: { recoveryId: 'synthetic-recovery', caseId: 'synthetic-case', sourceRoot: experimentRoot, root: experimentRoot },
        recovery: {
          status: 'completed',
          sessionId: 's',
          value: {
            status: 'ready',
            summary,
            reportPath: 'recovery.md',
            unresolved: [],
          },
        },
        accept: async () => recoveredBaseline,
      };
    },
    acceptRecovery: async () => recoveredBaseline,
    discardRecovery: async () => {},
    start: async (input: { onEvent: (event: EventEnvelope) => void }) => {
      await new Promise<void>((resolve) => { releaseCopy = resolve; });
      handles.emitCandidateEvents(input.onEvent);
      await new Promise<void>((resolve) => { releaseStart = resolve; });
      return {
        cancel: async () => {},
        result: new Promise((resolve) => { resolveResult = resolve; }),
      };
    },
  };
  return { workflow, handles, clock };
}
