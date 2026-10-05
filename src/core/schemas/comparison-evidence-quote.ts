import { Type, type Static } from "@sinclair/typebox";

const Ref = Type.String({ pattern: "^ev-[0-9]{2,6}$" });
const ByteOffset = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ComparisonEvidenceQuoteParamsSchema = Type.Object({
  sourceRef: Ref,
  range: Type.Optional(Type.Object({ startByte: ByteOffset, endByte: ByteOffset }, { additionalProperties: false })),
}, { additionalProperties: false });
export const ComparisonEvidenceQuoteSpecSchema = Type.Object({
  sourceRef: Ref,
  sourceHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  startByte: ByteOffset,
  endByte: ByteOffset,
}, { additionalProperties: false });
export type ComparisonEvidenceQuoteParams = Static<typeof ComparisonEvidenceQuoteParamsSchema>;
export type ComparisonEvidenceQuoteSpec = Static<typeof ComparisonEvidenceQuoteSpecSchema>;
