import { Type, type Static } from "@sinclair/typebox";

/** Declared native input modalities for a harness / session model. Always includes text. */
export const ModelInputCapabilitiesSchema = Type.Union([
  Type.Tuple([Type.Literal("text")]),
  Type.Tuple([Type.Literal("text"), Type.Literal("image")]),
]);

export type ModelInputCapabilities = Static<typeof ModelInputCapabilitiesSchema>;

export function modelAcceptsImage(capabilities: readonly string[] | undefined): boolean {
  return (capabilities ?? []).includes("image");
}
