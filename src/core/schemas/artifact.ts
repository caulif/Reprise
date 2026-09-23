import { Type, type Static } from '@sinclair/typebox';
import { Hash, Id, Timestamp } from './ids.js';

export const ArtifactManifestSchema = Type.Object({
  artifactId: Id,
  schemaVersion: Type.Integer({ minimum: 1 }),
  kind: Type.String({ minLength: 1 }),
  mediaType: Type.Optional(Type.String({ minLength: 1 })),
  byteLength: Type.Integer({ minimum: 0 }),
  contentHash: Hash,
  createdAt: Timestamp,
  owner: Type.Object({ experimentId: Id, runId: Type.Optional(Id) }),
  sourceEventId: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
});

export type ArtifactManifest = Static<typeof ArtifactManifestSchema>;
