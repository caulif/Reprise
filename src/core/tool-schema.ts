import { Type, type Static } from "@sinclair/typebox";

const ToolCapabilitySchema = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9_-]{1,63}$" }),
  available: Type.Boolean(),
  operations: Type.Array(Type.String({ minLength: 1, maxLength: 64 })),
  verification: Type.Union([Type.Literal("detected"), Type.Literal("executed"), Type.Literal("unavailable")]),
  version: Type.Optional(Type.String({ maxLength: 128 })),
  reason: Type.Optional(Type.String({ maxLength: 512 })),
});
export type ToolCapability = Static<typeof ToolCapabilitySchema>;

export const ToolCapabilityManifestSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  generatedAt: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T" }),
  platform: Type.String(),
  core: Type.Array(ToolCapabilitySchema),
  optional: Type.Array(ToolCapabilitySchema),
});
export type ToolCapabilityManifest = Static<typeof ToolCapabilityManifestSchema>;

export const ToolConfigSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  browserPath: Type.Optional(Type.String({ minLength: 1 })),
  search: Type.Optional(Type.Object({
    endpoint: Type.String({ minLength: 1 }),
    keyEnv: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  })),
  enhancements: Type.Optional(Type.Object({
    libreOfficePath: Type.Optional(Type.String({ minLength: 1 })),
    ffmpegPath: Type.Optional(Type.String({ minLength: 1 })),
    ffprobePath: Type.Optional(Type.String({ minLength: 1 })),
    tesseractPath: Type.Optional(Type.String({ minLength: 1 })),
  })),
}, { additionalProperties: false });
export type ToolConfig = Static<typeof ToolConfigSchema>;
