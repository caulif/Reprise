import type { ImageContent } from "@earendil-works/pi-ai";
import { imageRefs } from "./model-input.js";
import type { AgentAuditSink } from "./types.js";
import { isRecord } from '../../core/json.js';

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

export async function recordedContext(messages: readonly unknown[], audit: AgentAuditSink | undefined): Promise<unknown[]> {
  const recorded = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) { recorded.push(message); continue; }
    const content = [];
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        const refs = await recordedImageRefs([{ type: 'image', data: block.data, mimeType: block.mimeType }], audit);
        content.push(refs[0]);
      } else content.push(block);
    }
    recorded.push({ ...message, content });
  }
  return recorded;
}
