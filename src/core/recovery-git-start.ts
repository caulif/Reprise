import { Type, type Static } from '@sinclair/typebox';
import { Hash } from './schemas/ids.js';

/** Explicit caller authority; historical session metadata never populates this contract. */
export const RecoveryGitStartSchema = Type.Object({
  commit: Type.String({ pattern: '^[0-9a-f]{40}$' }),
  inputs: Type.Array(Type.Object({
    path: Type.String({ minLength: 1 }),
    sha256: Hash,
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type RecoveryGitStart = Static<typeof RecoveryGitStartSchema>;
