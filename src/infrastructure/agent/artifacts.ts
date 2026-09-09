import type { ImageContent } from "@earendil-works/pi-ai";
import { imageRefs } from "./model-input.js";
import type { AgentAuditSink } from "./types.js";

export async function recordedImageRefs(
  images: readonly ImageContent[] | undefined,
  audit: AgentAuditSink | undefined,
) {
  const refs = imageRefs(images);
  if (!images?.length || !audit?.commitModelInput) return refs;
  const recorded = [];
  for (const [index, image] of images.entries()) {
    const artifact = await audit.commitModelInput(Buffer.from(image.data, "base64"));
    recorded.push({ ...refs[index]!, artifactId: artifact.artifactId });
  }
  return recorded;
}
