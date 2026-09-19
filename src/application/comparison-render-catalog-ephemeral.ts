import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComparisonRenderCatalogPort,
  ComparisonRenderSource,
  RegisterDerivedMediaInput,
  RegisterDerivedMediaResult,
} from "./comparison-render-tools.js";

/** Test/ephemeral catalog until B3 ComparisonCatalog is wired. Append-only short refs. */
export function createEphemeralRenderCatalog(input: {
  sources: readonly ComparisonRenderSource[];
  mediaRoot: string;
  reviewRoot: string;
}): ComparisonRenderCatalogPort & {
  media: { shortRef: string; mediaRef: string; kind: string; pngPath: string }[];
} {
  let revision = 1;
  let nextMedia = 1;
  const byRef = new Map(input.sources.map((source) => [source.sourceRef, source]));
  const media: { shortRef: string; mediaRef: string; kind: string; pngPath: string }[] = [];
  const derivationKey = new Map<string, RegisterDerivedMediaResult>();

  return {
    media,
    revision: () => revision,
    async resolveSource(sourceRef) {
      return byRef.get(sourceRef);
    },
    async registerDerivedMedia(entry: RegisterDerivedMediaInput): Promise<RegisterDerivedMediaResult> {
      const key = [
        entry.sourceRef,
        entry.contentHash,
        entry.kind,
        entry.derivation.viewport.width,
        entry.derivation.viewport.height,
        entry.derivation.viewport.scale,
        entry.derivation.sampleTimeMs,
      ].join("|");
      const existing = derivationKey.get(key);
      if (existing) return existing;
      const shortRef = `media-${String(nextMedia).padStart(2, "0")}`;
      nextMedia += 1;
      const mediaRef = `media:derived-${shortRef}`;
      const root = entry.kind === "report_review" ? input.reviewRoot : input.mediaRoot;
      await mkdir(root, { recursive: true });
      const dest = join(root, `${shortRef}.png`);
      await copyFile(entry.pngPath, dest);
      revision += 1;
      const registered = { shortRef, mediaRef, revision };
      media.push({ shortRef, mediaRef, kind: entry.kind, pngPath: dest });
      derivationKey.set(key, registered);
      await writeFile(join(root, `${shortRef}.meta.json`), JSON.stringify({
        sourceRef: entry.sourceRef,
        contentHash: entry.contentHash,
        kind: entry.kind,
        derivation: entry.derivation,
        shortRef,
        mediaRef,
        revision,
      }, null, 2), "utf8");
      return registered;
    },
  };
}
