import { Type, type Static, type TProperties } from '@sinclair/typebox';
import { ComparisonResourcesSchema } from '../comparison-resources-schema.js';
import { Hash, Id } from './ids.js';

const closedObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const FiniteTimeSchema = closedObject({ kind: Type.Literal('finite'), milliseconds: Type.Integer({ minimum: 1 }) });
export const HarnessSdkPackageSchema = Type.Object({ version: Type.String({ minLength: 1 }) });
const RoleBudgetSchema = closedObject({
  singleCall: Type.Union([FiniteTimeSchema, closedObject({ kind: Type.Literal('unlimited') })]),
  maxStructuredRepairAttempts: Type.Integer({ minimum: 0 }),
});
const ResourceSnapshotSchema = closedObject(ComparisonResourcesSchema.properties);
export const HARNESS_COMPAT_BOOLEAN_KEYS = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming', 'supportsFinishReason',
  'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText', 'requiresReasoningContentOnAssistantMessages',
  'zaiToolStream', 'supportsThinkingTokenBudget', 'supportsOpenAIGrammarTools', 'supportsStrictMode', 'sendSessionAffinityHeaders',
  'supportsLongCacheRetention', 'supportsToolSearch', 'supportsExplicitPromptCacheMode', 'supportsEagerToolInputStreaming', 'supportsToolCacheControl',
] as const;
export const HARNESS_COMPAT_SCALAR_KEYS = ['maxTokensField', 'thinkingFormat', 'cacheControlFormat', 'deferredToolsMode', 'sessionAffinityFormat'] as const;
export const EffectiveHarnessConfigurationSchema = closedObject({
  schemaVersion: Type.Literal(1),
  source: Type.Literal('builtin-pi'),
  locale: Type.Union([Type.Literal('zh'), Type.Literal('en')]),
  model: closedObject({
    providerId: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }), api: Type.String({ minLength: 1 }),
    contextWindow: Type.Integer({ minimum: 1 }), maxTokens: Type.Integer({ minimum: 1 }),
    inputCapabilities: Type.Array(Type.String({ minLength: 1 })),
    capabilitySource: Type.Union(['catalog', 'config', 'default_text'].map(value => Type.Literal(value))),
    configFingerprint: Hash,
    reasoning: Type.Boolean(),
    effort: Type.Union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => Type.Literal(value))),
    compat: closedObject(Object.fromEntries(HARNESS_COMPAT_BOOLEAN_KEYS.map(key => [key, Type.Optional(Type.Boolean())]))),
    compatScalarOptions: closedObject({ maxTokensField: Type.Optional(Type.String()), thinkingFormat: Type.Optional(Type.String()),
      cacheControlFormat: Type.Optional(Type.String()), deferredToolsMode: Type.Optional(Type.String()), sessionAffinityFormat: Type.Optional(Type.String()) }),
    compatCoverage: Type.Literal('explicit-overrides'),
    unrecordedCompat: Type.Array(Type.String()),
    compatDefaults: Type.Literal('sdk-derived-not-recorded'),
    routing: Type.Literal('operator-local-not-recorded'),
    sdkVersion: Type.String({ minLength: 1 }),
  }),
  controller: closedObject({ ...RoleBudgetSchema.properties, decisionLimit: Type.Optional(Type.Integer({ minimum: 1 })),
    decisionLimitScope: Type.Literal('candidate-controller-loop') }),
  recovery: closedObject({ ...RoleBudgetSchema.properties, operationTotal: FiniteTimeSchema }),
  comparison: closedObject({
    configuredCallCap: FiniteTimeSchema, operationTotal: FiniteTimeSchema, mode: Type.Literal('autonomous-total'),
    requestDeadlineRule: Type.Literal('min-remaining-operation-and-configured-call-cap'),
    requestedResources: ResourceSnapshotSchema,
    enforcedResources: ResourceSnapshotSchema,
  }),
  probe: closedObject({ deadlineMs: Type.Integer({ minimum: 1 }), maxOuterAttempts: Type.Integer({ minimum: 1 }),
    sdkMaxRetries: Type.Integer({ minimum: 0 }), sdkMaxRetryDelayMs: Type.Integer({ minimum: 0 }) }),
});
export type EffectiveHarnessConfiguration = Static<typeof EffectiveHarnessConfigurationSchema>;

export const HarnessConfigurationReferenceSchema = closedObject({
  configurationId: Id, experimentId: Id, runId: Id,
  operation: Type.Union(['run', 'recovery', 'comparison'].map(value => Type.Literal(value))),
  comparisonAttemptId: Type.Optional(Id),
  contentHash: Hash, artifactId: Id,
});
export type HarnessConfigurationReference = Static<typeof HarnessConfigurationReferenceSchema>;
export const HarnessConfigurationBoundSchema = closedObject({
  schemaVersion: Type.Literal(1), reference: HarnessConfigurationReferenceSchema, configuration: EffectiveHarnessConfigurationSchema,
});
export const HarnessProbeRequestedSchema = closedObject({
  schemaVersion: Type.Literal(1), reference: HarnessConfigurationReferenceSchema,
  requestId: Id, outerAttempt: Type.Integer({ minimum: 1, maximum: 3 }), template: Type.Literal('reprise-connection-check-v1'),
  timestamp: Type.Integer({ minimum: 0 }),
  systemPrompt: Type.Literal('Reprise connection check. Reply with exactly OK.'),
  userText: Type.Literal('Reply with exactly OK.'),
  reasoning: Type.Optional(Type.Union(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => Type.Literal(value)))),
  sdkRetries: Type.Literal('managed-by-pi-sdk'),
});
export type HarnessProbeRequested = Static<typeof HarnessProbeRequestedSchema>;
export const HarnessProbeCompletedSchema = closedObject({
  schemaVersion: Type.Literal(1), reference: HarnessConfigurationReferenceSchema, requestId: Id,
  result: Type.Union(['passed', 'empty', 'error', 'aborted'].map(value => Type.Literal(value))),
  failureKind: Type.Optional(Type.Union(['authentication', 'rate_limited', 'transient_network', 'transient_upstream', 'timeout',
    'cancelled', 'protocol', 'tool', 'privacy', 'persistence', 'unknown'].map(value => Type.Literal(value)))),
});
export const ComparisonOperationFailureSchema = closedObject({
  schemaVersion: Type.Literal(1), experimentId: Id, runId: Id, attemptId: Id,
  stage: Type.Union(['activity', 'agents', 'workspace', 'comparison'].map(value => Type.Literal(value))),
  status: Type.Union([Type.Literal('failed'), Type.Literal('cancelled')]),
  effectiveReference: Type.Optional(HarnessConfigurationReferenceSchema),
  error: closedObject({ name: Type.String({ minLength: 1 }), message: Type.String() }),
});
export type ComparisonOperationFailure = Static<typeof ComparisonOperationFailureSchema>;
