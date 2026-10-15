import { Type, type Static, type TProperties } from '@sinclair/typebox';
import { Id } from './ids.js';
import { ExperimentSpecSchema } from './run.js';
import { RecoveryCheckpointRecordSchema } from './recovery.js';

const closedObject = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const PersistedExperimentMetadataSchema = closedObject({
  spec: ExperimentSpecSchema,
  runIds: Type.Optional(Type.Readonly(Type.Array(Id))),
});
export type PersistedExperimentMetadata = Static<typeof PersistedExperimentMetadataSchema>;

export const ExperimentPreflightSchema = closedObject({
  sourceBaseline: Type.Union((['available', 'partial', 'unavailable', 'unknown'] as const).map(value => Type.Literal(value))),
  resolved: closedObject({ productId: Type.String({ minLength: 1 }), executable: Type.String({ minLength: 1 }),
    version: Type.Optional(Type.String()), requestedModel: Type.String({ minLength: 1 }), resolvedModel: Type.String({ minLength: 1 }) }),
  sourceFingerprint: Type.Optional(Type.String({ minLength: 1 })),
  workspace: Type.Optional(closedObject({ ...RecoveryCheckpointRecordSchema.properties.budget.properties,
    excludedEntries: Type.Optional(Type.Array(closedObject(RecoveryCheckpointRecordSchema.properties.budget.properties.excludedEntries.items.properties))),
    sensitiveFileCounts: Type.Optional(closedObject({ env: Type.Integer({ minimum: 0 }), credential: Type.Integer({ minimum: 0 }), private_key: Type.Integer({ minimum: 0 }) })) })),
  limitations: Type.Readonly(Type.Array(Type.String())),
  comparisonClass: Type.Union((['observational', 'recovered', 'recovered_partial'] as const).map(value => Type.Literal(value))),
  contamination: Type.Optional(closedObject({
    git: Type.Optional(closedObject({ historicalCommit: Type.String(), currentHead: Type.String(),
      relation: Type.Union((['same', 'ancestor', 'diverged', 'missing'] as const).map(value => Type.Literal(value))) })),
    timeline: Type.Optional(closedObject({ sessionEndedAt: Type.String(), sourceLastModifiedAt: Type.String() })),
    baselineArtifactsPresent: Type.Optional(Type.Array(Type.String())),
  })),
});
type ReadonlyArrays<T> = T extends (infer Item)[] ? readonly ReadonlyArrays<Item>[]
  : T extends object ? { [Key in keyof T]: ReadonlyArrays<T[Key]> } : T;
export type ExperimentPreflight = ReadonlyArrays<Static<typeof ExperimentPreflightSchema>>;
export const RunPreflightRecordSchema = closedObject({ schemaVersion: Type.Literal(1), experimentId: Id, runId: Id,
  preflight: ExperimentPreflightSchema });
