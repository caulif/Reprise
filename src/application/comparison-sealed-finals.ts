import { readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { HistoricalArtifactManifestSchema, type ComparisonLinkRecord } from '../core/schema.js';
import { sha256File } from '../core/identity.js';
import { pathContainedBy } from '../core/paths.js';
import { assertSafeLogicalPath } from '../core/logical-paths.js';
import { attemptFinalsRoot } from './prepare-historical-artifacts.js';
import { mediaTypeForComparisonPath } from './comparison-media.js';

export async function comparisonSealedFinalLinks(attemptRoot: string, preferredPaths: readonly string[] = []): Promise<{ links: ComparisonLinkRecord[]; unavailable: string[] }> {
  const root = attemptFinalsRoot(attemptRoot);
  const raw = await readFile(join(root, 'manifest.json'), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return { links: [], unavailable: [] };
  const manifest: unknown = JSON.parse(raw);
  if (!Value.Check(HistoricalArtifactManifestSchema, manifest)) throw new Error('Sealed final manifest failed schema validation.');
  const realRoot = await realpath(root);
  const links: ComparisonLinkRecord[] = [];
  const unavailable: string[] = [];
  const preferred = new Set(preferredPaths.map(path => path.replaceAll('\\', '/').toLowerCase()));
  const artifacts = [...manifest.artifacts].sort((a, b) => Number(preferred.has(b.logicalPath.toLowerCase())) - Number(preferred.has(a.logicalPath.toLowerCase())));
  for (const artifact of artifacts) {
    assertSafeLogicalPath(artifact.logicalPath);
    const path = join(root, ...artifact.logicalPath.split('/'));
    const actual = await realpath(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (actual === undefined) {
      unavailable.push(`finals/${artifact.logicalPath}: unavailable (missing sealed file); expected hash=${artifact.contentHash}; sources=${artifact.sourceRefs.join(', ')}`);
      continue;
    }
    if (!pathContainedBy(realRoot, actual)) throw new Error('Sealed final resolves outside its attempt mount.');
    const info = await stat(actual);
    if (!info.isFile() || info.size !== artifact.byteLength || await sha256File(actual) !== artifact.contentHash) throw new Error(`Sealed final identity mismatch: ${artifact.logicalPath}`);
    const inspectPath = `finals/${artifact.logicalPath}`;
    const mediaType = artifact.mediaType ?? mediaTypeForComparisonPath(artifact.logicalPath);
    links.push({ side: 'baseline', inspectPath, reportHref: inspectPath.split('/').map(encodeURIComponent).join('/'),
      artifactId: artifact.artifactId, evidenceRef: `artifact:${artifact.artifactId}`, label: artifact.origin === 'user_selected_substitute'
        ? 'User-selected substitute baseline; NOT the original historical delivery' : `Sealed delivery (${artifact.origin}); finality from manifest`,
      contentHash: artifact.contentHash, byteLength: artifact.byteLength, sourceRefs: [...artifact.sourceRefs], origin: artifact.origin,
      ...(mediaType ? { mediaType } : {}) });
  }
  return { links, unavailable };
}
