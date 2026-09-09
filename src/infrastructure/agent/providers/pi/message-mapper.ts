import type { ImageContent } from "@earendil-works/pi-ai";

export function toPiUserPrompt(content: string, images?: readonly ImageContent[]): {
  content: string;
  images?: ImageContent[];
} {
  return {
    content,
    ...(images?.length ? { images: [...images] } : {}),
  };
}
