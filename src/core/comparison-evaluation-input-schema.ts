import { Type, type Static } from '@sinclair/typebox';

const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Path = Type.String({ minLength: 1, maxLength: 2048, pattern: '^[^\\\\:]+$' });
export const ComparisonEvaluationInputIdentitySchema = Type.Object({
  schemaVersion: Type.Literal(1),
  suiteVariantHash: Hash,
  experimentId: Type.String({ pattern: '^eval-[a-z0-9-]+$' }),
  files: Type.Array(Type.Object({ path: Path, hash: Hash }), { minItems: 1 }),
  events: Type.Object({ path: Path, prefixBytes: Type.Integer({ minimum: 1 }), prefixHash: Hash }),
});
export type ComparisonEvaluationInputIdentity = Static<typeof ComparisonEvaluationInputIdentitySchema>;
